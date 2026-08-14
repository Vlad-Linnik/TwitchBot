// Background poller behind TwitchBot-Web's "Бюро разбанов" page (/:channel/unban-bureau).
//
// The ONLY thing that ever calls Twitch's unban-request endpoints. TwitchBot-Web has no Twitch
// moderation credentials of its own (its Twitch app requests only moderation:read), so its review
// page can only write `resolution.status: 'pending'` (a moderator stamped a case) or
// `vote.status: 'requested'` (asking chat) into the shared UnbanRequests collection - this poller
// applies the real Helix PATCH and promotes those. Exactly the contract twitch/longBanScheduler.js
// already implements for LongBans, and this file is deliberately shaped like it.
//
// It also MIRRORS Twitch's pending queue into Mongo, which longBanScheduler has no equivalent of.
// That's so the review page can render a case (and its dossier) from Mongo alone: two dossier
// facts - the account's creation date and when the user started following - need scopes only this
// bot's token holds, so the web app could not fetch them itself even if it wanted to.
const unbanRequestsAPI = require('./unbanRequestsAPI.js');
const gqlClient = require('./gqlClient.js');
const viewerCardModLogs = require('./viewerCardModLogs.js');
const unbanRequestsRepo = require('../db/unbanRequestsRepo.js');
const sniperShotsRepo = require('../db/sniperShotsRepo.js');
const unbanVote = require('../games/unbanVote.js');
const userLookup = require('./userLookup.js');
const chatStats = require('../db/chatStats.js');
const moderators = require('./moderators.js');
const TwitchBanAPI = require('./TwitchBanAPI.js');
const knownBots = require('../config/knownBots.js');
const botInitInfo = require('../botInitInfo.js');
const channelSettings = require('../config/channelSettings.js');
const describeError = require('../shared/describeError.js');
const healthTracker = require('../shared/healthTracker.js');

// One health entry covering the queue mirror across every bureau channel (see tick()).
const MIRROR_HEALTH_KEY = 'unban-mirror';
const MIRROR_HEALTH_LABEL = '[UnbanRequests] Queue mirror';

// Slower than longBanScheduler's 30s: unlike a long-ban renewal, nothing here is time-critical
// against Twitch (an appeal that sits one extra minute costs nothing), and unlike that poller this
// one spends a Helix call PER CHANNEL on every tick rather than only when something is due.
const POLL_INTERVAL_MS = 60 * 1000;
// Two missed mirror ticks plus slack before a failure counts as an outage rather than a blip.
const MIRROR_HEALTH_GRACE_MS = POLL_INTERVAL_MS * 2 + 30 * 1000;
// The fast poll - see fastTick() for what belongs on it and why it's 30x faster than the main one.
const SNIPER_POLL_MS = 2000;
// Hard bounds on the sniper's timeout: a stray ChannelConfig value must not turn a joke mechanic
// into a 2-week silencing. The ceiling is one hour deliberately - anything longer isn't a game
// any more, and a moderator who wants that has !longban.
const MIN_SNIPER_SEC = 1;
const MAX_SNIPER_SEC = 3600;
// The sniper's target pool is whoever actually sent a chat message in this window, not Twitch's
// Get Chatters list - that list includes silent lurkers with the chat window merely open, which
// is how the sniper could previously pick someone who hadn't typed in days.
const SNIPER_ACTIVITY_WINDOW_MS = 2 * 60 * 1000;
// How long a mirrored viewer card stays fresh.
//
// Raised from 5 minutes to 30 on 2026-08-14, deliberately trading freshness for call volume. The
// old figure meant every case sitting in a queue cost 12 GraphQL calls an hour FOREVER - an appeal
// nobody has got to in three days had spent ~860 of them, on an undocumented endpoint that is
// rate-limited and integrity-gated, to re-read counts that had not moved. The only genuinely
// mutable fact here is a moderator adding a comment mid-review, and 30 minutes is still well
// inside the tempo of a queue reviewed by hand.
//
// Note the FIRST fetch is unaffected: a freshly mirrored case has no `twitchModLogs` at all, so it
// is picked up on the very next tick and the dossier is ready before anyone opens it.
const VIEWER_CARD_TTL_MS = 30 * 60 * 1000;
// Ceiling on viewer-card fetches per channel per tick. A backlog (or a queue that just came back
// after the breaker re-opened) would otherwise fire one request per pending case in a tight loop,
// which is the burst pattern most likely to be read as automation at the other end. At one tick a
// minute this still drains a 30-case backlog in ten minutes.
const MAX_VIEWER_CARDS_PER_TICK = 3;
// Per-case backoff after a failed card fetch, doubling per consecutive failure up to the cap. The
// first step is deliberately longer than the poll interval - retrying a specific case faster than
// that is what the old code did, and it never once helped.
const VIEWER_CARD_RETRY_BASE_MS = 5 * 60 * 1000;
const VIEWER_CARD_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

