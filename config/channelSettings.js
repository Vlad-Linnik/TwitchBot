const { connect } = require('../db/db.js');

const CACHE_TTL_MS = 5000;

// Baseline command signatures/cooldowns/responses every channel's settings are deep-merged
// over. This used to live in config/channels/default.json - moved inline since it's
// schema/baseline code, not per-channel data (kept in sync by hand with TwitchBot-Web's
// config/defaultChannelConfig.json, same as before).
const DEFAULT_CHANNEL_SETTINGS = {
  bannedWords: {
    words: ["example_curse_word"],
    timeoutReason: "",
  },
  spamSignatures: ["example_spam_signature"],
  spamBanReason: "spam bot",
  commands: {
    topchatters: { enabled: true, cooldownMs: 15000, signature: "!topchatters" },
    topsmiles: { enabled: true, cooldownMs: 15000, signature: "!topsmiles" },
    countword: { enabled: true, cooldownMs: 15000, signature: "!countword" },
    countmsg: { enabled: true, cooldownMs: 15000, signature: "!countmsg" },
    countunique: { enabled: true, cooldownMs: 15000, signature: "!countunique" },
    botinfo: { enabled: true, signature: "!botinfo" },
    addcommand: { enabled: true, signature: "!addcommand" },
    delcommand: { enabled: true, signature: "!delcommand" },
    settimer: { enabled: true, signature: "!settimer" },
    setpin: { enabled: true, signature: "!setpin" },
    setannounce: { enabled: true, signature: "!setannounce" },
    addcounter: { enabled: true, signature: "!addcounter" },
    delcounter: { enabled: true, signature: "!delcounter" },
    exception: { enabled: true, signature: "!addexception", remSignature: "!remexception" },
    update7tv: { enabled: true, cooldownMs: 30000, signature: "!update7tv" },
    randomclip: { enabled: true, cooldownMs: 30000, signature: "!randomclip" },
    weather: { enabled: true, cooldownMs: 15000, signature: "!weather", defaultCity: "" },
    muteduel: { enabled: true, cooldownMs: 50000, signature: "!muteduel", acceptSignature: "!muteaccept" },
    longban: { enabled: true, signature: "!longban" },
    cancellongban: { enabled: true, signature: "!cancellongban" },
    longbans: { enabled: true, signature: "!longbans" },
    question: { enabled: true, cooldownMs: 30000 },
    directmsg: { enabled: true, cooldownMs: 15000 },
    insult: { enabled: true, cumulativeDelayMs: 150000 },
    customCommandTimer: { minMessagesBetween: 10 },
    counterUpdate: { cooldownMs: 10000 },
  },
  // "Бюро амнистии" - TwitchBot-Web's /unban-bureau review page and the advisory chat vote a
  // moderator can start from it (twitch/unbanRequestScheduler.js, games/unbanVote.js).
  // `enabled: false` by default: mirroring a channel's unban requests means polling Helix for it
  // every minute, which no channel should pay for until its owner actually turns the page on.
  //
  // The `sniper*` fields describe the "stray bullet" - a random chatter punished by a shot a
  // MODERATOR fires by hand at the review desk. The bot never fires one on its own, so there is no
  // `sniperEnabled`: it was removed 2026-08-08 along with the last of an earlier design where the
  // shot went off automatically whenever a chat vote closed. These three only say what the shot does
  // to whoever it hits. Nested under `unbanBureau` because the rifle lives on that page and nowhere
  // else. TwitchBot-Web/config/defaultChannelConfig.json is a hand-kept copy of this block.
  unbanBureau: {
    enabled: false,
    // Twitch GLOBAL emotes (verified `source: twitch-global` in the whiteList), so every viewer can
    // type them without a sub or 7TV - which is the whole reason a vote emote has to be global.
    voteApproveEmote: "VoteYea",
    voteDenyEmote: "VoteNay",
    voteDurationSec: 60,
    sniperMode: "timeout", // 'timeout' | 'ban'
    sniperTimeoutSec: 60, // ignored when sniperMode === 'ban'
    sniperReason: "Шальная пуля Бюро амнистии",
  },
  responses: {
    busy: ["I am busy"],
    yesNo: ["Да", "Нет", "Не могу сказать", "eeeh ", "Возможно", "50/50", "Скорее да, чем нет"],
    insultModExempt: ["("],
    insufficientPermissions: "У меня нет прав модератора для этого действия.",
  },
};

// login -> { settings, expiresAt }
const settingsCache = new Map();
const bannedWordsRegexCache = new Map();
// login -> Map<cacheKey, RegExp>, compiled by getCommandSignatureRegex/getCommandSignatureArgRegex.
// Every built-in command handler calls one of those on every chat message it looks at (see
// commands/msgHandle.js's execCommands), and until this cache existed each call did a fresh
// `new RegExp(...)` from the signature string - wasted work, since a channel's signatures only
// change when its settings are edited (rare), same cache-per-login-until-refresh lifetime as
// bannedWordsRegexCache right above.
const signatureRegexCache = new Map();
const refreshing = new Map(); // login -> in-flight refresh promise (dedupes concurrent refreshFromMongo calls)
let channelConfigCollection;

function normalizeChannel(channel) {
  return channel.toLowerCase().replace('#', '');
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    result[key] = isPlainObject(base[key]) && isPlainObject(override[key])
      ? deepMerge(base[key], override[key])
      : override[key];
  }
  return result;
}

