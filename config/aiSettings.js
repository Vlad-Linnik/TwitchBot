// Reader for the single global AiConfig document the admin panel writes (TwitchBot-Web's
// db/aiConfigRepo.js). Same shape of cache as config/channelSettings.js: callers read a possibly
// briefly stale value synchronously and a background refresh keeps it current, so a knob changed
// on the site reaches the running bot within seconds and without a restart.
//
// The per-channel half of this feature (enabled / tone / cheatsheet) is NOT here - it rides along
// in ChannelConfig and is read through channelSettings.getSettings(channel).ai, and the channel
// memory the bot writes for itself is rows in AiChannelMemory rather than a setting at all.
const { connect } = require('../db/db.js');

// Hand-kept in sync with TwitchBot-Web/db/aiConfigRepo.js's DEFAULT_AI_CONFIG. These values are
// what runs when the document does not exist yet or Mongo is unreachable - which is why `enabled`
// is false: an unreachable config must never mean "spend money on defaults".
const DEFAULT_AI_CONFIG = {
  enabled: false,
  model: 'claude-haiku-4-5',
  dailyRequestLimit: 200,
  cooldownMs: 15000,
  timeoutSeconds: 600,
  punishMode: 'observe',
  requestTimeoutMs: 8000,
  memoryPairs: 5,
  memoryTtlDays: 30,
  channelMemoryEnabled: true,
  channelMemoryMax: 25,
  persona: '',
};

const CACHE_TTL_MS = 5000;

let cached = null;
let expiresAt = 0;
let refreshing = null;
let collection;

async function ensureCollection() {
  if (collection) return collection;
  const db = await connect();
  collection = db.collection('AiConfig');
  return collection;
}

function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const col = await ensureCollection();
      const doc = await col.findOne({ _id: 'global' });
      cached = { ...DEFAULT_AI_CONFIG, ...(doc || {}) };
      expiresAt = Date.now() + CACHE_TTL_MS;
    } catch (err) {
      console.error('[aiSettings] Mongo refresh failed:', err.message);
      if (!cached) {
        cached = { ...DEFAULT_AI_CONFIG };
        // No expiry extension on failure: retry on the very next read rather than sitting on
        // defaults (which mean "switched off") for a full TTL after a one-off hiccup.
        expiresAt = 0;
      }
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function get() {
  if (!cached) {
    cached = { ...DEFAULT_AI_CONFIG };
    expiresAt = 0;
    refresh();
    return cached;
  }
  if (Date.now() >= expiresAt) refresh();
  return cached;
}

module.exports = { get, DEFAULT_AI_CONFIG };
