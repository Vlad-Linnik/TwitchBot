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
  sevenTv: {
    emoteSetUrl: "",
  },
  commands: {
    topchatters: { enabled: true, cooldownMs: 15000, signature: "!topchatters" },
    topsmiles: { enabled: true, cooldownMs: 15000, signature: "!topsmiles" },
    countword: { enabled: true, cooldownMs: 15000, signature: "!countword" },
    countmsg: { enabled: true, cooldownMs: 15000, signature: "!countmsg" },
    countunique: { enabled: true, cooldownMs: 15000, signature: "!countunique" },
    botinfo: { enabled: true, signature: "!botinfo" },
    addword: { enabled: true, signature: "!addword", remSignature: "!remword" },
    addcommand: { enabled: true, signature: "!addcommand" },
    settimer: { enabled: true, signature: "!settimer" },
    setpin: { enabled: true, signature: "!setpin" },
    exception: { enabled: true, signature: "!addexception", remSignature: "!remexception" },
    update7tv: { enabled: true, cooldownMs: 30000, signature: "!update7tv" },
    muteduel: { enabled: true, cooldownMs: 50000, signature: "!muteduel", acceptSignature: "!muteaccept" },
    question: { enabled: true, cooldownMs: 30000 },
    directmsg: { enabled: true, cooldownMs: 15000 },
    insult: { enabled: true, cumulativeDelayMs: 150000 },
    customCommandTimer: { minMessagesBetween: 10 },
    counterUpdate: { cooldownMs: 10000 },
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
const refreshing = new Set();
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
}

// Fire-and-forget: refreshes the cache for `login` from the ChannelConfig collection
// that TwitchBot-Web writes to, falling back to bare DEFAULT_CHANNEL_SETTINGS if no doc
// exists yet or Mongo is unreachable (there's no more per-channel JSON file fallback -
// all channels are expected to have a ChannelConfig doc). Callers always read the
// (possibly briefly stale) cache synchronously via getSettings() and never wait on this.
async function refreshFromMongo(login) {
  if (refreshing.has(login)) return;
  refreshing.add(login);
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

// Builds a regex from a channel-configured command signature (e.g. commands.topchatters.signature)
// instead of a hardcoded trigger word, so channels can rename/alias built-in commands.
function getCommandSignatureRegex(channel, commandName, field = 'signature', { anchored = true } = {}) {
  const signature = getSettings(channel).commands[commandName][field];
  return new RegExp((anchored ? '^' : '') + escapeRegExp(signature.toLowerCase()));
}

// Same as getCommandSignatureRegex but with a trailing arg-capture pattern appended
// (e.g. "!topchatters (\w+)" built from the configured signature).
function getCommandSignatureArgRegex(channel, commandName, argPattern, field = 'signature') {
  const signature = getSettings(channel).commands[commandName][field];
  return new RegExp('^' + escapeRegExp(signature.toLowerCase()) + ' ' + argPattern);
}

function reload() {
  settingsCache.clear();
  bannedWordsRegexCache.clear();
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
