// Hourly memory-usage buckets (twitch/memoryUsageScheduler.js) backing TwitchBot-Web's admin
// panel Memory tab, mirroring DiskUsageSamples/db/diskUsageRepo.js. See ../../CLAUDE.md's
// shared-collections table for the MemoryUsageSamples row.
//
// It differs from the disk sampler in one deliberate way: disk is sampled hourly and stored as
// one point per sample, memory is sampled every 30s and AGGREGATED into one document per hour.
// Both halves of that matter.
//
// - Sampling hourly would be useless. Disk grows monotonically over days, so an hourly point
//   describes it fully; memory pressure arrives in seconds. With no swap on this VPS the kernel
//   answers a spike with the OOM killer, and an hourly point sample would land either side of the
//   spike that killed the process and show nothing at all.
// - Storing every 30s sample would be 259k documents per 90 days. Keeping min/avg/max per hour
//   holds the retention at the same ~2,160 documents the disk sampler costs while still recording
//   the floor - and the floor is the number that predicts an OOM kill.
//
// The aggregation is done by Mongo ($min/$max/$inc on an upsert) rather than in memory, because
// the process being measured is the one that gets killed: an in-memory accumulator flushed on the
// hour would lose precisely the partial hour in which the kill happened. This way everything up to
// the last 30 seconds before death is already on disk.
const { connect } = require('./db.js');

const COLLECTION = 'MemoryUsageSamples';
// Same self-pruning TTL as DiskUsageSamples, and the same arithmetic: hourly buckets for 90 days
// is ~2,160 documents, so no rollup or cleanup job is needed.
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

function hourStart(date) {
  const d = new Date(date);
  d.setMinutes(0, 0, 0);
  return d;
}

// sample: { memory: <shared/memoryInfo.js readMemory()>, selfRssBytes, processes, at }
async function recordSample(sample) {
  const db = await connect();
  await ensureIndexes(db);

  const { memory, selfRssBytes, processes = [], at = new Date() } = sample;
  const bucket = hourStart(at);
  const usedBytes = memory.totalBytes - memory.availableBytes;

  await db.collection(COLLECTION).updateOne(
    { timestamp: bucket },
    {
      $inc: {
        samples: 1,
        'available.sum': memory.availableBytes,
        'self.sum': selfRssBytes,
      },
      $min: {
        'available.min': memory.availableBytes,
        'self.min': selfRssBytes,
      },
      $max: {
        'available.max': memory.availableBytes,
        'self.max': selfRssBytes,
      },
      // Everything a snapshot rather than a range: total RAM and the swap configuration don't
      // move, and the process list is a "who is holding it right now" answer that would cost far
      // more than it's worth to track per-process over an hour.
      $set: {
        'available.last': memory.availableBytes,
        'self.last': selfRssBytes,
        source: memory.source,
        totalBytes: memory.totalBytes,
        usedBytes,
        freeBytes: memory.freeBytes,
        buffersBytes: memory.buffersBytes,
        cachedBytes: memory.cachedBytes,
        swapTotalBytes: memory.swapTotalBytes,
        swapFreeBytes: memory.swapFreeBytes,
        processes,
        updatedAt: at,
      },
    },
    { upsert: true }
  );
}

module.exports = { recordSample, hourStart, COLLECTION, RETENTION_SECONDS };