async function ensureCollection() {
  if (channelConfigCollection) return channelConfigCollection;
  const db = await connect();
  channelConfigCollection = db.collection('ChannelConfig');
  return channelConfigCollection;
}

function setCache(login, settings, ttlMs = CACHE_TTL_MS) {
  settingsCache.set(login, { settings, expiresAt: Date.now() + ttlMs });
  bannedWordsRegexCache.delete(login);
  signatureRegexCache.delete(login);
}

// Fire-and-forget: refreshes the cache for `login` from the ChannelConfig collection
// that TwitchBot-Web writes to, falling back to bare DEFAULT_CHANNEL_SETTINGS if no doc
// exists yet or Mongo is unreachable (there's no more per-channel JSON file fallback -
// all channels are expected to have a ChannelConfig doc). Callers always read the
// (possibly briefly stale) cache synchronously via getSettings() and never wait on this.
function refreshFromMongo(login) {
  if (refreshing.has(login)) return refreshing.get(login);
  const promise = (async () => {
    try {
      const col = await ensureCollection();
      const doc = await col.findOne({ channelLogin: login });
      const settings = doc ? deepMerge(DEFAULT_CHANNEL_SETTINGS, doc) : DEFAULT_CHANNEL_SETTINGS;
      setCache(login, settings);
    } catch (err) {
      console.error(`[channelSettings] Mongo refresh failed for "${login}":`, err.message);
      if (!settingsCache.has(login)) setCache(login, DEFAULT_CHANNEL_SETTINGS, 0);
    } finally {
      refreshing.delete(login);
    }
  })();
  refreshing.set(login, promise);
  return promise;
}

function getSettings(channel) {
  const login = normalizeChannel(channel);
  const cached = settingsCache.get(login);

  if (!cached) {
    setCache(login, DEFAULT_CHANNEL_SETTINGS, 0);
    refreshFromMongo(login);
    return settingsCache.get(login).settings;
  }

  if (Date.now() >= cached.expiresAt) {
    refreshFromMongo(login);
  }

  return cached.settings;
}

function escapeRegExp(word) {
  return word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
}

// Built once per channel and cached - the message-level match in isInsult.js
// already lowercases its input, so no 'i' flag is needed here.
function getBannedWordsRegex(channel) {
  const login = normalizeChannel(channel);
  if (bannedWordsRegexCache.has(login)) return bannedWordsRegexCache.get(login);

  const words = getSettings(channel).bannedWords.words;
  const regex = words.length > 0 ? new RegExp(words.map(escapeRegExp).join('|')) : null;

  bannedWordsRegexCache.set(login, regex);
  return regex;
}

// Shared cache lookup for the two functions below: `build` only runs on a miss, and the result is
// kept until setCache() (a settings write or a periodic refresh) invalidates the whole per-login
// entry - the same lifetime bannedWordsRegexCache already uses.
function getCachedSignatureRegex(login, cacheKey, build) {
  let channelCache = signatureRegexCache.get(login);
  if (!channelCache) {
    channelCache = new Map();
    signatureRegexCache.set(login, channelCache);
  }
  let regex = channelCache.get(cacheKey);
  if (!regex) {
    regex = build();
    channelCache.set(cacheKey, regex);
  }
  return regex;
}

// Builds a regex from a channel-configured command signature (e.g. commands.topchatters.signature)
// instead of a hardcoded trigger word, so channels can rename/alias built-in commands.
//
// The trailing `(?:\s|$)` requires a word boundary right after the signature - without it,
// "!topchattersfoo" matched "!topchatters" too (a plain string-prefix test with no end marker),
// so a mistyped or unrelated longer word could spuriously fire a command. getCommandSignatureArgRegex
// below doesn't need this itself - the literal space it already requires before argPattern serves
// the same purpose.
function getCommandSignatureRegex(channel, commandName, field = 'signature', { anchored = true } = {}) {
  const login = normalizeChannel(channel);
  const signature = getSettings(channel).commands[commandName][field];
  const cacheKey = `${commandName}|${field}|${anchored ? 1 : 0}`;
  return getCachedSignatureRegex(login, cacheKey, () =>
    new RegExp((anchored ? '^' : '') + escapeRegExp(signature.toLowerCase()) + '(?:\\s|$)')
  );
}

// Same as getCommandSignatureRegex but with a trailing arg-capture pattern appended
// (e.g. "!topchatters (\w+)" built from the configured signature). argPattern is always one of a
// handful of literals hardcoded at each call site (never user input), so it's safe to fold into
// the cache key as-is.
function getCommandSignatureArgRegex(channel, commandName, argPattern, field = 'signature') {
  const login = normalizeChannel(channel);
  const signature = getSettings(channel).commands[commandName][field];
  const cacheKey = `${commandName}|${field}|arg:${argPattern}`;
  return getCachedSignatureRegex(login, cacheKey, () =>
    new RegExp('^' + escapeRegExp(signature.toLowerCase()) + ' ' + argPattern)
  );
}

function reload() {
  settingsCache.clear();
  bannedWordsRegexCache.clear();
  signatureRegexCache.clear();
}

module.exports = {
  getSettings,
  getBannedWordsRegex,
  getCommandSignatureRegex,
  getCommandSignatureArgRegex,
  escapeRegExp,
  normalizeChannel,
  reload,
};
