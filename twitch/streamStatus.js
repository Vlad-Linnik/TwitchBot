// Shared per-broadcaster live/offline registry, populated by ModActivityTracker's
// polling and read by anything that needs to gate on stream status (e.g. the
// timer-driven custom command auto-sends) without depending on ActivitiTracker
// instances directly.
const axios = require('axios');
const botInitInfo = require('../botInitInfo');
const describeError = require('../shared/describeError.js');

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

// Fetches Get Streams right now instead of waiting for ActivitiTracker's next poll (up to
// 5 minutes stale, ActivitiTracker.js's default checkIntervalMs) and updates the shared cache
// from the result, same as ActivitiTracker.checkActivity() does - so the next scheduled poll
// just confirms what this already set. For most callers (auto-send gating) a few minutes of
// staleness is fine, but a category-specific custom command reply is user-visibly wrong if it
// answers with the old category's text right after the streamer switches, so it forces a fresh
// check instead. On failure (or genuinely offline), leaves live/category as the API just
// reported and returns whatever's cached - never throws, so a Twitch hiccup falls back to the
// same stale-but-present behavior callers already tolerated before this existed.
async function refreshCategory(broadcasterId) {
  try {
    const response = await axios.get('https://api.twitch.tv/helix/streams', {
      params: { user_id: broadcasterId },
      headers: {
        'Authorization': `Bearer ${botInitInfo.settings['password']}`,
        'Client-Id': botInitInfo.settings['Client_Id']
      }
    });
    const streams = response.data && response.data.data;
    const streamInfo = streams && streams.length > 0 ? streams[0] : false;
    setLive(broadcasterId, !!streamInfo);
    setCategory(broadcasterId, streamInfo ? streamInfo.game_name : null);
  } catch (error) {
    console.error('[streamStatus] Error refreshing category:', describeError(error));
  }
  return getCategory(broadcasterId);
}

module.exports = { setLive, isLive, setCategory, getCategory, refreshCategory };
