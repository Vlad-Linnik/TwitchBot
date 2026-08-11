// Keeps the last few console.error()/console.warn() calls in memory so BotHeartbeat can surface
// them on the admin panel - a process that's stuck rather than crashed leaves nothing in pm2's
// error log review flow, but the errors immediately preceding a hang are still exactly what a
// diagnostics tile needs to show.
//
// Entries carry a `level` because most of what lands here is not a fault: a Twitch-initiated IRC
// RECONNECT, a 15-second network blip, an EventSub socket that comes straight back. Logging those
// at error level is what made the panel read as permanently broken. `shared/healthTracker.js`
// decides which of the two a given failure turned out to be and records the outcome through
// `record()` - a 'recovery'/'info' entry is the "it fixed itself" line, and it has to sit in this
// same feed to be seen next to the errors it answers.
const MAX_ENTRIES = 30;
const MAX_MESSAGE_LENGTH = 300;
// Repeats of an identical line inside this window collapse into one entry with a count rather than
// each taking a slot: one network blip fails every channel's poll at once (three identical
// "[ModTracker] Error Stream status" lines inside one second on 2026-08-11), and a 20-slot buffer
// full of those evicts the lines that actually explain the outage.
const COLLAPSE_WINDOW_MS = 15 * 60 * 1000;

const recentErrors = [];
let installed = false;

function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

// level: 'error' | 'warn' | 'recovery' | 'info'
function record(level, message) {
  const text = String(message).slice(0, MAX_MESSAGE_LENGTH);
  const now = new Date();

  const idx = recentErrors.findIndex((e) =>
    e.message === text && e.level === level && now - e.lastAt <= COLLAPSE_WINDOW_MS);
  if (idx !== -1) {
    // Move it to the end as well as bumping it, so the array stays ordered by last occurrence -
    // the panel renders it reversed and a repeat is news, not history.
    const [entry] = recentErrors.splice(idx, 1);
    entry.count += 1;
    entry.lastAt = now;
    recentErrors.push(entry);
    return;
  }

  recentErrors.push({ at: now, lastAt: now, level, message: text, count: 1 });
  if (recentErrors.length > MAX_ENTRIES) recentErrors.shift();
}

function install() {
  if (installed) return;
  installed = true;

  for (const [method, level] of [['error', 'error'], ['warn', 'warn']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      record(level, args.map(stringify).join(' '));
      original(...args);
    };
  }
}

function getRecent() {
  return recentErrors.slice();
}

module.exports = { install, getRecent, record };
