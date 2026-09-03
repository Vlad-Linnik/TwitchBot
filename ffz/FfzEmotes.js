// FrankerFaceZ emotes - the channel's own sets plus FFZ's global ones.
//
// Third of the browser-extension emote providers, alongside sevenTv/ and bttv/, and untracked
// for the same reason all three were: the extension draws them client-side, so to the bot they
// are plain words. Measured on #mistercop, its FFZ sets had put 7,958 messages' worth of `KEKW`,
// `PepeChill`, `Pog` and `KEKL` into the word cloud.
//
// Channel and global go into ONE whitelist source, fetched together - see bttv/BttvEmotes.js
// for why a half-fetched list must never reach syncEmoteSource().
const axios = require('axios');
const botInitInfo = require('../botInitInfo.js');
const ChatStats = require('../db/chatStats.js');

const API_BASE = 'https://api.frankerfacez.com/v1';

// FFZ ships its emotes as numbered "sets": a response carries a `sets` map plus the list of set
// ids actually enabled. Only the enabled ones render, so only those are emotes here - the global
// response also carries an opt-in effects set (ffzHyper, ffzBounce...) that most viewers never
// turn on, and whitelisting it would let those names out of the word cloud for nobody's benefit.
function namesFromSets(data) {
  const sets = data?.sets ?? {};
  const enabled = Array.isArray(data?.default_sets) && data.default_sets.length > 0
    ? data.default_sets.map(String)
    : Object.keys(sets);
  return enabled
    .flatMap(id => sets[id]?.emoticons ?? [])
    .map(emote => emote.name)
    .filter(Boolean);
}

async function fetchGlobalEmoteNames() {
  const { data } = await axios.get(`${API_BASE}/set/global`);
  return namesFromSets(data);
}

// A channel with no FFZ room is a 404 - "no set", not a failure. Its room sets are all enabled
// by definition (a room lists only what it applies), so `sets` is taken whole here.
async function fetchChannelEmoteNames(broadcasterId) {
  try {
    const { data } = await axios.get(`${API_BASE}/room/id/${broadcasterId}`);
    return Object.values(data?.sets ?? {})
      .flatMap(set => set?.emoticons ?? [])
      .map(emote => emote.name)
      .filter(Boolean);
  } catch (err) {
    if (err.response?.status === 404) return [];
    throw err;
  }
}

/**
 * Upserts this channel's FFZ emotes (its room's sets + FFZ's enabled global ones) into its
 * whitelist. Leaves every other source's rows alone - see ChatStats.syncEmoteSource().
 */
async function syncFfzEmotes(channel) {
  const login = channel.replace(/^#/, '');
  const broadcasterId = botInitInfo.channels[login]?.id;
  if (!broadcasterId) return null;

  const [globalNames, channelNames] = await Promise.all([
    fetchGlobalEmoteNames(),
    fetchChannelEmoteNames(broadcasterId),
  ]);
  const names = [...new Set([...globalNames, ...channelNames])];

  const result = await ChatStats.syncFfzEmotes(channel, names);
  console.log(`[FFZ] Synced ${names.length} emotes for ${channel} (${channelNames.length} channel, ${globalNames.length} global)`);
  return { words: names, ...result };
}

module.exports = { fetchGlobalEmoteNames, fetchChannelEmoteNames, syncFfzEmotes };
