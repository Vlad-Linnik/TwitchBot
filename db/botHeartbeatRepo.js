// Single-doc heartbeat the running bot process keeps fresh (index.js, every ~30s) so
// TwitchBot-Web's admin panel can show connection status without SSHing into the VPS to read
// pm2 logs. See ../../CLAUDE.md's shared-collections table for the BotHeartbeat row.
const { connect } = require('./db.js');

const COLLECTION = 'BotHeartbeat';
const DOC_ID = 'status';

async function writeHeartbeat(fields) {
  const db = await connect();
  await db.collection(COLLECTION).updateOne(
    { _id: DOC_ID },
    { $set: fields },
    { upsert: true }
  );
}

module.exports = { writeHeartbeat };
