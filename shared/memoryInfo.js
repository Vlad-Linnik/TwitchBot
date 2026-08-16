// Machine-level memory facts for twitch/memoryUsageScheduler.js. Pure parsing helpers are
// exported alongside the readers so they can be unit-tested without a Linux /proc.
//
// Two things here are the entire point of the file, and both are reasons NOT to just call
// os.freemem():
//
// - On Linux os.freemem() returns MemFree, which excludes reclaimable page cache. On a healthy
//   machine that number is always alarmingly small (the kernel deliberately spends idle RAM on
//   cache), so trending it would show a permanent, meaningless emergency. MemAvailable is the
//   kernel's own estimate of what a new allocation could actually get without swapping, and it is
//   the number an OOM kill is predicted from. We record both, and everything downstream trends
//   MemAvailable.
// - Swap is read explicitly, because on this VPS SwapTotal is 0 and that is not a detail. With no
//   swap the kernel cannot page anything out under pressure: a spike is answered by the OOM killer
//   rather than by slowdown, which is why the bot disappears with no crash, no stack trace and
//   nothing in the log. A panel that can't say "there is no swap" can't explain that.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MEMINFO_PATH = '/proc/meminfo';
const PROC_PATH = '/proc';
// /proc/<pid>/statm counts pages, not bytes.
const PAGE_SIZE = 4096;

// /proc/meminfo values are in kB (the unit is spelled in the line and is always kB in practice,
// but the suffix is parsed rather than assumed - a value with no unit is a raw byte count).
function parseMemInfo(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^(\w+):\s+(\d+)(?:\s+(\w+))?/.exec(line);
    if (!m) continue;
    const value = Number(m[2]);
    out[m[1]] = m[3] && m[3].toLowerCase() === 'kb' ? value * 1024 : value;
  }
  return out;
}

function shapeFromMemInfo(info) {
  const total = info.MemTotal || 0;
  if (!total) return null;
  return {
    source: 'meminfo',
    totalBytes: total,
    // MemAvailable landed in Linux 3.14; on anything older fall back to the crude classic estimate
    // rather than reporting nothing.
    availableBytes: info.MemAvailable != null
      ? info.MemAvailable
      : (info.MemFree || 0) + (info.Buffers || 0) + (info.Cached || 0),
    freeBytes: info.MemFree || 0,
    buffersBytes: info.Buffers || 0,
    cachedBytes: info.Cached || 0,
    swapTotalBytes: info.SwapTotal != null ? info.SwapTotal : null,
    swapFreeBytes: info.SwapFree != null ? info.SwapFree : null,
  };
}

// Windows/macOS dev machines have no /proc. os.freemem() means something different on each
// platform, so the shape is marked `source: 'os'` and the swap fields stay null (unknown, which
// the panel must not render as "no swap" - that claim is exactly what matters on the VPS).
function shapeFromOs() {
  return {
    source: 'os',
    totalBytes: os.totalmem(),
    availableBytes: os.freemem(),
    freeBytes: os.freemem(),
    buffersBytes: null,
    cachedBytes: null,
    swapTotalBytes: null,
    swapFreeBytes: null,
  };
}

function readMemory() {
  try {
    const shaped = shapeFromMemInfo(parseMemInfo(fs.readFileSync(MEMINFO_PATH, 'utf8')));
    if (shaped) return shaped;
  } catch {
    // Not Linux, or /proc unreadable - fall through.
  }
  return shapeFromOs();
}

// The resident-set size of one process, from /proc/<pid>/statm's second field (resident pages).
function parseStatm(text) {
  const fields = String(text).trim().split(/\s+/);
  const resident = Number(fields[1]);
  return Number.isFinite(resident) ? resident * PAGE_SIZE : null;
}

// The bot and the web panel are separate processes on the same VPS, and mongod is a third - so
// "which process is holding the RAM" cannot be answered from inside this one. On Linux it can be
// read straight out of /proc; everywhere else this returns [] and the panel simply shows nothing.
//
// Both node processes run the same argv (`node index.js`), so the working directory is what tells
// them apart. It is a symlink readable only by the process owner, so a permission error there is
// expected and non-fatal - the entry keeps its pid and command and loses only the label.
function readProcesses({ minRssBytes = 20 * 1024 * 1024, limit = 12 } = {}) {
  let pids;
  try {
    pids = fs.readdirSync(PROC_PATH).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }

  const processes = [];
  for (const pid of pids) {
    try {
      const rssBytes = parseStatm(fs.readFileSync(path.posix.join(PROC_PATH, pid, 'statm'), 'utf8'));
      if (rssBytes == null || rssBytes < minRssBytes) continue;

      const name = fs.readFileSync(path.posix.join(PROC_PATH, pid, 'comm'), 'utf8').trim();
      // cmdline is NUL-separated, and the trailing NUL leaves an empty last element.
      const command = fs.readFileSync(path.posix.join(PROC_PATH, pid, 'cmdline'), 'utf8')
        .split('\0').filter(Boolean).join(' ').slice(0, 120);

      let cwd = null;
      try {
        cwd = path.posix.basename(fs.readlinkSync(path.posix.join(PROC_PATH, pid, 'cwd')));
      } catch {
        // Another user's process - readable size, unreadable identity.
      }

      processes.push({ pid: Number(pid), name, command, cwd, rssBytes });
    } catch {
      // A process that exited between readdir and read, or one we may not inspect.
    }
  }

  processes.sort((a, b) => b.rssBytes - a.rssBytes);
  return processes.slice(0, limit);
}

module.exports = { readMemory, readProcesses, parseMemInfo, shapeFromMemInfo, parseStatm };
