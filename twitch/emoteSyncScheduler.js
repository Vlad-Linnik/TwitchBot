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
const { syncChannelEmoteSet } = require('../sevenTv/SevenTvEmotes.js');
const { syncGlobalEmotes } = require('./globalEmotes.js');
const { syncChannelEmotes } = require('./channelEmotes.js');
const ChatStats = require('../db/chatStats.js');

const RESYNC_INTERVAL_MS = 4 * 60 * 60 * 1000;
const CAP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_SYNCS_PER_WINDOW = 3;

// login -> { lastSyncAt, syncTimestamps: number[], inFlight: boolean }
const channelState = new Map();

function getState(login) {
  if (!channelState.has(login)) {
    channelState.set(login, { lastSyncAt: 0, syncTimestamps: [], inFlight: false });
  }
  return channelState.get(login);
}

// The canonical sync chain (hoisted from index.js's startup loop). Twitch's global emotes
// FIRST, then the broadcaster's own Twitch emotes, then the channel's own 7TV set LAST: the
// whitelist's unique key is {channel, word}, so on a name collision the later sync owns the
// row, and a 7TV set - the most deliberately curated of the three - is the most meaningful
// attribution. The prune only runs when ALL THREE syncs succeeded (a failed fetch rejects
// before it), so a transient API outage can never make it mistake still-tracked emotes for
// orphans. Rejects on failure - callers decide whether that's fatal.
async function syncNow(channelLogin) {
  const state = getState(channelLogin);
  // Owned here (not in maybeSyncOnLiveTick) so the startup call marks itself in-flight too -
  // a stream already live at bot start would otherwise let the tracker's first tick fire a
  // second sync in parallel with the startup one (lastSyncAt is still 0 at that point).
  state.inFlight = true;
  try {
    const channel = `#${channelLogin}`;
    await syncGlobalEmotes(channel);
    await syncChannelEmotes(channel);
    await syncChannelEmoteSet(channel);
    await ChatStats.pruneUntrackedEmoteStats(channel);
    const now = Date.now();
    state.lastSyncAt = now;
    state.syncTimestamps.push(now);
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
  const due = justWentLive || now - state.lastSyncAt >= RESYNC_INTERVAL_MS;
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
    .catch(err => console.error(`[Emotes] Scheduled re-sync failed for #${channelLogin}:`, err.message));
}

module.exports = { syncNow, maybeSyncOnLiveTick, RESYNC_INTERVAL_MS, CAP_WINDOW_MS, MAX_SYNCS_PER_WINDOW };
