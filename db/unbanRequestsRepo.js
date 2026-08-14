// `UnbanRequests` collection: a local mirror of Twitch's own unban-request queue
// (GET /helix/moderation/unban_requests), backing TwitchBot-Web's "Бюро разбанов" review page.
//
// This is a SHARED-WRITE collection with TwitchBot-Web (`db/unbanRequestsRepo.js` there) - see the
// top-level CLAUDE.md's shared-collections table. Same contract as LongBans: the web app has no
// Twitch moderation-action credentials of its own, so it only ever writes `resolution.status:
// 'pending'` (a moderator pressed Approve/Deny) or `vote.status: 'requested'` (asking chat).
// twitch/unbanRequestScheduler.js is the ONLY thing that calls Twitch's unban_requests endpoints
// and the only thing that promotes those into 'done'/'failed'/'active'/'closed'.
//
// Why a mirror at all rather than proxying Helix per page view: the dossier the review page shows
// is mostly OUR data (messages, ModeratorActionLogs), and the two fields that aren't
// (account creation date, follow date) need scopes only the bot's token has. Mirroring lets the
// web side answer a page load from Mongo alone.
const { connect } = require('./db.js');

const COLLECTION = 'UnbanRequests';
// Our own sentinel, not one of Twitch's statuses: set when a request we had mirrored as pending
// stops coming back from Helix, which means it was resolved (or cancelled) somewhere else - most
// likely in Twitch's own mod view. Kept as a distinct value rather than deleting the doc so the
// dossier/audit trail survives.
const RESOLVED_ELSEWHERE = 'resolvedElsewhere';

let collection;
let indexesEnsured = false;

async function ensureCollection() {
  if (collection && indexesEnsured) return collection;
  const db = await connect();
  collection = db.collection(COLLECTION);
  if (!indexesEnsured) {
    // The mirror's identity. Twitch request ids are already globally unique, but pairing with
    // channelId keeps every per-channel query on a prefix of this index too.
    await collection.createIndex({ channelId: 1, requestId: 1 }, { unique: true });
    // The web page's "cases awaiting review" list.
    await collection.createIndex({ channelId: 1, twitchStatus: 1, requestedAt: -1 });
    // One query per scheduler tick each (twitch/unbanRequestScheduler.js's tick()). Sparse-ish by
    // nature: 'resolution.status'/'vote.status' are null on the overwhelming majority of docs.
    await collection.createIndex({ 'resolution.status': 1 });
    await collection.createIndex({ 'vote.status': 1, 'vote.endsAt': 1 });
    // findActiveVoteInChannel: the per-channel eviction lookup on every vote start.
    await collection.createIndex({ channelId: 1, 'vote.status': 1 });
    // findViewerCardRequested, run by the 2s fast tick. Null on all but the handful of cases a
    // moderator has open right now, so this stays a tiny index however long the queue gets.
    await collection.createIndex({ viewerCardRequestedAt: 1 });
    indexesEnsured = true;
  }
  return collection;
}

// Upserts one request straight from Helix. Only the fields Twitch owns are $set - the enrichment
// fields and the resolution/vote sub-documents are $setOnInsert so that re-mirroring the same
// still-pending request on the next tick can never stomp a decision a moderator just made.
async function upsertFromTwitch(doc) {
  const col = await ensureCollection();
  const now = new Date();
  await col.updateOne(
    { channelId: doc.channelId, requestId: doc.requestId },
    {
      $set: {
        channelLogin: doc.channelLogin,
        userId: doc.userId,
        userLogin: doc.userLogin,
        userDisplayName: doc.userDisplayName,
        text: doc.text,
        requestedAt: doc.requestedAt,
        twitchStatus: doc.twitchStatus,
        updatedAt: now,
      },
      $setOnInsert: {
        channelId: doc.channelId,
        requestId: doc.requestId,
        accountCreatedAt: null,
        followedAt: null,
        avatarUrl: null,
        enrichedAt: null,
        resolution: {
          status: null,
          decision: null,
          text: null,
          // When an 'approved' decision should actually reach Twitch - null means immediately.
          // TwitchBot-Web's "решение вступает в силу" field on the visa (routes/unbanBureau.js's
          // decide.json); see findResolutionPending() below for how it's honored.
          effectiveAt: null,
          decidedById: null,
          decidedByLogin: null,
          decidedByDisplayName: null,
          decidedAt: null,
          appliedAt: null,
          failureReason: null,
        },
        vote: { status: null, startedAt: null, endsAt: null, approve: 0, deny: 0 },
        // The sniper shot fired when this request's vote closed, if any - see
        // twitch/unbanRequestScheduler.js's fireSniper(). A sub-document rather than its own
        // collection because the vote and the shot are two effects of one event (one vote closing
        // on one request), 1:1, and the review page already reads this doc.
        sniper: {
          fired: false,
          targetUserId: null,
          targetLogin: null,
          mode: null,
          durationSec: null,
          firedAt: null,
          success: null,
        },
        mirroredAt: now,
      },
    },
    { upsert: true }
  );
}

