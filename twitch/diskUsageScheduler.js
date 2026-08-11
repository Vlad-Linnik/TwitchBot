// Hourly snapshot of MongoDB's own dbStats (incl. host filesystem usage via
// fsUsedSize/fsTotalSize - WiredTiger reports these for the volume holding dbPath, no `df`
// needed) plus per-collection $collStats, written to DiskUsageSamples so TwitchBot-Web's admin
// panel can chart which collections are actually growing instead of someone SSHing in with `du`.
// Runs independently of channels/Twitch - just a Mongo poll, never touches Helix/tmi.js.
const { connect } = require('../db/db.js');
const diskUsageRepo = require('../db/diskUsageRepo.js');
const describeError = require('../shared/describeError.js');

const SAMPLE_INTERVAL_MS = 60 * 60 * 1000; // hourly

let interval;

async function takeSample() {
  const db = await connect();
  const dbStats = await db.command({ dbStats: 1 });

  const collectionInfos = await db.listCollections({ type: 'collection' }).toArray();
  const collections = [];
  for (const { name } of collectionInfos) {
    if (name === diskUsageRepo.COLLECTION) continue;
    const [stat] = await db.collection(name)
      .aggregate([{ $collStats: { storageStats: {} } }])
      .toArray();
    const s = stat && stat.storageStats;
    if (!s) continue;
    collections.push({
      name,
      count: s.count || 0,
      size: s.size || 0,
      storageSize: s.storageSize || 0,
      totalIndexSize: s.totalIndexSize || 0,
      totalSize: s.totalSize || (s.storageSize || 0) + (s.totalIndexSize || 0),
      nindexes: s.nindexes || 0,
    });
  }

  return {
    timestamp: new Date(),
    db: {
      dataSize: dbStats.dataSize,
      storageSize: dbStats.storageSize,
      indexSize: dbStats.indexSize,
      totalSize: dbStats.totalSize,
      objects: dbStats.objects,
      fsUsedSize: dbStats.fsUsedSize ?? null,
      fsTotalSize: dbStats.fsTotalSize ?? null,
    },
    collections,
  };
}

async function tick() {
  const sample = await takeSample();
  await diskUsageRepo.writeSample(sample);
}

function start() {
  if (interval) return;
  tick().catch(err => console.error('[DiskUsage] Initial sample failed:', describeError(err)));
  interval = setInterval(() => {
    tick().catch(err => console.error('[DiskUsage] Scheduled sample failed:', describeError(err)));
  }, SAMPLE_INTERVAL_MS);
  interval.unref?.();
}

module.exports = { start, tick, SAMPLE_INTERVAL_MS };
