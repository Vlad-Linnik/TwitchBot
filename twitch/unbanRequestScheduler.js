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
//
// TWO CADENCES, because at one fixed rate this poll was answering a question nobody had asked. Every
// job on the fast lane is created by a moderator at the desk - a case opened, a vote started, a
// verdict stamped, a trigger pulled - so a tick that finds nothing has just proved there is nobody
// there. On an empty desk that was four Mongo round trips and a stat() of .env every two seconds,
// for ever, on a 2GB VPS.
//
// It costs about 1-2ms of CPU per idle tick measured locally, so this is not a fire; it is simply
// work with no reader. The idle rate is what a moderator waits for ONCE, on the first case they
// open after a quiet spell (the "Подготовка дела" cover on the desk is what they see meanwhile,
// and it waits 25s before giving up) - every case after that is answered at the active rate.
const FAST_POLL_ACTIVE_MS = 2000;
const FAST_POLL_IDLE_MS = 10 * 1000;
// How long the fast lane keeps the active rate after the last thing it actually did. Generous on
// purpose: a moderator reads an appeal for minutes between actions, and dropping to the idle rate
// mid-session would put a 10-second lag on their next verdict. Sitting at the active rate for five
// idle minutes costs ~0.3s of CPU - far cheaper than the alternative it buys.
const FAST_ACTIVE_LINGER_MS = 5 * 60 * 1000;
// Kept exported under its old name: it is what the tests and the docs call the fast poll.
const SNIPER_POLL_MS = FAST_POLL_ACTIVE_MS;
// Hard bounds on the sniper's timeout: a stray ChannelConfig value must not turn a joke mechanic
// into a 2-week silencing. The ceiling is one hour deliberately - anything longer isn't a game
// any more, and a moderator who wants that has !longban.
const MIN_SNIPER_SEC = 1;
const MAX_SNIPER_SEC = 3600;
// The sniper's target pool is whoever actually sent a chat message in this window, not Twitch's
// Get Chatters list - that list includes silent lurkers with the chat window merely open, which
// is how the sniper could previously pick someone who hadn't typed in days.
const SNIPER_ACTIVITY_WINDOW_MS = 2 * 60 * 1000;
// How much the draw leans on recency. Someone who spoke a moment ago is this many times likelier
// to be hit than someone whose only message sits at the far edge of the activity window; the odds
// fall off smoothly (exponentially) in between, so with the 2-minute window above the chance
// halves roughly every 30 seconds of silence.
//
// A flat draw over the window read as arbitrary at the desk: chat sees the shot land on someone
// whose message has already scrolled away, and the joke lands with it. Weighting keeps the pool
// intact - the edge of the window still has a real, just small, chance - while putting the shot
// where chat is actually looking. Nothing hard depends on the exact number.
const SNIPER_RECENCY_BIAS = 16;
// The grenade - the desk's second weapon. Instead of drawing one victim it takes everyone who
// spoke in the last half-minute, which is why its window is its own and much shorter than the
// rifle's: 30 seconds is about one exchange in a busy chat, so the blast reads as "whoever was
// talking just now" rather than "whoever was around".
//
// It must stay <= SNIPER_ACTIVITY_WINDOW_MS. The pool is built once per channel per tick at the
// rifle's window and the blast is a subset of it (see fireVolley); a longer window here would
// silently be truncated to the rifle's instead of reaching further back.
const GRENADE_BLAST_WINDOW_MS = 30 * 1000;
// Ceiling on how many people one grenade can take. An unbounded blast is not a joke mechanic: in a
// channel where fifty people speak every half-minute it is a mass ban issued by one click, and the
// moderator who threw it cannot undo fifty timeouts as fast as they made them. The freshest talkers
// are kept when the blast is oversubscribed, matching how the rifle already picks.
const GRENADE_MAX_TARGETS = 20;
// How long a mirrored viewer card stays fresh.
//
// Raised from 5 minutes to 30 on 2026-08-14, deliberately trading freshness for call volume. The
// old figure meant every case sitting in a queue cost 12 GraphQL calls an hour FOREVER - an appeal
// nobody has got to in three days had spent ~860 of them, on an undocumented endpoint that is
// rate-limited and integrity-gated, to re-read counts that had not moved. The only genuinely
// mutable fact here is a moderator adding a comment mid-review, and 30 minutes is still well
// inside the tempo of a queue reviewed by hand.
//
// Since 2026-08-15 this is a FRESHNESS check, not a schedule: nothing re-reads a card on a timer
// any more (see fetchRequestedViewerCards), so what it actually buys is that a moderator clicking
// back and forth between two appeals pays for each of them once, not once per click.
const VIEWER_CARD_TTL_MS = 30 * 60 * 1000;
// Ceiling on viewer-card fetches per fast tick, across all channels. The real bound is now how many
// cases moderators opened in the last two seconds, which is a very small number - this is the
// safety net for the burst that isn't, since firing one request per case in a tight loop is the
// pattern most likely to be read as automation at the other end.
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
  // Viewer cards are NOT fetched here any more - they moved onto fastTick()'s 2s cadence and are
  // driven by a moderator actually opening a case. See fetchRequestedViewerCards().
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