let interval;
let sniperInterval;

function channelsWithBureauEnabled() {
  return Object.keys(botInitInfo.channels).filter(
    login => channelSettings.getSettings(login).unbanBureau?.enabled
  );
}

// ---------------------------------------------------------------------------
// 1. Mirroring
// ---------------------------------------------------------------------------

async function mirrorChannel(login) {
  const channelId = String(botInitInfo.channels[login].id);
  const requests = await unbanRequestsAPI.getUnbanRequests(channelId, 'pending');

  for (const request of requests) {
    await unbanRequestsRepo.upsertFromTwitch({
      channelId,
      channelLogin: login,
      requestId: request.id,
      userId: request.user_id,
      userLogin: request.user_login,
      userDisplayName: request.user_name,
      text: request.text || '',
      requestedAt: new Date(request.created_at),
      twitchStatus: 'pending',
    });
  }

  // Anything we still hold as pending that Twitch no longer lists was resolved elsewhere (almost
  // always in Twitch's own mod view). Safe to do unconditionally because getUnbanRequests THROWS
  // on failure rather than returning [] - an API outage aborts mirrorChannel before reaching here,
  // instead of looking like "the queue is empty now" and retiring every live case.
  await unbanRequestsRepo.markMissingAsResolvedElsewhere(channelId, requests.map(r => r.id));

  await enrichChannel(login, channelId);
  await refreshViewerCards(channelId);
}

// Fills in the Twitch-sourced dossier facts once per request. Kept separate from the mirroring
// upsert so a failing Get Users / Get Channel Followers call costs the request only its enrichment
// - it still appears for review, just with those two lines blank.
async function enrichChannel(login, channelId) {
  const pending = await unbanRequestsRepo.findUnenriched(channelId);
  if (!pending.length) return;

  const users = await userLookup.getUsersById(pending.map(doc => doc.userId));
  const byId = new Map(users.map(user => [user.id, user]));

  for (const doc of pending) {
    const user = byId.get(String(doc.userId));
    // Sequential, one user at a time: same deliberate no-concurrency choice as
    // longBanScheduler.tick(), to keep this poller's Helix footprint predictable.
    const followedAt = await unbanRequestsAPI.getFollowedAt(channelId, doc.userId);
    await unbanRequestsRepo.updateById(doc._id, {
      accountCreatedAt: user?.created_at ? new Date(user.created_at) : null,
      avatarUrl: user?.profile_image_url || null,
      followedAt,
      enrichedAt: new Date(),
    });
  }
}

