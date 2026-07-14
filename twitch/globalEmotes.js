// Twitch's official GLOBAL emotes (Kappa, LUL, PogChamp, ...) via Helix "Get Global Emotes".
// https://dev.twitch.tv/docs/api/reference/#get-global-emotes
//
// Why this exists alongside sevenTv/SevenTvEmotes.js: the whitelist is what decides which tokens
// get counted as emotes (db/chatStats.js's addMessage), and until now it only ever contained a
// channel's 7TV set. That meant a channel with no 7TV set tracked ZERO emotes - and it also meant
// Twitch's own emotes, which every chat uses, were being counted as ordinary *words* in the word
// cloud. Tracking them fixes both ends at once.
//
// Two properties of this endpoint shape the design:
//   - it needs only an APP access token (client_id/client_secret), no user scope - same as
//     twitch/userLookup.js, so the token handling is borrowed from there;
//   - the list is GLOBAL and changes rarely (Twitch adds emotes a few times a year), so it is
//     fetched once per process and reused for every channel rather than re-requested per channel.
const axios = require('axios');
const botInitInfo = require('../botInitInfo.js');
const TokenManager = require('./TokenManager.js');
const ChatStats = require('../db/chatStats.js');

const HELIX_GLOBAL_EMOTES_URL = 'https://api.twitch.tv/helix/chat/emotes/global';

// Fetched once per process. Global emotes don't change during a bot's lifetime, and re-requesting
// them for every channel would burn rate limit for an identical answer.
let cachedNames = null;

// Mirrors twitch/userLookup.js: fetch an app token on demand so this also works from a standalone
// script, where TokenManager's background refresh loop (started only by index.js) never ran.
async function ensureAppAccessToken() {
  if (!botInitInfo.settings['appAccessToken']) {
    await TokenManager.getAppAccessToken();
  }
  return botInitInfo.settings['appAccessToken'];
}

/**
 * The names of Twitch's global emotes, as they are actually typed in chat.
 * @param {boolean} [force] - bypass the process cache (for a manual refresh command)
 * @returns {Promise<string[]>}
 */
async function fetchGlobalEmoteNames(force = false) {
  if (cachedNames && !force) return cachedNames;

  const response = await axios.get(HELIX_GLOBAL_EMOTES_URL, {
    headers: {
      Authorization: `Bearer ${await ensureAppAccessToken()}`,
      'Client-Id': botInitInfo.settings['Client_Id'],
    },
  });

  // Deduplicated, and that is not defensive boilerplate - Helix genuinely returns the same NAME
  // more than once. As of writing it ships 303 entries but only 290 distinct names: the classic
  // text emoticons (":)", ":(", ":D", "<3", "O_o", "B)", ...) each appear twice under different
  // emote IDs. The whitelist's unique key is {channel, word}, so the duplicates would collapse in
  // Mongo anyway - but silently, after issuing 13 pointless upserts and logging a count ("synced
  // 303") that never matches the rows that actually exist.
  const names = (response.data?.data ?? []).map((emote) => emote.name).filter(Boolean);
  cachedNames = [...new Set(names)];
  // The one log line for global emotes: the list is identical for every channel, so logging it
  // once per FETCH (not once per channel synced) is what matches reality.
  console.log(`[TwitchEmotes] Fetched ${cachedNames.length} global emotes (shared across all channels)`);
  return cachedNames;
}

/**
 * Upserts Twitch's global emotes into one channel's whitelist under source 'twitch-global'.
 *
 * Per-channel rows for a global list looks redundant, and is deliberate: the counters these feed
 * (`words`, `WordLifetimeStats`) are per-channel, so "how often was Kappa used" only means
 * anything scoped to a channel. The FETCH is shared; only the rows are per-channel.
 *
 * Leaves 'manual' (legacy !addword rows) and '7tv' rows untouched - see ChatStats.syncEmoteSource().
 */
async function syncGlobalEmotes(channel) {
  const words = await fetchGlobalEmoteNames();
  if (words.length === 0) return null;

  const result = await ChatStats.syncTwitchGlobalEmotes(channel, words);
  // Per-channel sync stays silent unless something actually changed for that channel - the
  // shared fetch above already logged the list once, and N identical "synced 289" lines were
  // just noise implying N fetches that never happened.
  if (result.removed) {
    console.log(`[TwitchEmotes] ${channel}: removed ${result.removed} stale global emotes`);
  }
  return { words, ...result };
}

module.exports = { fetchGlobalEmoteNames, syncGlobalEmotes };
