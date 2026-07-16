// Twitch Helix "Get Clips" - https://dev.twitch.tv/docs/api/reference/#get-clips
//
// Clips are public data: the endpoint only needs an APP access token, no broadcaster-specific
// user scope - same pattern as twitch/globalEmotes.js / twitch/userLookup.js.
const axios = require('axios');
const botInitInfo = require('../botInitInfo.js');
const TokenManager = require('./TokenManager.js');

const HELIX_CLIPS_URL = 'https://api.twitch.tv/helix/clips';

// Mirrors globalEmotes.js: fetch an app token on demand so this also works from a standalone
// script, where TokenManager's background refresh loop (started only by index.js) never ran.
async function ensureAppAccessToken() {
  if (!botInitInfo.settings['appAccessToken']) {
    await TokenManager.getAppAccessToken();
  }
  return botInitInfo.settings['appAccessToken'];
}

/**
 * Up to `first` (max 100) of a broadcaster's most-viewed clips.
 * @param {string} broadcasterId
 * @param {number} [first]
 * @returns {Promise<object[]>}
 */
async function fetchClips(broadcasterId, first = 100) {
  const response = await axios.get(HELIX_CLIPS_URL, {
    params: { broadcaster_id: broadcasterId, first },
    headers: {
      Authorization: `Bearer ${await ensureAppAccessToken()}`,
      'Client-Id': botInitInfo.settings['Client_Id'],
    },
  });
  return response.data?.data ?? [];
}

/**
 * A random clip for the channel. Get Clips has no "random" sort and no total count in its
 * response, so this picks from the channel's top `first` most-viewed clips rather than
 * walking its full pagination just to answer one chat command.
 * @param {string} broadcasterId
 * @returns {Promise<object|null>}
 */
async function getRandomClip(broadcasterId) {
  const clips = await fetchClips(broadcasterId);
  if (clips.length === 0) return null;
  return clips[Math.floor(Math.random() * clips.length)];
}

module.exports = { fetchClips, getRandomClip };
