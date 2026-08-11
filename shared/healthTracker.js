// Turns "a call to Twitch failed" into one of two very different statements: a fault worth an
// error line, or a blip that fixed itself and should say so.
//
// Every network-facing subsystem here already recovers on its own - tmi.js reconnects, EventSub
// reconnects with backoff, and the two Helix pollers just try again next tick. Logging each
// failure at error level the moment it happened meant the admin panel's error list was mostly
// full of things that were already over: the 2026-08-11 cluster (six red lines across ModTracker,
// UnbanRequests, EventSub and tmi) was one ~15-second network outage on the VPS, fully recovered
// before anyone read it, and the five lone "[tmi] Disconnected: Connection closed." lines above it
// were Twitch's own routine RECONNECT command (tmi.js client.js's `case 'RECONNECT'` calls
// disconnect() and reconnects a second later, which is why they carry no matching reconnect line).
// Nothing was broken and nothing needed doing, which is exactly what the panel could not say.
//
// So a failure is held for `graceMs` before it is called an error. Recover inside that window and
// the outcome is a single 'info' line saying it healed itself; stay down past it and it escalates
// to a real error, followed later by a 'recovery' line closing it out. Either way the panel ends
// up holding the answer to "and then what happened", which is the thing it never used to record.
const errorRingBuffer = require('./errorRingBuffer.js');

// key -> { label, since, failures, detail, scopes, timer, escalated, reportedDetail }
const states = new Map();

function formatDuration(ms) {
  const totalS = Math.max(0, Math.round(ms / 1000));
  if (totalS < 60) return `${totalS}s`;
  const min = Math.floor(totalS / 60);
  const s = totalS % 60;
  if (min < 60) return s ? `${min}m ${s}s` : `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

function scopeSuffix(scopes) {
  const named = [...scopes].filter(Boolean);
  return named.length ? ` (${named.join(', ')})` : '';
}

function escalate(key) {
  const state = states.get(key);
  if (!state || state.escalated) return;
  state.timer = null;
  state.escalated = true;
  state.reportedDetail = state.detail;
  // console.error, not record(), so it still reaches pm2's log the way every other error here does.
  console.error(
    `${state.label} unavailable for ${formatDuration(Date.now() - state.since)}${scopeSuffix(state.scopes)}` +
    ` after ${state.failures} failed attempt(s): ${state.detail}`
  );
}

// A failure that is expected to retry itself. `scope` (a channel login, say) lets one subsystem
// track several targets under a single entry: a network outage fails all of them at once and
// should read as one incident, not one per channel.
function reportFailure(key, { label, detail = 'unknown error', scope = '', graceMs = 0 } = {}) {
  let state = states.get(key);
  if (!state) {
    state = {
      label, since: Date.now(), failures: 0, detail,
      scopes: new Set(), timer: null, escalated: false, reportedDetail: null,
    };
    states.set(key, state);
  }

  state.label = label || state.label;
  state.detail = detail;
  state.failures += 1;
  state.scopes.add(scope);

  if (state.escalated) {
    // An already-reported outage that changes its failure mode is news (a timeout turning into a
    // 401 means something else entirely); an unchanged one stays quiet and just keeps counting,
    // since the ring buffer would only collapse the repeat anyway.
    if (detail !== state.reportedDetail) {
      state.escalated = false;
      escalate(key);
    }
    return;
  }
  if (state.timer) return;

  if (graceMs > 0) {
    state.timer = setTimeout(() => escalate(key), graceMs);
    state.timer.unref?.();
  } else {
    escalate(key);
  }
}

// The other half: a success only means something when it follows a failure.
function reportSuccess(key, { label, scope = '' } = {}) {
  const state = states.get(key);
  if (!state) return;

  state.scopes.delete(scope);
  // Still failing somewhere else under the same key - the incident isn't over yet.
  if (state.scopes.size > 0) return;

  if (state.timer) clearTimeout(state.timer);
  states.delete(key);

  const name = label || state.label;
  const down = formatDuration(Date.now() - state.since);
  if (state.escalated) {
    const message = `${name} recovered after ${down} down (${state.failures} failed attempt(s)).`;
    errorRingBuffer.record('recovery', message);
    console.log(message);
  } else {
    // Never made it to an error line, so this is the whole record of the blip.
    const message = `${name} dropped and recovered on its own after ${down} (${state.detail}).`;
    errorRingBuffer.record('info', message);
    console.log(message);
  }
}

// What is failing right now, for the heartbeat doc - so the panel can distinguish "there were
// errors earlier" from "it is broken at this moment".
function getSnapshot() {
  return [...states.entries()].map(([key, s]) => ({
    key,
    label: s.label,
    since: new Date(s.since),
    failures: s.failures,
    detail: s.detail,
    escalated: s.escalated,
    scopes: [...s.scopes].filter(Boolean),
  }));
}

module.exports = { reportFailure, reportSuccess, getSnapshot };
