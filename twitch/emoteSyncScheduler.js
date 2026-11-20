// Emote re-sync scheduling: once per process start (index.js) plus, while a channel's stream is
// live, on the stream-start transition and every RESYNC_INTERVAL_MS after - capped at
// MAX_SYNCS_PER_WINDOW per rolling CAP_WINDOW_MS. New 7TV emotes added mid-stream used to sit
// uncounted (and polluting the word cloud as ordinary "words") until the next bot restart or a
// manual !update7tv; this closes that gap without hammering the 7TV API.
//
// Ticks come from ActivitiTracker's existing 5-minute live poll (maybeSyncOnLiveTick) rather
// than a timer of our own - the tracker already owns offline->live transition detection and
// already treats a failed status check as "unknown, skip", so it never calls us on those.
//
// State is in-memory per channel (bare login, no '#'). A bot restart resets the cap window -
// accepted: worst case is one extra sync right after a restart. The manual !update7tv command
// does NOT go through here and neither consumes nor defers the scheduled cap; it has its own
// per-channel cooldown.
const { syncChannelEmoteSet, syncGlobalEmoteSet } = require('../sevenTv/SevenTvEmotes.js');
const { syncBttvEmotes } = require('../bttv/BttvEmotes.js');
const { syncFfzEmotes } = require('../ffz/FfzEmotes.js');
const { syncGlobalEmotes } = require('./globalEmotes.js');
const { syncChannelEmotes } = require('./channelEmotes.js');
const ChatStats = require('../db/chatStats.js');

const RESYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SYNCS_PER_WINDOW = 3;
// A failed sync used to leave lastSyncAt untouched and consume no cap slot, so it was "due" again on
// the very next 5-minute tick: one 7TV outage on 2026-11-20 produced 66 identical red lines in a
// row. After a failure the next attempt waits FAILURE_RETRY_MS, doubling per consecutive failure
// up to the regular interval; a success resets it. A failure is per provider, not per channel, but
// the doubling is capped at the normal cadence, so an outage can never leave a channel later than
// it would have been anyway.
const FAILURE_RETRY_MS = 15 * 60 * 1000;

// login -> { lastSyncAt, syncTimestamps: number[], inFlight: boolean, failures, retryAt }
const channelState = new Map();

function getState(login) {
  if (!channelState.has(login)) {
    channelState.set(login, { lastSyncAt: 0, syncTimestamps: [], inFlight: false, failures: 0, retryAt: 0 });
  }
  return channelState.get(login);
}

// Names the step that failed: "timeout of 15000ms exceeded" alone does not say which of six
// providers was down.
async function step(name, fn) {
  try {
    return await fn();
  } catch (err) {
    err.message = `${name}: ${err.message}`;
    throw err;
  }
}

// The canonical sync chain (hoisted from index.js's startup loop). Order is least-specific to
// most: Twitch's globals, the broadcaster's own Twitch emotes, then the three browser-extension
// providers - 7TV's global set, BTTV, FFZ - and the channel's OWN 7TV set last. The whitelist's
// unique key is {channel, word}, so on a name collision the later sync owns the row, and the
// channel's own curated set is the most meaningful attribution.
//
// Every provider here draws its emotes client-side, so to the bot they are ordinary words until
// they are whitelisted - which is what the three extension syncs are for. Only Twitch's own
// emotes can also arrive identified in the message itself, through the `emotes` tag, and those
// are learnt per message instead (db/chatStats.js's learnExternalEmotes) because they belong to
// channels nobody here can enumerate.
//
// The prune only runs when ALL the syncs succeeded (a failed fetch rejects before it), so a
// transient API outage can never make it mistake still-tracked emotes for orphans. That is also
// why a channel with no BTTV/FFZ account must read as an empty list rather than an error: those
// modules turn a 404 into [], and anything else throws. Rejects on failure - callers decide
// whether that's fatal.
async function syncNow(channelLogin) {
  const state = getState(channelLogin);
  // Owned here (not in maybeSyncOnLiveTick) so the startup call marks itself in-flight too -
  // a stream already live at bot start would otherwise let the tracker's first tick fire a
  // second sync in parallel with the startup one (lastSyncAt is still 0 at that point).
  state.inFlight = true;
  try {
    const channel = `#${channelLogin}`;
    // Each provider runs even when an earlier one failed: the chain used to stop at the first
    // error, so a slow FFZ also kept the channel's own 7TV set (synced after it) from updating.
    // The prune still needs every one of them, and the first error is what the caller sees.
    const failures = [];
    for (const [name, fn] of [
      ['Twitch global', syncGlobalEmotes],
      ['Twitch channel', syncChannelEmotes],
      ['7TV global', syncGlobalEmoteSet],
      ['BTTV', syncBttvEmotes],
      ['FFZ', syncFfzEmotes],
      ['7TV channel', syncChannelEmoteSet],
    ]) {
      await step(name, () => fn(channel)).catch((err) => failures.push(err));
    }
    if (failures.length) {
      if (failures.length > 1) failures[0].message += ` (+${failures.length - 1} more)`;
      throw failures[0];
    }
    await step('prune', () => ChatStats.pruneUntrackedEmoteStats(channel));
    const now = Date.now();
    state.lastSyncAt = now;
    state.syncTimestamps.push(now);
    state.failures = 0;
    state.retryAt = 0;
  } catch (err) {
    state.failures += 1;
    state.retryAt = Date.now() + Math.min(FAILURE_RETRY_MS * 2 ** (state.failures - 1), RESYNC_INTERVAL_MS);
    throw err;
  } finally {
    state.inFlight = false;
  }
}

// Called by ActivitiTracker on every tick where the stream is confirmed live. Fire-and-forget:
// must never block or fail the tracker's own activity accounting.
function maybeSyncOnLiveTick(channelLogin, justWentLive) {
  const state = getState(channelLogin);
  if (state.inFlight) return;

  const now = Date.now();
  // A recent failure holds off even a stream start: the provider that just failed is still the
  // likeliest to fail again.
  if (now < state.retryAt) return;
  const due = justWentLive || state.failures > 0 || now - state.lastSyncAt >= RESYNC_INTERVAL_MS;
  if (!due) return;

  state.syncTimestamps = state.syncTimestamps.filter(ts => now - ts < CAP_WINDOW_MS);
  if (state.syncTimestamps.length >= MAX_SYNCS_PER_WINDOW) {
    console.log(`[Emotes] [${channelLogin}] Scheduled re-sync skipped: ${MAX_SYNCS_PER_WINDOW} syncs in the last 24h`);
    return;
  }

  // syncNow marks itself in-flight, so a 7TV/Helix round-trip slower than the 5-minute poll
  // can't be double-fired by the next tick (guarded at the top of this function).
  console.log(`[Emotes] [${channelLogin}] Scheduled re-sync (${justWentLive ? 'stream start' : 'live interval'})`);
  syncNow(channelLogin)
    .catch(err => console.error(
      `[Emotes] Scheduled re-sync failed for #${channelLogin} (attempt ${state.failures},` +
      ` next in ${Math.round((state.retryAt - Date.now()) / 60000)}m):`, err.message));
}

module.exports = { syncNow, maybeSyncOnLiveTick, RESYNC_INTERVAL_MS, CAP_WINDOW_MS, MAX_SYNCS_PER_WINDOW, FAILURE_RETRY_MS };