// Mirrors Twitch's own viewer-card facts onto each open case: the moderator comments left on the
// user, and this channel's REAL lifetime ban/timeout/warning counts for them.
//
// These come from Twitch's private GraphQL (twitch/gqlClient.js), which is why they are the bot's
// job like everything else Twitch-facing. Two reasons this is a separate pass from enrichChannel:
// the facts are MUTABLE (a moderator can comment on a case that is open on someone's screen right
// now, hence the refetch on a TTL rather than once), and a GraphQL outage must not stop the Helix
// enrichment or vice versa.
//
// Entirely optional: without a configured token gqlClient is disabled, getViewerCard returns null,
// nothing is written, and the review page falls back to the bot's own ModeratorActionLogs counts.
async function refreshViewerCards(channelId) {
  // The breaker's whole point: when Twitch is refusing these outright there is nothing to gain
  // from finding out again once a minute per case.
  if (!gqlClient.isEnabled()) return;

  const staleBefore = new Date(Date.now() - VIEWER_CARD_TTL_MS);
  const cases = await unbanRequestsRepo.findStaleViewerCards(channelId, staleBefore);

  for (const doc of cases.slice(0, MAX_VIEWER_CARDS_PER_TICK)) {
    // Sequential, one case at a time - same deliberate no-concurrency choice as enrichChannel()
    // and longBanScheduler.tick(), to keep this poller's outbound footprint predictable.
    const card = await viewerCardModLogs.getViewerCard(channelId, doc.userId);

    if (!card) {
      // A failed lookup leaves the previous card in place rather than blanking it: stale counts
      // beat no counts on a page a moderator is judging an appeal from. What it must NOT do is
      // leave the doc eligible again immediately - see findStaleViewerCards()'s note.
      //
      // But TWO very different failures land here and only one of them is this case's fault.
      //
      // A GLOBAL failure - the endpoint refusing everything, an outage, a dead token - is already
      // answered by gqlClient's breaker, which stops the calls outright. Parking the case on top of
      // that punishes it for something it had no part in, and the punishment badly outlives the
      // cause: through the 2026-08-14 integrity refusal every open case doubled its way to the
      // 6-hour cap, so when the gated field was found and dropped on 2026-08-15 the queue went on
      // showing no Twitch data for hours with nothing visibly wrong and nothing in the log. The
      // rest of the backlog isn't worth walking either, which is what this return used to be for.
      //
      // A PER-CASE failure - the query answered fine but `viewerCardModLogs` came back null for
      // this one user - is what the backoff was written for, and still parks.
      //
      // The two are distinguishable without widening getViewerCard()'s contract: gqlClient counts
      // every global failure and zeroes that counter the moment a call returns data, so a non-zero
      // count here means this request never got an answer at all.
      if (gqlClient.getStatus().consecutiveFailures > 0) return;

      const attempts = (doc.viewerCardAttempts || 0) + 1;
      const backoff = Math.min(VIEWER_CARD_RETRY_MAX_MS, VIEWER_CARD_RETRY_BASE_MS * 2 ** (attempts - 1));
      await unbanRequestsRepo.updateById(doc._id, {
        viewerCardAttempts: attempts,
        viewerCardRetryAfter: new Date(Date.now() + backoff),
      });
      continue;
    }

    await unbanRequestsRepo.updateById(doc._id, {
      twitchModLogs: { ...card, fetchedAt: new Date() },
      viewerCardAttempts: 0,
      viewerCardRetryAfter: null,
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Applying decisions
// ---------------------------------------------------------------------------

async function processDecision(doc) {
  const applied = await unbanRequestsAPI.resolveUnbanRequest(
    doc.channelId,
    doc.requestId,
    doc.resolution.decision, // 'approved' | 'denied' - Twitch's own vocabulary
    doc.resolution.text
  );

  if (!applied) {
    // Unlike longBanScheduler's unban (which leaves the doc untouched so the next tick retries
    // forever), a rejected resolve is usually permanent - the request was already resolved, or
    // cancelled by its author. Retrying every minute would just re-log the same 400. So it's
    // parked in 'failed' and the review page offers the moderator an explicit retry.
    await unbanRequestsRepo.updateById(doc._id, {
      'resolution.status': 'failed',
      'resolution.failureReason': 'Twitch отклонил решение — возможно, заявка уже закрыта',
    });
    return;
  }

  await unbanRequestsRepo.updateById(doc._id, {
    'resolution.status': 'done',
    'resolution.appliedAt': new Date(),
    twitchStatus: doc.resolution.decision, // 'approved' | 'denied'
  });
}

// ---------------------------------------------------------------------------
// 3 & 4. Chat votes
// ---------------------------------------------------------------------------

async function processVoteRequest(doc) {
  const channel = `#${doc.channelLogin}`;
  const settings = channelSettings.getSettings(doc.channelLogin).unbanBureau || {};
  const approveEmote = settings.voteApproveEmote || 'VoteYea';
  const denyEmote = settings.voteDenyEmote || 'VoteNay';
  // One vote at a time per channel - chat can only meaningfully answer one question at once. The
  // running one is CLOSED rather than this one being deferred: the vote follows whichever appeal
  // the moderator is actually reviewing, so a stale vote on a case they've moved past is worse
  // than no vote at all.
  if (unbanVote.hasActiveVote(channel)) {
    const running = await unbanRequestsRepo.findActiveVoteInChannel(doc.channelId);
    if (running && String(running._id) !== String(doc._id)) await processVoteClosure(running);
    else if (running) return; // already voting on this very appeal
  }


  // Emotes are persisted on the doc, not just read from config, so a settings edit mid-vote can't
  // change what counts as a vote halfway through - chat was told these two.
  await unbanRequestsRepo.updateById(doc._id, {
    'vote.status': 'active',
    'vote.startedAt': new Date(),
    // No end time: a vote lasts exactly as long as the appeal is at the window. It ends when the
    // moderator stamps a verdict, or when the next appeal supersedes it - never on a clock. A
    // 60s cap used to live here and closed votes out from under moderators who were still reading.
    'vote.endsAt': null,
    'vote.approveEmote': approveEmote,
    'vote.denyEmote': denyEmote,
    'vote.approve': 0,
    'vote.deny': 0,
  });

  unbanVote.startVote(channel, {
    docId: doc._id,
    requestId: doc.requestId,
    userLogin: doc.userLogin,
    endsAt: null,
    approveEmote,
    denyEmote,
  });
}

// ---------------------------------------------------------------------------
// 5. The sniper
// ---------------------------------------------------------------------------

// Narrows recent chatters down to who the sniper is allowed to hit at all. Excluded, in order:
// the bot itself, the broadcaster, everyone in the channel's moderator cache, and every account in
// config/knownBots.js. Doesn't touch ban status - that check needs a Helix round trip, done
// separately in fireSniper() so this stays a plain sync filter.
//
// The exclusions aren't politeness: sniping a moderator or the broadcaster would have the bot
// remove the people who can undo it (and, for a `ban`, remove the moderator who was mid-review),
// and every other stats/activity path in this codebase already treats known bots as non-people.
function pickEligibleChatters(chatters, broadcasterId) {
  const modIds = moderators.getModerators(broadcasterId);
  const botId = String(botInitInfo.settings['bot_id']);

  return chatters.filter(chatter => {
    const id = String(chatter.user_id);
    if (id === botId || id === String(broadcasterId)) return false;
    if (modIds.has(id)) return false;
    if (knownBots.isKnownBot(id)) return false;
    return true;
  });
}

// Fires one shot that a moderator requested from the review desk's rifle scope. The web app only
// ever writes the REQUEST (db/sniperShotsRepo.js) - picking who actually gets hit happens here,
// server-side, so the page can never nominate a victim.
//
// There is no per-channel toggle in front of this, and deliberately so: the bot never shoots on its
// own, so the only way to get here is a moderator pulling the trigger at the desk - which is already
// the decision a toggle would have been asking about. (One existed until 2026-08-08, left from an
// earlier version that fired automatically every time a chat vote closed. That automatic path is
// gone; the toggle survived only as a switch that made the rifle silently do nothing.)
//
// Returns the outcome record, or null if the shot was skipped (nobody eligible in chat). Never
// throws: a failed shot is a missed shot, not an error worth stopping the poll for.
async function fireSniper(channelLogin, settings) {
  const channel = `#${channelLogin}`;
  const broadcasterId = String(botInitInfo.channels[channelLogin]?.id || '');
  if (!broadcasterId) return null;

  const since = new Date(Date.now() - SNIPER_ACTIVITY_WINDOW_MS);
  const recentChatters = await chatStats.getRecentChatters(channel, since);
  const eligible = pickEligibleChatters(recentChatters, broadcasterId);
  if (!eligible.length) {
    console.log(`[UnbanRequests] Sniper found no eligible target in ${channel}`);
    return null;
  }

  // Don't "shoot" someone who is already gone. This reads our own ModeratorActionLogs rather than
  // Helix: EventSub's channel.moderate reports bans/timeouts issued by human moderators through
  // Twitch's native UI too, and Helix's Get Banned Users is unusable from a moderator token (see
  // twitch/TwitchBanAPI.js's note - it answered 401 on every call). The same `since` as the
  // candidate pool is the whole window that can matter: everyone here posted a message inside it.
  const alreadyBanned = await chatStats.getPunishedUserIds(
    channelLogin,
    eligible.map(chatter => chatter.user_id),
    since
  );
  const candidates = eligible.filter(chatter => !alreadyBanned.has(String(chatter.user_id)));
  if (!candidates.length) {
    console.log(`[UnbanRequests] Sniper found no eligible target in ${channel}`);
    return null;
  }

  const target = candidates[Math.floor(Math.random() * candidates.length)];

  const mode = settings.sniperMode === 'ban' ? 'ban' : 'timeout';
  const durationSec =
    mode === 'ban'
      ? null
      : Math.min(MAX_SNIPER_SEC, Math.max(MIN_SNIPER_SEC, Number(settings.sniperTimeoutSec) || 60));
  const reason = settings.sniperReason || 'Шальная пуля Бюро амнистии';

  // TwitchBanAPI now RETURNS whether Twitch accepted the action (it logged nothing and swallowed
  // everything until 2026-08-14, so this said `success: true` for a shot that never landed - which
  // is what "выстрел не всегда банит" turned out to be reporting). It still doesn't throw, so the
  // catch stays for anything more unusual than a rejected request.
  let success = false;
  try {
    success = mode === 'ban'
      ? await TwitchBanAPI.ban(target.user_id, broadcasterId, reason)
      : await TwitchBanAPI.timeout(target.user_id, durationSec, broadcasterId, reason);
  } catch (error) {
    console.error(`[UnbanRequests] Sniper ${mode} failed in ${channel}:`, describeError(error));
  }

  if (!success) {
    // TwitchBanAPI has already logged the reason Twitch gave; this line is what ties it to a shot.
    console.error(
      `[UnbanRequests] Sniper ${mode} in ${channel} was rejected by Twitch ` +
      `(target @${target.user_login}) - the shot is recorded as a miss.`
    );
  }

  return {
    fired: true,
    targetUserId: String(target.user_id),
    targetLogin: target.user_login,
    mode,
    durationSec,
    firedAt: new Date(),
    success,
  };
}

async function processVoteClosure(doc) {
  const channel = `#${doc.channelLogin}`;
  const final = unbanVote.closeVote(channel, doc._id);
  // Null when the bot restarted mid-vote (the in-memory tally is gone), or when the vote currently
  // in memory for this channel belongs to a DIFFERENT request - see closeVote()'s own note. Either
  // way the persisted counters, flushed every few seconds by games/unbanVote.js, are the best
  // record left.
  const approve = final ? final.approve : doc.vote.approve || 0;
  const deny = final ? final.deny : doc.vote.deny || 0;

  await unbanRequestsRepo.updateById(doc._id, {
    'vote.status': 'closed',
    'vote.approve': approve,
    'vote.deny': deny,
  });
}

// ---------------------------------------------------------------------------
// 5. Votes on the fast path
// ---------------------------------------------------------------------------

// Vote start/stop moved off tick()'s 60s cadence onto the 2s one, because both ends are now driven
// by a human at the desk rather than by a timer: the vote opens when an appeal reaches the window
// and closes the moment a verdict is stamped. A minute of lag on either would make chat vote on
// the wrong case.
async function processVotes() {
  const [requests, closeRequests] = await Promise.all([
    unbanRequestsRepo.findVoteRequested(),
    unbanRequestsRepo.findVoteCloseRequested(),
  ]);

  // Closures first: a request that has to evict a running vote does it itself, but doing the
  // explicit closes first keeps the common case (verdict on A, then A+1 opens) in the right order.
  for (const doc of closeRequests) {
    await processVoteClosure(doc).catch(err =>
      console.error(`[UnbanRequests] Failed to close vote in #${doc.channelLogin}:`, describeError(err))
    );
  }
  for (const doc of requests) {
    await processVoteRequest(doc).catch(err =>
      console.error(`[UnbanRequests] Failed to start vote in #${doc.channelLogin}:`, describeError(err))
    );
  }
}

// ---------------------------------------------------------------------------
// 6. The fast poll
// ---------------------------------------------------------------------------

// Everything a human at the desk is actively waiting on: a shot they just fired through the scope,
// and the vote that has to follow the appeal in front of them. tick()'s 60s cadence is for the
// background reconciliation nobody is watching (mirroring, enrichment, applying verdicts to Twitch).
async function fastTick() {
  await processVotes().catch(err =>
    console.error('[UnbanRequests] Vote processing failed:', describeError(err))
  );
  await fireQueuedShots();
}

async function fireQueuedShots() {
  const shots = await sniperShotsRepo.findPending();
  for (const shot of shots) {
    // Claim first: without it a slow Helix call would let the next 2s tick fire the same shot again.
    if (!(await sniperShotsRepo.claim(shot._id))) continue;

    const settings = channelSettings.getSettings(shot.channelLogin).unbanBureau || {};
    const outcome = await fireSniper(shot.channelLogin, settings).catch(err => {
      console.error(`[UnbanRequests] Sniper failed in #${shot.channelLogin}:`, describeError(err));
      return null;
    });

    // Three distinguishable outcomes, and the review desk needs all three: a hit, a shot with
    // nobody eligible to hit, and a target Twitch then refused to act on. The last two were
    // indistinguishable (and the third was reported as a hit) until 2026-08-14.
    await sniperShotsRepo.complete(shot._id, outcome
      ? {
        status: outcome.success ? 'done' : 'failed',
        ...outcome,
        failureReason: outcome.success ? null : 'twitch_rejected',
      }
      : { status: 'failed', failureReason: 'no_target' });
  }
}

// A vote marked active in Mongo but absent from memory means the bot restarted mid-vote. Rebuild
// the in-memory window so the remaining seconds still collect votes.
async function resumeInterruptedVotes() {
  const docs = await unbanRequestsRepo.findActiveVotes();
  for (const doc of docs) {
    const channel = `#${doc.channelLogin}`;
    if (unbanVote.hasActiveVote(channel)) continue;
    unbanVote.resumeVote(channel, doc);
  }
}

// ---------------------------------------------------------------------------

async function tick() {
  const channels = channelsWithBureauEnabled();
  for (const login of channels) {
    await mirrorChannel(login).then(
      // Mirroring is a poll like the stream-status one, and fails the same way for the same
      // reason: the network, all channels at once. Held for a couple of missed ticks before it
      // counts as an outage, and closed out with a recovery line - see shared/healthTracker.js.
      () => healthTracker.reportSuccess(MIRROR_HEALTH_KEY, { label: MIRROR_HEALTH_LABEL, scope: `#${login}` }),
      err => healthTracker.reportFailure(MIRROR_HEALTH_KEY, {
        label: MIRROR_HEALTH_LABEL,
        detail: describeError(err),
        scope: `#${login}`,
        graceMs: MIRROR_HEALTH_GRACE_MS,
      })
    );
  }

  await resumeInterruptedVotes().catch(err =>
    console.error('[UnbanRequests] Resuming interrupted votes failed:', describeError(err))
  );

  // Votes are NOT handled here any more - they run on fastTick()'s 2s cadence (see processVotes).
  // Only decisions actually due - see findResolutionPending()'s own note on resolution.effectiveAt.
  const decisions = await unbanRequestsRepo.findResolutionPending(new Date());

  for (const doc of decisions) {
    await processDecision(doc).catch(err =>
      console.error(
        `[UnbanRequests] Failed to apply ${doc.resolution?.decision} for ${doc.userLogin} in #${doc.channelLogin}:`,
        describeError(err)
      )
    );
  }
}

// Called once from index.js. The `botClient` argument is accepted and ignored: this feature is
// deliberately SILENT in chat (no vote prompt, no tally, no sniper announcement) - it's an
// on-stream game, chat sees the desk on the broadcast, and a bot narrating it is just noise.
// Kept in the signature so index.js's call site matches the other schedulers'.
function start(botClient) {
  if (interval) return;
  interval = setInterval(() => {
    tick().catch(err => console.error('[UnbanRequests] Scheduler tick failed:', describeError(err)));
  }, POLL_INTERVAL_MS);
  interval.unref?.();

  sniperInterval = setInterval(() => {
    fastTick().catch(err => console.error('[UnbanRequests] Fast tick failed:', describeError(err)));
  }, SNIPER_POLL_MS);
  sniperInterval.unref?.();
}

module.exports = {
  start,
  tick,
  // Exported for test/unbanSniper_test.js - it's the one piece of sniper logic that's pure enough
  // to check without a live Twitch connection.
  pickEligibleChatters,
  fastTick,
  // Exported so scripts/local/probeModComments.js can drive the real mirroring path against one
  // channel instead of a hand-copied version of it.
  refreshViewerCards,
  POLL_INTERVAL_MS,
  SNIPER_POLL_MS,
  MIN_SNIPER_SEC,
  MAX_SNIPER_SEC,
};
