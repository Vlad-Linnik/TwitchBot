// `SniperShots`: the "stray bullet" the moderator fires from the Бюро амнистии review desk.
//
// SHARED-WRITE with TwitchBot-Web (`db/sniperShotsRepo.js` there), same execute-only-by-bot
// contract as LongBans and UnbanRequests: the web app writes a `pending` row when the moderator
// clicks a pedestrian through the rifle scope, and twitch/unbanRequestScheduler.js is the only
// thing that ever picks a target and calls Twitch.
//
// Why its own collection rather than a sub-document on UnbanRequests (where the shot used to live,
// back when it fired automatically on a vote closing): a shot is now a deliberate act that can
// happen any number of times per case, or with no case open at all. It is no longer 1:1 with a
// request, so it no longer belongs inside one.
//
// This is polled far more often than anything else in this codebase (FAST_POLL_ACTIVE_MS, ~2s -
// dropping to FAST_POLL_IDLE_MS once the desk has been quiet, see the scheduler's start()) because
// it is the one cross-repo write with a human waiting on the result: the moderator has just fired
// a rifle and expects someone to drop. The collection stays tiny and the query is a covered index
// hit on `{status: 'pending'}`, so the cost is negligible.
const { connect } = require('./db.js');

const COLLECTION = 'SniperShots';

let collection;
let indexesEnsured = false;

async function ensureCollection() {
  if (collection && indexesEnsured) return collection;
  const db = await connect();
  collection = db.collection(COLLECTION);
  if (!indexesEnsured) {
    // The scheduler's fast poll.
    await collection.createIndex({ status: 1, requestedAt: 1 });
    // The review page's "what happened to my shot" lookup.
    await collection.createIndex({ channelId: 1, requestedAt: -1 });
    indexesEnsured = true;
  }
  return collection;
}

async function findPending() {
  const col = await ensureCollection();
  return col.find({ status: 'pending' }).sort({ requestedAt: 1 }).limit(20).toArray();
}

// Claims one shot so a second scheduler tick (or a second bot process) can't fire it twice. Returns
// true only for the caller that actually won the row.
async function claim(id) {
  const col = await ensureCollection();
  const result = await col.updateOne(
    { _id: id, status: 'pending' },
    { $set: { status: 'firing', claimedAt: new Date() } }
  );
  return result.modifiedCount === 1;
}

async function complete(id, fields) {
  const col = await ensureCollection();
  await col.updateOne({ _id: id }, { $set: { ...fields, resolvedAt: new Date() } });
}

module.exports = { findPending, claim, complete };
