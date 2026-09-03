// BetterTTV emotes - the channel's own set plus BTTV's global one.
//
// Sibling to sevenTv/SevenTvEmotes.js, and here for the same reason: a browser extension draws
// these over the chat, so viewers type them as ordinary text and Twitch's own APIs know nothing
// about them. Left untracked they are counted as WORDS - measured on #mistercop, its BTTV set
// alone had put 10,063 messages' worth of `NOTED`, `pepeSmoke`, `HYPERCLAP` and `catJAM` into
// the word cloud, plus 711 more from the global set.
//
// Channel and global are fetched together and whitelisted under ONE source, because they are
// synced by one call: syncEmoteSource() makes the source's rows exactly match the list it is
// given, so a half-fetched list would delete the other half's rows. Either both fetches
// succeed or this throws and nothing is written - the same all-or-nothing the emote sync chain
// already relies on for its prune.
const axios = require('axios');
const botInitInfo = require('../botInitInfo.js');
const ChatStats = require('../db/chatStats.js');

const API_BASE = 'https://api.betterttv.net/3';

// No auth of any kind: both endpoints are public and unkeyed.
async function fetchGlobalEmoteNames() {
  const { data } = await axios.get(`${API_BASE}/cached/emotes/global`);
  return (data ?? []).map(emote => emote.code).filter(Boolean);
}

// `channelEmotes` are the broadcaster's own uploads, `sharedEmotes` the ones borrowed from other
// channels - both render in this chat, so both count. A broadcaster who has never opened BTTV is
// a 404, which is "no set", not a failure.
async function fetchChannelEmoteNames(broadcasterId) {
  try {
    const { data } = await axios.get(`${API_BASE}/cached/users/twitch/${broadcasterId}`);
    return [...(data?.channelEmotes ?? []), ...(data?.sharedEmotes ?? [])]
      .map(emote => emote.code)
      .filter(Boolean);
  } catch (err) {
    if (err.response?.status === 404) return [];
    throw err;
  }
}

/**
 * Upserts this channel's BTTV emotes (its own set + BTTV's global one) into its whitelist.
 * Leaves every other source's rows alone - see ChatStats.syncEmoteSource().
 */
async function syncBttvEmotes(channel) {
  const login = channel.replace(/^#/, '');
  const broadcasterId = botInitInfo.channels[login]?.id;
  if (!broadcasterId) return null;

  const [globalNames, channelNames] = await Promise.all([
    fetchGlobalEmoteNames(),
    fetchChannelEmoteNames(broadcasterId),
  ]);
  // Same defensive dedupe as the other emote sources: the whitelist's key is {channel, word},
  // and a name shared by the global and channel lists is one row either way.
  const names = [...new Set([...globalNames, ...channelNames])];

  const result = await ChatStats.syncBttvEmotes(channel, names);
  console.log(`[BTTV] Synced ${names.length} emotes for ${channel} (${channelNames.length} channel, ${globalNames.length} global)`);
  return { words: names, ...result };
}

module.exports = { fetchGlobalEmoteNames, fetchChannelEmoteNames, syncBttvEmotes };