// Docs mirrored but not yet enriched with the Twitch-sourced dossier facts (account creation date,
// follow date, avatar). Separate from the mirroring pass so a failing Get Users / Get Channel
// Followers call costs the request nothing but its enrichment - it still shows up for review.
async function findUnenriched(channelId) {
  const col = await ensureCollection();
  return col.find({ channelId, enrichedAt: null }).toArray();
}

// Cases a moderator has actually OPENED whose viewer-card half (Twitch's own moderator comments and
// action counts, twitch/viewerCardModLogs.js) is missing or stale.
//
// `viewerCardRequestedAt` is written by TwitchBot-Web when it serves a case's dossier.json - the
// same "the site asks, the bot executes" contract as `resolution.status: 'pending'` and
// `vote.status: 'requested'`, and for the same reason: the web app holds no Twitch credentials and
// cannot fetch this itself.
//
// UNTIL 2026-08-15 THIS PASS WAS A BACKGROUND SWEEP over every pending case on a 30-minute TTL, and
// that was the wrong shape. A moderator reads one appeal at a time, but the bot was mirroring the
// whole queue whether anyone opened it or not: an appeal nobody had got to in three days cost ~144
// requests to an undocumented, rate-limited, integrity-gated endpoint, where one would have done.
// On demand it is one request per case actually opened, and none at all for a quiet queue.
//
// The 30-minute TTL survives as a freshness check rather than a schedule - reopening the same case
// inside the window re-reads nothing. That check is deliberately NOT in this query: the flag has to
// come off every doc it is set on, fetch or no fetch, or a case opened once while its card was
// fresh would keep the flag forever and get re-fetched on the TTL for as long as it stays pending -
// which is the background sweep this replaced, wearing a different hat. So the query returns
// everything flagged and twitch/unbanRequestScheduler.js (which owns the TTL constant) decides.
//
// Deliberately NOT folded into findUnenriched: those facts are immutable per user, fetched once and
// done, while a moderator can leave a comment on a case that is open in front of another moderator
// right now. Keeping the two passes separate also means a GraphQL outage never blocks the Helix
// enrichment, or vice versa.
//
// `viewerCardRetryAfter` is the per-case half of the backoff added 2026-08-14 - see the scheduler
// for why it now only ever arms on a per-case failure. Sorted oldest-request-first so the per-tick
// ceiling is a queue rather than a lottery.
async function findViewerCardRequested(now = new Date()) {
  const col = await ensureCollection();
  return col
    .find({
      twitchStatus: 'pending',
      viewerCardRequestedAt: { $ne: null, $exists: true },
      $or: [
        { viewerCardRetryAfter: null },
        { viewerCardRetryAfter: { $exists: false } },
        { viewerCardRetryAfter: { $lte: now } },
      ],
    })
    .sort({ viewerCardRequestedAt: 1 })
    .toArray();
}

