const fs = require('fs');
const path = require('path');

const CHANNELS_DIR = path.join(__dirname, 'channels');
const DEFAULT_FILE = path.join(CHANNELS_DIR, 'default.json');

const settingsCache = new Map();
const bannedWordsRegexCache = new Map();

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

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getSettings(channel) {
  const login = normalizeChannel(channel);
  if (settingsCache.has(login)) return settingsCache.get(login);

  const defaults = loadJson(DEFAULT_FILE);
  const channelFile = path.join(CHANNELS_DIR, `${login}.json`);
  const settings = fs.existsSync(channelFile)
    ? deepMerge(defaults, loadJson(channelFile))
    : defaults;

  settingsCache.set(login, settings);
  return settings;
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
