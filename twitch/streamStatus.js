// Shared per-broadcaster live/offline registry, populated by ModActivityTracker's
// polling and read by anything that needs to gate on stream status (e.g. the
// timer-driven custom command auto-sends) without depending on ActivitiTracker
// instances directly.
const liveStatus = new Map(); // broadcasterId (string) -> boolean

function setLive(broadcasterId, isLive) {
  liveStatus.set(`${broadcasterId}`, !!isLive);
}

// Defaults to false (treated as offline) until the first successful check reports
// in, so nothing fires based on stale/unknown status right after startup.
function isLive(broadcasterId) {
  return liveStatus.get(`${broadcasterId}`) ?? false;
}

module.exports = { setLive, isLive };
