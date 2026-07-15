const axios = require('axios');
const ChatStats = require('../db/chatStats.js');
const channelSettings = require('../config/channelSettings.js');

const API_BASE = 'https://7tv.io/v3';

// Accepts a 7TV emote-set link (https://7tv.app/emote-sets/<id>) or a 7TV user
// link (https://7tv.app/users/<id>) - channel owners usually share the latter,
// so it's resolved to that user's active Twitch emote set.
function parseLink(link) {
  const match = link.match(/7tv\.app\/(emote-sets|users)\/(\w+)/);
  if (!match) {
    throw new Error(`Not a recognizable 7TV link: ${link}`);
  }
  return { type: match[1] === 'users' ? 'user' : 'set', id: match[2] };
}

async function resolveEmoteSetId(link) {
  const { type, id } = parseLink(link);
  if (type === 'set') return id;

  const { data: user } = await axios.get(`${API_BASE}/users/${id}`);
  const twitchConnection = user.connections?.find(connection => connection.platform === 'TWITCH');
  const setId = twitchConnection?.emote_set_id ?? user.emote_sets?.[0]?.id;
  if (!setId) {
    throw new Error(`7TV user ${id} has no emote set`);
  }
  return setId;
}

// Fetches the emote set's current emote names. Uses each emote's set-local
// name (not its underlying data.name) since that's the alias actually usable in chat.
async function fetchEmoteSetWords(link) {
  const setId = await resolveEmoteSetId(link);
  const { data: emoteSet } = await axios.get(`${API_BASE}/emote-sets/${setId}`);
  const words = (emoteSet.emotes ?? []).map(emote => emote.name);
  return { setId, words };
}

// Looks up the channel's configured 7TV set link and upserts its emotes into
// that channel's whitelist, removing any previously-synced emotes no longer in the set.
// Returns null if the channel has no 7TV set configured.
// getSettingsFresh, not getSettings: at startup the synchronous cache still holds bare
// defaults (empty emoteSetUrl) while ChannelConfig loads in the background, and this sync
// would silently skip the channel. Waiting one Mongo read is fine here - emote syncs are
// never on the chat-message path.
async function syncChannelEmoteSet(channel) {
  const settings = await channelSettings.getSettingsFresh(channel);
  const link = settings.sevenTv?.emoteSetUrl;
  if (!link) return null;

  const { setId, words } = await fetchEmoteSetWords(link);
  await ChatStats.syncSevenTvEmoteSet(channel, setId, words);
  console.log(`[7TV] Synced ${words.length} emotes for ${channel} (set ${setId})`);
  return { setId, words };
}

module.exports = {
  fetchEmoteSetWords,
  syncChannelEmoteSet,
};
