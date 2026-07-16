// The channel's 7TV emote set, auto-resolved from its Twitch broadcaster ID - no manual link
// required. 7TV exposes a direct lookup by connected platform account:
// GET https://7tv.io/v3/users/twitch/{broadcasterId} returns the linked 7TV user's connection
// AND its active emote set (with emotes already embedded) in one call - a channel owner who has
// never created/linked a 7TV account just gets a 404, treated the same as "no 7TV set" used to
// be treated when the link field was empty.
const axios = require('axios');
const ChatStats = require('../db/chatStats.js');
const botInitInfo = require('../botInitInfo.js');

const API_BASE = 'https://7tv.io/v3';

// Fetches the broadcaster's linked 7TV emote set's current emote names. Uses each emote's
// set-local name (not its underlying data.name) since that's the alias actually usable in chat.
// Returns null if the broadcaster has no 7TV account linked to their Twitch.
async function fetchEmoteSetWords(broadcasterId) {
  let data;
  try {
    ({ data } = await axios.get(`${API_BASE}/users/twitch/${broadcasterId}`));
  } catch (err) {
    if (err.response?.status === 404) return null;
    throw err;
  }

  const setId = data.emote_set?.id;
  if (!setId) return null;

  const words = (data.emote_set.emotes ?? []).map(emote => emote.name);
  return { setId, words };
}

// Resolves the channel's broadcaster ID and upserts its linked 7TV set's emotes into that
// channel's whitelist, removing any previously-synced emotes no longer in the set.
// Returns null if the channel has no 7TV account linked.
async function syncChannelEmoteSet(channel) {
  const login = channel.replace(/^#/, '');
  const broadcasterId = botInitInfo.channels[login]?.id;
  if (!broadcasterId) return null;

  const resolved = await fetchEmoteSetWords(broadcasterId);
  if (!resolved) return null;

  const { setId, words } = resolved;
  await ChatStats.syncSevenTvEmoteSet(channel, setId, words);
  console.log(`[7TV] Synced ${words.length} emotes for ${channel} (set ${setId})`);
  return { setId, words };
}

module.exports = {
  fetchEmoteSetWords,
  syncChannelEmoteSet,
};