// Drops the "a moderator opened this" flag without fetching anything. Used for a case whose stored
// card is still inside the TTL: the site sets the flag on every first dossier load (it does not
// know the TTL), so this is the common outcome, and leaving the flag set would make the fast tick
// re-examine the same doc every 2 seconds forever.
async function clearViewerCardRequest(id) {
  const col = await ensureCollection();
  await col.updateOne({ _id: id }, { $set: { viewerCardRequestedAt: null } });
}

// Requests we still hold as pending whose ids Twitch no longer returns - resolved elsewhere.
// `keepRequestIds` is the id list from this tick's Helix response for that channel.
async function markMissingAsResolvedElsewhere(channelId, keepRequestIds) {
  const col = await ensureCollection();
  const result = await col.updateMany(
    { channelId, twitchStatus: 'pending', requestId: { $nin: keepRequestIds } },
    { $set: { twitchStatus: RESOLVED_ELSEWHERE, updatedAt: new Date() } }
  );
  return result.modifiedCount;
}

// Decisions a moderator made on the website, awaiting this bot's poller to actually PATCH Twitch -
// but only the DUE ones. `resolution.effectiveAt` is the "решение вступает в силу" date the
// moderator can set when approving (null/past = immediately); a future date means the doc sits
// here, still resolution.status: 'pending', until a tick's `now` reaches it. Same execute-only-by-
// bot contract as everything else in this collection - the web side can only ever ask for a date,
// never PATCH Twitch itself.
async function findResolutionPending(now = new Date()) {
  const col = await ensureCollection();
  return col
    .find({
      'resolution.status': 'pending',
      $or: [
        { 'resolution.effectiveAt': null },
        { 'resolution.effectiveAt': { $exists: false } },
        { 'resolution.effectiveAt': { $lte: now } },
      ],
    })
    .toArray();
}

// Chat votes requested on the website, awaiting this bot to actually post the prompt in chat.
async function findVoteRequested() {
  const col = await ensureCollection();
  return col.find({ 'vote.status': 'requested' }).toArray();
}

// The safety net only: a vote's normal end is the moderator's verdict (findVoteCloseRequested),
// and `vote.endsAt` is now a ceiling rather than the intended length - it exists so a moderator who
// closes the tab can't leave chat voting forever.
async function findDueVoteClosures(now) {
  const col = await ensureCollection();
  return col.find({ 'vote.status': 'active', 'vote.endsAt': { $lte: now } }).toArray();
}

// Votes TwitchBot-Web asked to close because a verdict was just stamped on that appeal. Only the
// bot can actually close one, because closing announces the result in chat.
async function findVoteCloseRequested() {
  const col = await ensureCollection();
  return col.find({ 'vote.status': 'closeRequested' }).toArray();
}

// The vote currently running in a channel, whichever appeal it belongs to. Used to evict a stale
// vote when the moderator moves on to a different appeal - see processVoteRequest.
async function findActiveVoteInChannel(channelId) {
  const col = await ensureCollection();
  return col.findOne({ channelId, 'vote.status': 'active' });
}

// Rehydrates games/unbanVote.js's in-memory tally after a bot restart mid-vote.
async function findActiveVotes() {
  const col = await ensureCollection();
  return col.find({ 'vote.status': 'active' }).toArray();
}

// Live tally flush from games/unbanVote.js - deliberately narrow ($set of two counters only) so it
// can run on a short debounce without racing the scheduler's own writes to the same doc.
async function setVoteTally(id, approve, deny) {
  const col = await ensureCollection();
  await col.updateOne({ _id: id }, { $set: { 'vote.approve': approve, 'vote.deny': deny } });
}

async function updateById(id, fields) {
  const col = await ensureCollection();
  await col.updateOne({ _id: id }, { $set: { ...fields, updatedAt: new Date() } });
}

module.exports = {
  RESOLVED_ELSEWHERE,
  upsertFromTwitch,
  findUnenriched,
  findViewerCardRequested,
  clearViewerCardRequest,
  markMissingAsResolvedElsewhere,
  findResolutionPending,
  findVoteRequested,
  findDueVoteClosures,
  findVoteCloseRequested,
  findActiveVoteInChannel,
  findActiveVotes,
  setVoteTally,
  updateById,
};
