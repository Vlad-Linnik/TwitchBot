// Twitch's per-BROADCASTER emotes (sub tiers, bits/cheer emotes, follower emotes) via Helix
// "Get Channel Emotes". https://dev.twitch.tv/docs/api/reference/#get-channel-emotes
//
// Sibling to globalEmotes.js, but NOT cacheable across channels - unlike the global list, this
// is genuinely different per broadcaster, so (unlike globalEmotes.js's single process-wide
// cache) this fetches fresh per channel on every sync call. Same app-token/Client-Id auth as
// globalEmotes.js and userLookup.js - no user scope needed.
const axios = require('axios');
const botInitInfo = require('../botInitInfo.js');
const TokenManager = require('./TokenManager.js');
const ChatStats = require('../db/chatStats.js');

const HELIX_CHANNEL_EMOTES_URL = 'https://api.twitch.tv/helix/chat/emotes';

async function ensureAppAccessToken() {
  if (!botInitInfo.settings['appAccessToken']) {
    await TokenManager.getAppAccessToken();
  }
  return botInitInfo.settings['appAccessToken'];
}

/**
 * The names of one broadcaster's own emotes (sub/bits/follower), as typed in chat.
 * @param {string} broadcasterId
 * @returns {Promise<string[]>}
 */
async function fetchChannelEmoteNames(broadcasterId) {
  const response = await axios.get(HELIX_CHANNEL_EMOTES_URL, {
    params: { broadcaster_id: broadcasterId },
    headers: {
      Authorization: `Bearer ${await ensureAppAccessToken()}`,
      'Client-Id': botInitInfo.settings['Client_Id'],
    },
  });

  // Same defensive dedupe as globalEmotes.js - not expected to collide across tiers, but the
  // whitelist's unique key is {channel, word} regardless, so cheap to guarantee here too.
  const names = (response.data?.data ?? []).map((emote) => emote.name).filter(Boolean);
  return [...new Set(names)];
}

/**
 * Upserts one channel's own Twitch emotes into its whitelist under source 'twitch-channel'.
 * Leaves 'manual'/'7tv'/'twitch-global' rows untouched - see ChatStats.syncEmoteSource().
 */
async function syncChannelEmotes(channel) {
  const login = channel.replace(/^#/, '');
  const broadcasterId = botInitInfo.channels[login]?.id;
  if (!broadcasterId) return null;

  const words = await fetchChannelEmoteNames(broadcasterId);
  const result = await ChatStats.syncTwitchChannelEmotes(channel, words);
  if (result.removed) {
    console.log(`[TwitchEmotes] ${channel}: removed ${result.removed} stale channel emotes`);
  }
  return { words, ...result };
}

module.exports = { fetchChannelEmoteNames, syncChannelEmotes };
