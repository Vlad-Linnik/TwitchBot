// Keeps the last few console.error() calls in memory so BotHeartbeat can surface them on the
// admin panel - a process that's stuck rather than crashed leaves nothing in pm2's error log
// review flow, but the errors immediately preceding a hang are still exactly what a diagnostics
// tile needs to show.
const MAX_ENTRIES = 20;
const MAX_MESSAGE_LENGTH = 300;

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

function install() {
  if (installed) return;
  installed = true;

  const original = console.error.bind(console);
  console.error = (...args) => {
    const message = args.map(stringify).join(' ').slice(0, MAX_MESSAGE_LENGTH);
    recentErrors.push({ at: new Date(), message });
    if (recentErrors.length > MAX_ENTRIES) recentErrors.shift();
    original(...args);
  };
}

function getRecent() {
  return recentErrors.slice();
}

module.exports = { install, getRecent };