// Mirrors Twitch's own viewer-card facts onto the case a moderator has just OPENED: the comments
// left on the user, and this channel's REAL lifetime ban/timeout/warning counts for them.
//
// These come from Twitch's private GraphQL (twitch/gqlClient.js), which is why they are the bot's
// job like everything else Twitch-facing - TwitchBot-Web holds no Twitch credentials at all, so it
// can only write the request (`viewerCardRequestedAt`, set when it serves dossier.json) and wait.
// Same contract as a verdict or a vote.
//
// ON DEMAND SINCE 2026-08-15, AND THAT IS THE POINT. This used to be a background sweep over every
// pending case on a 30-minute TTL, which meant the bot mirrored the entire queue whether anyone
// opened it or not: an appeal nobody had reached in three days cost ~144 requests to an
// undocumented, rate-limited, integrity-gated endpoint where exactly one was needed. Now a quiet
// queue costs nothing at all, and a case costs one request the first time it is opened.
//
// It rides fastTick()'s 2s cadence rather than tick()'s 60s for the obvious reason: a moderator is
// sitting in front of the page waiting for it. 60 seconds is what made pre-fetching look necessary
// in the first place.
//
// Entirely optional: without a configured token gqlClient is disabled, getViewerCard returns null,
// nothing is written, and the review page falls back to the bot's own ModeratorActionLogs counts.
// Returns how many flagged cases it dealt with. Zero when the breaker is holding calls back, which
// is deliberate: rows we are not allowed to act on must not read as "somebody is at the desk", or a
// dead token would pin the fast lane at its active rate for as long as it stayed dead.
async function fetchRequestedViewerCards() {
  // Cheapest question first. The Mongo read is indexed and answers in well under a millisecond,
  // while isEnabled() stat()s .env - and on an empty desk (the overwhelmingly common case) that
  // syscall would be the only thing this function ever did.
  const cases = await unbanRequestsRepo.findViewerCardRequested();
  if (!cases.length) return 0;

  // The breaker's whole point: when Twitch is refusing these outright there is nothing to gain
  // from finding out again every two seconds. The flags stay up, so the cases are served as soon
  // as it lets go.
  if (!gqlClient.isEnabled()) return 0;

  const staleBefore = new Date(Date.now() - VIEWER_CARD_TTL_MS);
  let handled = 0;

  for (const doc of cases.slice(0, MAX_VIEWER_CARDS_PER_TICK)) {
    // Claim first, exactly like fireQueuedShots(): this runs every 2 seconds and a card fetch takes
    // most of that on a good day, so leaving the flag up would let the next tick start the same
    // request again. Clearing it also means a FAILED fetch does not re-arm itself - the moderator's
    // page asks again if it still wants the card, which is what "on demand" has to mean to be worth
    // anything.
    await unbanRequestsRepo.clearViewerCardRequest(doc._id);
    handled += 1;

    // The site sets the flag on every first dossier load because it does not know the TTL; most of
    // those are a case being reopened minutes later and need no call at all.
    const fetchedAt = doc.twitchModLogs?.fetchedAt;
    if (fetchedAt && new Date(fetchedAt) >= staleBefore) continue;

    // Sequential, one case at a time - same deliberate no-concurrency choice as enrichChannel()
    // and longBanScheduler.tick(), to keep this poller's outbound footprint predictable.
    const card = await viewerCardModLogs.getViewerCard(doc.channelId, doc.userId);

    if (!card) {
      // A failed lookup leaves the previous card in place rather than blanking it: stale counts
      // beat no counts on a page a moderator is judging an appeal from. What it must NOT do is
      // leave the doc eligible again immediately - see findViewerCardRequested()'s note.
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
      if (gqlClient.getStatus().consecutiveFailures > 0) return handled;

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

  return handled;
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
//
// Shots a moderator fired from the review desk's rifle scope. The web app only ever writes the
// REQUEST (db/sniperShotsRepo.js) - picking who actually gets hit happens here, server-side, so
// the page can never nominate a victim.
//
// There is no per-channel toggle in front of this, and deliberately so: the bot never shoots on its
// own, so the only way to get here is a moderator pulling the trigger at the desk - which is already
// the decision a toggle would have been asking about. (One existed until 2026-08-08, left from an
// earlier version that fired automatically every time a chat vote closed. That automatic path is
// gone; the toggle survived only as a switch that made the rifle silently do nothing.)

// Narrows recent chatters down to who the sniper is allowed to hit at all. Excluded, in order:
// the bot itself, the broadcaster, everyone in the channel's moderator cache, and every account in
// config/knownBots.js. Doesn't touch ban status - that check needs a Helix round trip, done
// separately in buildTargetPool() so this stays a plain sync filter.
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

// Draws one victim out of the eligible pool, biased towards whoever spoke most recently -
// see SNIPER_RECENCY_BIAS for why the draw isn't flat. Every candidate keeps a non-zero chance,
// and a candidate with no usable `last_message_at` is weighted as if it sat at the window's edge,
// so a missing timestamp costs that person some odds rather than throwing.
//
// Pure apart from Math.random(), which is injectable for tests.
function pickRecencyWeightedTarget(candidates, now = Date.now(), roll = Math.random()) {
  if (!candidates.length) return null;

  const weights = candidates.map(candidate => {
    const at = candidate.last_message_at ? new Date(candidate.last_message_at).getTime() : NaN;
    if (!Number.isFinite(at)) return 1;
    const age = Math.min(Math.max(now - at, 0), SNIPER_ACTIVITY_WINDOW_MS);
    return SNIPER_RECENCY_BIAS ** (1 - age / SNIPER_ACTIVITY_WINDOW_MS);
  });

  let remaining = roll * weights.reduce((sum, weight) => sum + weight, 0);
  for (let i = 0; i < candidates.length; i++) {
    remaining -= weights[i];
    if (remaining < 0) return candidates[i];
  }
  // Only reachable on floating-point rounding at the very top of the range.
  return candidates[candidates.length - 1];
}

// Builds the set of people a shot in this channel is allowed to hit right now, plus the
// broadcaster id the ban call needs. Returns null only when the channel isn't loaded at all.
async function buildTargetPool(channelLogin) {
  const channel = `#${channelLogin}`;
  const broadcasterId = String(botInitInfo.channels[channelLogin]?.id || '');
  if (!broadcasterId) return null;

  const since = new Date(Date.now() - SNIPER_ACTIVITY_WINDOW_MS);
  const recentChatters = await chatStats.getRecentChatters(channel, since);
  const eligible = pickEligibleChatters(recentChatters, broadcasterId);
  if (!eligible.length) return { broadcasterId, candidates: [] };

  // Don't "shoot" someone who is already gone. This reads our own ModeratorActionLogs rather than
  // Helix: EventSub's channel.moderate reports bans/timeouts issued by human moderators through
  // Twitch's native UI too, and Helix's Get Banned Users is unusable from a moderator token (see
  // twitch/TwitchBanAPI.js's note - it answered 401 on every call). The same `since` as the
  // candidate pool is the whole window that can matter: everyone here posted a message inside it.
  //
  // It cannot see the volley's OWN hits, though - those come back over EventSub long after the
  // tick that fired them - which is why a volley draws without replacement instead of rebuilding
  // this per shot. See fireVolley().
  const alreadyBanned = await chatStats.getPunishedUserIds(
    channelLogin,
    eligible.map(chatter => chatter.user_id),
    since
  );

  return {
    broadcasterId,
    candidates: eligible.filter(chatter => !alreadyBanned.has(String(chatter.user_id))),
  };
}

// Everyone a grenade thrown right now would take: the slice of the pool that spoke inside
// GRENADE_BLAST_WINDOW_MS, freshest first, capped at GRENADE_MAX_TARGETS.
//
// No randomness at all, unlike the rifle - "everyone who was just talking" is the whole point of
// the weapon, and a grenade that skipped people at random would just be a slower rifle. A candidate
// with no usable `last_message_at` is left out rather than assumed fresh: the blast errs towards
// hitting fewer people, which is the direction a mistake should go here.
function pickBlastTargets(candidates, now = Date.now()) {
  return candidates
    .map(candidate => {
      const at = candidate.last_message_at ? new Date(candidate.last_message_at).getTime() : NaN;
      return { candidate, at };
    })
    .filter(entry => Number.isFinite(entry.at) && now - entry.at <= GRENADE_BLAST_WINDOW_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, GRENADE_MAX_TARGETS)
    .map(entry => entry.candidate);
}

// Reads the punishment a weapon deals from the channel's settings. Anything that isn't the literal
// 'ban' means 'timeout' - the milder of the two - so a garbled ChannelConfig value can never
// escalate a channel to real bans.
function punishmentFor(weapon, settings) {
  const isGrenade = weapon === 'grenade';
  const mode = (isGrenade ? settings.grenadeMode : settings.sniperMode) === 'ban' ? 'ban' : 'timeout';
  const rawSec = isGrenade ? settings.grenadeTimeoutSec : settings.sniperTimeoutSec;
  return {
    mode,
    durationSec: mode === 'ban'
      ? null
      : Math.min(MAX_SNIPER_SEC, Math.max(MIN_SNIPER_SEC, Number(rawSec) || 60)),
    reason: (isGrenade ? settings.grenadeReason : settings.sniperReason)
      || (isGrenade ? 'Осколки Бюро амнистии'
                    : 'Шальная пуля Бюро амнистии'),
  };
}

// Fires one shot at an already-chosen target. Returns the outcome record; never throws, because a
// failed shot is a missed shot, not an error worth stopping the poll for.
async function fireShotAt(channelLogin, broadcasterId, target, settings) {
  const channel = `#${channelLogin}`;
  const { mode, durationSec, reason } = punishmentFor('awp', settings);

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

// Throws one grenade: every target in the blast, punished together. Returns the outcome record;
// never throws, for the same reason fireShotAt() doesn't.
//
// The calls go out at once rather than in sequence because they are one act - a blast that took
// twenty seconds to work through its victims would land on people who spoke AFTER it went off.
async function throwGrenadeAt(channelLogin, broadcasterId, targets, settings) {
  const channel = `#${channelLogin}`;
  const { mode, durationSec, reason } = punishmentFor('grenade', settings);

  const hits = await Promise.all(targets.map(async target => {
    let success = false;
    try {
      success = mode === 'ban'
        ? await TwitchBanAPI.ban(target.user_id, broadcasterId, reason)
        : await TwitchBanAPI.timeout(target.user_id, durationSec, broadcasterId, reason);
    } catch (error) {
      console.error(`[UnbanRequests] Grenade ${mode} failed in ${channel}:`, describeError(error));
    }
    return { userId: String(target.user_id), login: target.user_login, success };
  }));

  const landed = hits.filter(hit => hit.success);
  if (landed.length < hits.length) {
    // TwitchBanAPI has already logged what Twitch said about each one; this ties it to the throw.
    console.error(
      `[UnbanRequests] Grenade in ${channel}: Twitch refused ${hits.length - landed.length} of ` +
      `${hits.length} (${hits.filter(h => !h.success).map(h => '@' + h.login).join(', ')})`
    );
  }

  return {
    fired: true,
    // Only the ones that actually landed are reported as hit - the desk announces this list, and a
    // name in it is a claim that the person is really gone from chat.
    targetLogins: landed.map(hit => hit.login),
    targetUserIds: landed.map(hit => hit.userId),
    targetCount: hits.length,
    hitCount: landed.length,
    mode,
    durationSec,
    firedAt: new Date(),
    success: landed.length > 0,
  };
}

// Everything claimed for ONE channel in this tick, fired as a volley: one target-pool read, targets
// handed out WITHOUT replacement, and the Twitch calls issued together.
//
// Twitch has no batch ban - POST /helix/moderation/bans carries a single `user_id`, so N victims are
// always N requests and no grouping can change that. What a volley buys is the other three costs.
// The pool query pair (recent chatters + already-punished) is identical for everything fired in the
// same tick, and now runs once instead of once per shot. The requests overlap instead of queueing,
// so a burst still resolves inside one ~2s tick - which matters because the fast lane cannot overlap
// itself (see start()). And the part that was actually wrong before: two shots in the same tick
// could pick the SAME victim, because the already-punished filter reads ModeratorActionLogs, which
// is fed by EventSub - the volley's own first hit is never visible to its second. Handing out
// targets without replacement is the only thing that can see it.
//
// Targets are assigned in one synchronous pass BEFORE anything is fired, so who gets what doesn't
// depend on how fast Twitch answers. Grenades are served first: a blast is "everyone talking right
// now", and letting a rifle shot pick someone out of it first would quietly punch a hole in that.
//
// A volley larger than the pool is honest about it: whatever is left with nobody to hit completes as
// `no_target`, the same outcome a shot into an empty chat has always had.
async function fireVolley(channelLogin, shots) {
  const channel = `#${channelLogin}`;
  const settings = channelSettings.getSettings(channelLogin).unbanBureau || {};

  const pool = await buildTargetPool(channelLogin).catch(err => {
    console.error(`[UnbanRequests] Sniper target pool failed in ${channel}:`, describeError(err));
    return null;
  });

  const candidates = pool ? pool.candidates.slice() : [];
  if (!candidates.length) {
    console.log(
      `[UnbanRequests] Sniper found no eligible target in ${channel} (${shots.length} shot(s))`
    );
  }

  const take = victims => {
    for (const victim of victims) {
      const at = candidates.indexOf(victim);
      if (at !== -1) candidates.splice(at, 1);
    }
    return victims;
  };

  const ordered = [
    ...shots.filter(shot => shot.weapon === 'grenade'),
    ...shots.filter(shot => shot.weapon !== 'grenade'),
  ];
  const assignments = ordered.map(shot => {
    if (shot.weapon === 'grenade') return { shot, targets: take(pickBlastTargets(candidates)) };
    const target = pickRecencyWeightedTarget(candidates);
    return { shot, targets: target ? take([target]) : [] };
  });

  await Promise.all(assignments.map(async ({ shot, targets }) => {
    if (!targets.length) {
      return sniperShotsRepo.complete(shot._id, { status: 'failed', failureReason: 'no_target' });
    }

    const outcome = await (shot.weapon === 'grenade'
      ? throwGrenadeAt(channelLogin, pool.broadcasterId, targets, settings)
      : fireShotAt(channelLogin, pool.broadcasterId, targets[0], settings)
    ).catch(err => {
      console.error(`[UnbanRequests] Sniper failed in ${channel}:`, describeError(err));
      return null;
    });

    // Three distinguishable outcomes, and the review desk needs all three: a hit, a shot with
    // nobody eligible to hit, and a target Twitch then refused to act on. The last two were
    // indistinguishable (and the third was reported as a hit) until 2026-08-14.
    return sniperShotsRepo.complete(shot._id, outcome
      ? {
        status: outcome.success ? 'done' : 'failed',
        ...outcome,
        failureReason: outcome.success ? null : 'twitch_rejected',
      }
      : { status: 'failed', failureReason: 'no_target' });
  }));
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
// Returns how many votes it actually started or closed, which is what tells the fast lane whether
// anybody is at the desk - see start().
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

  return requests.length + closeRequests.length;
}

// ---------------------------------------------------------------------------
// 6. The fast poll
// ---------------------------------------------------------------------------

// Everything a human at the desk is actively waiting on: a shot they just fired through the scope,
// the vote that has to follow the appeal in front of them, and - since 2026-08-15 - the Twitch half
// of the dossier for the case they just opened. tick()'s 60s cadence is for the background
// reconciliation nobody is watching (mirroring, enrichment, applying verdicts to Twitch).
// Returns how many jobs it actually did. Zero means nobody is at any desk - see start() for what
// the fast lane does with that.
async function fastTick() {
  const votes = await processVotes().catch(err => {
    console.error('[UnbanRequests] Vote processing failed:', describeError(err));
    return 0;
  });
  const shots = await fireQueuedShots().catch(err => {
    console.error('[UnbanRequests] Sniper processing failed:', describeError(err));
    return 0;
  });
  const cards = await fetchRequestedViewerCards().catch(err => {
    console.error('[UnbanRequests] Viewer-card fetch failed:', describeError(err));
    return 0;
  });
  return votes + shots + cards;
}

// Returns how many shots it fired, for the same reason processVotes() counts - see start().
async function fireQueuedShots() {
  const shots = await sniperShotsRepo.findPending();

  // Claim everything first: without it a slow Helix call would let the next 2s tick fire the same
  // shot again. Claiming the whole batch up front is also what makes a volley possible - the shots
  // are grouped by channel below, and one still sitting unclaimed can't join its own volley.
  const claimed = [];
  for (const shot of shots) {
    if (await sniperShotsRepo.claim(shot._id)) claimed.push(shot);
  }
  if (!claimed.length) return 0;

  const byChannel = new Map();
  for (const shot of claimed) {
    if (!byChannel.has(shot.channelLogin)) byChannel.set(shot.channelLogin, []);
    byChannel.get(shot.channelLogin).push(shot);
  }

  // Channels one after another, the shots inside a channel together: a volley's whole point is the
  // one pool it shares, and two channels share nothing.
  for (const [channelLogin, channelShots] of byChannel) {
    await fireVolley(channelLogin, channelShots).catch(err => {
      console.error(`[UnbanRequests] Sniper volley failed in #${channelLogin}:`, describeError(err));
    });
  }

  return claimed.length;
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

  // The fast lane RESCHEDULES ITSELF rather than running on setInterval, for two reasons.
  //
  // It can change its own rate: a tick that did nothing proves nobody is at a desk (everything on
  // this lane is created by a moderator sitting at one), so an empty desk drops to
  // FAST_POLL_IDLE_MS and the first thing that does arrive puts it back on FAST_POLL_ACTIVE_MS for
  // FAST_ACTIVE_LINGER_MS. Prod measured 2.6% of a core spent on nothing at the fixed rate.
  //
  // And it cannot overlap itself: this lane now makes a NETWORK call (the viewer card), which can
  // outlast a 2-second interval - setInterval would have stacked ticks on top of each other during
  // exactly the moments the desk was busiest.
  scheduleFastTick();
}

let lastFastWorkAt = 0;

// The whole cadence rule, kept pure so it can be checked without driving real timers.
function nextFastDelay(lastWorkAt, now = Date.now()) {
  return now - lastWorkAt < FAST_ACTIVE_LINGER_MS ? FAST_POLL_ACTIVE_MS : FAST_POLL_IDLE_MS;
}

function scheduleFastTick() {
  sniperInterval = setTimeout(runFastTick, nextFastDelay(lastFastWorkAt));
  sniperInterval.unref?.();
}

async function runFastTick() {
  try {
    if (await fastTick()) lastFastWorkAt = Date.now();
  } catch (err) {
    console.error('[UnbanRequests] Fast tick failed:', describeError(err));
  }
  // In `finally` position deliberately: a throw here must slow the lane down, never stop it.
  scheduleFastTick();
}

module.exports = {
  start,
  tick,
  // The two pieces of sniper logic pure enough to check without a live Twitch connection: who may
  // be hit at all, and which of them the draw lands on.
  pickEligibleChatters,
  pickRecencyWeightedTarget,
  pickBlastTargets,
  fastTick,
  // Exported so scripts/local/probeModComments.js can drive the real mirroring path instead of a
  // hand-copied version of it.
  fetchRequestedViewerCards,
  POLL_INTERVAL_MS,
  SNIPER_POLL_MS,
  FAST_POLL_ACTIVE_MS,
  FAST_POLL_IDLE_MS,
  FAST_ACTIVE_LINGER_MS,
  nextFastDelay,
  MIN_SNIPER_SEC,
  MAX_SNIPER_SEC,
  SNIPER_ACTIVITY_WINDOW_MS,
  SNIPER_RECENCY_BIAS,
  GRENADE_BLAST_WINDOW_MS,
  GRENADE_MAX_TARGETS,
};
