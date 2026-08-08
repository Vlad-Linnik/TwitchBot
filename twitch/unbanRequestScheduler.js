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
const chattersAPI = require('./chattersAPI.js');
const moderators = require('./moderators.js');
const TwitchBanAPI = require('./TwitchBanAPI.js');
const knownBots = require('../config/knownBots.js');
const botInitInfo = require('../botInitInfo.js');
const channelSettings = require('../config/channelSettings.js');
const describeError = require('../shared/describeError.js');

// Slower than longBanScheduler's 30s: unlike a long-ban renewal, nothing here is time-critical
// against Twitch (an appeal that sits one extra minute costs nothing), and unlike that poller this
// one spends a Helix call PER CHANNEL on every tick rather than only when something is due.
const POLL_INTERVAL_MS = 60 * 1000;
// The fast poll - see fastTick() for what belongs on it and why it's 30x faster than the main one.
const SNIPER_POLL_MS = 2000;
// Hard bounds on the sniper's timeout: a stray ChannelConfig value must not turn a joke mechanic
// into a 2-week silencing. The ceiling is one hour deliberately - anything longer isn't a game
// any more, and a moderator who wants that has !longban.
const MIN_SNIPER_SEC = 1;
const MAX_SNIPER_SEC = 3600;
// How long a mirrored viewer card stays fresh. Longer than the poll interval on purpose: the
// counts barely move, and the one thing that does - a moderator adding a comment - reaching the
// page within five minutes is fine for a queue that is reviewed by hand.
const VIEWER_CARD_TTL_MS = 5 * 60 * 1000;

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
  if (!gqlClient.isEnabled()) return;

  const staleBefore = new Date(Date.now() - VIEWER_CARD_TTL_MS);
  const cases = await unbanRequestsRepo.findStaleViewerCards(channelId, staleBefore);

  for (const doc of cases) {
    // Sequential, one case at a time - same deliberate no-concurrency choice as enrichChannel()
    // and longBanScheduler.tick(), to keep this poller's outbound footprint predictable.
    const card = await viewerCardModLogs.getViewerCard(channelId, doc.userId);
    // A failed lookup leaves the previous card in place rather than blanking it: stale counts beat
    // no counts on a page a moderator is judging an appeal from.
    if (!card) continue;
    await unbanRequestsRepo.updateById(doc._id, {
      twitchModLogs: { ...card, fetchedAt: new Date() },
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

// Picks one chatter at random to take the shot. Excluded, in order: the bot itself, the
// broadcaster, everyone in the channel's moderator cache, and every account in
// config/knownBots.js. Returns null when nobody is left - a small or half-empty chat is a normal
// state, not an error, and the caller just skips the shot.
//
// The exclusions aren't politeness: sniping a moderator or the broadcaster would have the bot
// remove the people who can undo it (and, for a `ban`, remove the moderator who was mid-review),
// and every other stats/activity path in this codebase already treats known bots as non-people.
function pickSniperTarget(chatters, broadcasterId) {
  const modIds = moderators.getModerators(broadcasterId);
  const botId = String(botInitInfo.settings['bot_id']);

  const eligible = chatters.filter(chatter => {
    const id = String(chatter.user_id);
    if (id === botId || id === String(broadcasterId)) return false;
    if (modIds.has(id)) return false;
    if (knownBots.isKnownBot(id)) return false;
    return true;
  });

  if (!eligible.length) return null;
  return eligible[Math.floor(Math.random() * eligible.length)];
}

// Fires one shot that a moderator requested from the review desk's rifle scope. The web app only
// ever writes the REQUEST (db/sniperShotsRepo.js) - picking who actually gets hit happens here,
// server-side, so the page can never nominate a victim.
//
// Returns the outcome record, or null if the shot was skipped (feature off, or nobody eligible in
// chat). Never throws: a failed shot is a missed shot, not an error worth stopping the poll for.
async function fireSniper(channelLogin, settings) {
  if (!settings.sniperEnabled) return null;

  const channel = `#${channelLogin}`;
  const broadcasterId = String(botInitInfo.channels[channelLogin]?.id || '');
  if (!broadcasterId) return null;

  const chatters = await chattersAPI.getChatters(broadcasterId);
  const target = pickSniperTarget(chatters, broadcasterId);
  if (!target) {
    console.log(`[UnbanRequests] Sniper found no eligible target in ${channel}`);
    return null;
  }

  const mode = settings.sniperMode === 'ban' ? 'ban' : 'timeout';
  const durationSec =
    mode === 'ban'
      ? null
      : Math.min(MAX_SNIPER_SEC, Math.max(MIN_SNIPER_SEC, Number(settings.sniperTimeoutSec) || 60));
  const reason = settings.sniperReason || 'Шальная пуля Бюро амнистии';

  let success = true;
  try {
    if (mode === 'ban') {
      await TwitchBanAPI.ban(target.user_id, broadcasterId, reason);
    } else {
      await TwitchBanAPI.timeout(target.user_id, durationSec, broadcasterId, reason);
    }
  } catch (error) {
    // TwitchBanAPI.timeout/ban swallow their own errors, so this only catches something more
    // unusual - but the sub-document promises `success`, so it has to be honest about it.
    success = false;
    console.error(`[UnbanRequests] Sniper ${mode} failed in ${channel}:`, describeError(error));
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

    await sniperShotsRepo.complete(shot._id, outcome
      ? { status: outcome.success ? 'done' : 'failed', ...outcome }
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
    await mirrorChannel(login).catch(err =>
      console.error(`[UnbanRequests] Mirror failed for #${login}:`, describeError(err))
    );
  }

  await resumeInterruptedVotes().catch(err =>
    console.error('[UnbanRequests] Resuming interrupted votes failed:', describeError(err))
  );

  // Votes are NOT handled here any more - they run on fastTick()'s 2s cadence (see processVotes).
  const decisions = await unbanRequestsRepo.findResolutionPending();

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
  pickSniperTarget,
  fastTick,
  // Exported so scripts/local/probeModComments.js can drive the real mirroring path against one
  // channel instead of a hand-copied version of it.
  refreshViewerCards,
  POLL_INTERVAL_MS,
  SNIPER_POLL_MS,
  MIN_SNIPER_SEC,
  MAX_SNIPER_SEC,
};
