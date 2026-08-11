// Hourly disk-usage samples (twitch/diskUsageScheduler.js) backing TwitchBot-Web's admin panel
// Disk Usage tab (its own db/diskUsageRepo.js reads what this writes). See ../../CLAUDE.md's
// shared-collections table for the DiskUsageSamples row.
const { connect } = require('./db.js');

const COLLECTION = 'DiskUsageSamples';
// Auto-expired via a TTL index rather than a separate rollup/cleanup job - hourly samples for
// 90 days is ~2,160 documents (a few MB), plenty for a growth-rate trend line, and Mongo prunes
// the rest for us.
const RETENTION_SECONDS = 90 * 24 * 60 * 60;

let indexesEnsured = false;

async function ensureIndexes(db) {
  if (indexesEnsured) return;
  await db.collection(COLLECTION).createIndex(
    { timestamp: 1 },
    { expireAfterSeconds: RETENTION_SECONDS }
  );
  indexesEnsured = true;
}

async function writeSample(sample) {
  const db = await connect();
  await ensureIndexes(db);
  await db.collection(COLLECTION).insertOne(sample);
}

module.exports = { writeSample, COLLECTION, RETENTION_SECONDS };
