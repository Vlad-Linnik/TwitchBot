const { connect } = require('./db.js');

// Read-only view of the `Channels` collection, owned and written by the sibling
// TwitchBot-Web repo (see ../../CLAUDE.md). Mirrors its db/channelsRepo.js shape by
// hand - the two repos share no code, only this Mongo collection.
let channelsCollection;

async function ensureCollection() {
  if (channelsCollection) return channelsCollection;
  const db = await connect();
  channelsCollection = db.collection('Channels');
  return channelsCollection;
}

async function listEnabledChannels() {
  const col = await ensureCollection();
  return col.find({ enabled: true }).toArray();
}

module.exports = { listEnabledChannels };
