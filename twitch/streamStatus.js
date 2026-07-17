// Shared per-broadcaster live/offline registry, populated by ModActivityTracker's
// polling and read by anything that needs to gate on stream status (e.g. the
// timer-driven custom command auto-sends) without depending on ActivitiTracker
// instances directly.
const liveStatus = new Map(); // broadcasterId (string) -> boolean
const category = new Map(); // broadcasterId (string) -> current game_name (or null when offline/unknown)

function setLive(broadcasterId, isLive) {
  liveStatus.set(`${broadcasterId}`, !!isLive);
}

// Defaults to false (treated as offline) until the first successful check reports
// in, so nothing fires based on stale/unknown status right after startup.
function isLive(broadcasterId) {
  return liveStatus.get(`${broadcasterId}`) ?? false;
}

// gameName is Twitch's `game_name` from the Get Streams response (e.g. "Dota 2"),
// or null while offline/between checks - callers gating on a specific category
// must treat null as "not that category", never as "assume live".
function setCategory(broadcasterId, gameName) {
  category.set(`${broadcasterId}`, gameName || null);
}

function getCategory(broadcasterId) {
  return category.get(`${broadcasterId}`) ?? null;
}

module.exports = { setLive, isLive, setCategory, getCategory };
