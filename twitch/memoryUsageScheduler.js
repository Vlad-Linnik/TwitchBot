// Machine-memory sampler for TwitchBot-Web's admin panel Memory tab - the counterpart to
// diskUsageScheduler.js, and built because the disk was the only resource we could see coming.
//
// Memory shortage is the one failure this bot cannot report on itself: the kernel resolves it by
// picking a process and terminating it, which looks like a sudden restart with no crash, no stack
// trace and nothing whatsoever in the log. Swap only softens that - paging is slow enough to read
// as a hang, and a fast allocation burst outruns it into the same silent kill - so the machine's
// own numbers have to be recorded from outside the moment they matter, i.e. continuously.
// BotHeartbeat already recorded this process's own RSS, but a single overwritten document holds no
// history, and RSS says nothing about the machine: mongod and the web panel share the same RAM.
// (Actual sizes - RAM, swap, who else is resident - are readings, not constants; they live in the
// samples and on the panel, deliberately not in this comment.)
//
// Like the disk sampler this is a pure local read (procfs + os), never touches Twitch, and is
// started unconditionally from index.js.
const memoryUsageRepo = require('../db/memoryUsageRepo.js');
const memoryInfo = require('../shared/memoryInfo.js');
const healthTracker = require('../shared/healthTracker.js');
const describeError = require('../shared/describeError.js');

// Matches the heartbeat's cadence, and is the resolution at which a spike can be caught at all -
// see db/memoryUsageRepo.js for why the samples are then aggregated into hourly buckets rather
// than stored one per sample.
const SAMPLE_INTERVAL_MS = 30_000;
// A failed write retries in 30s, so it is not an error line until it has failed for a while - see
// ../../CLAUDE.md's "Transient failures vs faults". Two intervals plus slack, the same rule the
// Helix pollers use.
const FAILURE_GRACE_MS = 2 * SAMPLE_INTERVAL_MS + 15_000;
const HEALTH_KEY = 'memorySampler';
const HEALTH_LABEL = '[Memory] usage sampler';

let interval;

async function tick() {
  await memoryUsageRepo.recordSample({
    at: new Date(),
    memory: memoryInfo.readMemory(),
    selfRssBytes: process.memoryUsage().rss,
    processes: memoryInfo.readProcesses(),
  });
}

function runTick() {
  tick().then(
    () => healthTracker.reportSuccess(HEALTH_KEY, { label: HEALTH_LABEL }),
    (err) => healthTracker.reportFailure(HEALTH_KEY, {
      label: HEALTH_LABEL,
      detail: describeError(err),
      graceMs: FAILURE_GRACE_MS,
    })
  );
}

function start() {
  if (interval) return;
  runTick();
  interval = setInterval(runTick, SAMPLE_INTERVAL_MS);
  interval.unref?.();
}

module.exports = { start, tick, SAMPLE_INTERVAL_MS };
