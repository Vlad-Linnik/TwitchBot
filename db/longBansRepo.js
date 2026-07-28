// `LongBans` collection: tracks bans/timeouts that outlast Twitch's native 2-week cap, backing
// the !longban/!cancellongban/!longbans commands (commands/longBan.js) and the background poller
// (twitch/longBanScheduler.js) that renews timeouts or fires the eventual unban.
//
// This is a SHARED-WRITE collection with TwitchBot-Web (its own `/<channel>/settings/long-bans`
// page, `db/longBansRepo.js` there) - see the top-level CLAUDE.md's shared-collections table.
// The web app has no Twitch moderation-action credentials of its own, so it only ever writes
// `status: 'pending'` (a new long-ban request) or `status: 'cancelRequested'` (asking to lift an
// active one) - this bot's twitch/longBanScheduler.js is the only thing that actually calls
// Twitch's ban/timeout/unban endpoints and promotes those into 'active'/'cancelled'.
const { connect } = require('./db.js');

const COLLECTION = 'LongBans';
// Statuses that mean "this user is currently occupying a long-ban slot" for duplicate-detection
// purposes - not just 'active', since a web-submitted 'pending' (not yet applied) or
// 'cancelRequested' (being lifted, but not yet confirmed) entry must block a second one too.
const OCCUPYING_STATUSES = ['active', 'pending', 'cancelRequested'];

let collection;
let indexesEnsured = false;

async function ensureCollection() {
  if (collection && indexesEnsured) return collection;
  const db = await connect();
  collection = db.collection(COLLECTION);
  if (!indexesEnsured) {
    // One query per poller tick (twitch/longBanScheduler.js's tick()).
    await collection.createIndex({ status: 1, mode: 1, nextRenewalAt: 1 });
    await collection.createIndex({ status: 1, mode: 1, unbanAt: 1 });
    await collection.createIndex({ status: 1 });
    // create()'s "already occupied" check and cancel/list lookups by channel+user.
    await collection.createIndex({ channelId: 1, userId: 1, status: 1 });
    indexesEnsured = true;
  }
  return collection;
}

async function create(doc) {
  const col = await ensureCollection();
  await col.insertOne(doc);
}

// Only one occupying long-ban per user per channel - enforced here at the application level
// (checked before create()) rather than a unique index, since multiple completed/cancelled/failed
// docs for the same user must be allowed to coexist.
async function findActive(channelId, userId) {
  const col = await ensureCollection();
  return col.findOne({ channelId, userId, status: { $in: OCCUPYING_STATUSES } });
}

async function findActiveByLogin(channelId, userLogin) {
  const col = await ensureCollection();
  return col.findOne({ channelId, userLogin, status: { $in: OCCUPYING_STATUSES } });
}

async function listActiveForChannel(channelId) {
  const col = await ensureCollection();
  return col.find({ channelId, status: { $in: OCCUPYING_STATUSES } }).sort({ unbanAt: 1 }).toArray();
}

async function findDueRenewals(now) {
  const col = await ensureCollection();
  return col.find({ status: 'active', mode: 'timeout', nextRenewalAt: { $lte: now } }).toArray();
}

async function findDueUnbans(now) {
  const col = await ensureCollection();
  return col.find({ status: 'active', mode: 'ban', unbanAt: { $lte: now } }).toArray();
}

// Web-submitted long-ban requests awaiting this bot's poller to actually apply them.
async function findPending() {
  const col = await ensureCollection();
  return col.find({ status: 'pending' }).toArray();
}

// Web-requested cancellations of an already-'active' long-ban, awaiting this bot's poller to
// actually call Twitch's unban endpoint.
async function findCancelRequested() {
  const col = await ensureCollection();
  return col.find({ status: 'cancelRequested' }).toArray();
}

async function updateById(id, fields) {
  const col = await ensureCollection();
  await col.updateOne({ _id: id }, { $set: fields });
}

module.exports = {
  create,
  findActive,
  findActiveByLogin,
  listActiveForChannel,
  findDueRenewals,
  findDueUnbans,
  findPending,
  findCancelRequested,
  updateById,
};
