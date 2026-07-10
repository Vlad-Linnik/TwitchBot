// Shared per-channel moderator-list cache, analogous to streamStatus.js. This is the single
// source of truth for "who currently moderates this channel" in memory - anything that needs
// that answer reads it synchronously via getModerators()/isModerator() instead of hitting the
// DB itself.
//
// Twitch's canonical moderator list (GET /helix/moderation/moderators) requires a token owned
// by the broadcaster themselves - the bot only ever holds its own (moderator) token, so that
// endpoint isn't reachable here. The DB (ModsList collection) is therefore the real source of
// truth, built up incrementally from `channel.moderate` mod/unmod EventSub notifications; this
// cache is just an in-memory mirror of it, loaded once at startup and kept current by the same
// add/removeModerator calls events.js already makes.
//
// Caveat: because there's no ground truth to reconcile against, any mod/unmod change that
// happens while the bot is disconnected (or a moderator added before the bot ever ran) is
// invisible to both the DB and this cache until another mod/unmod event touches that same user.
const ChatStats = require('../db/chatStats.js');

const moderatorsByChannel = new Map(); // channelId (string) -> Set<userId>

function getModerators(channelId) {
  return moderatorsByChannel.get(`${channelId}`) || new Set();
}

function isModerator(channelId, userId) {
  return getModerators(channelId).has(userId);
}

function addModerator(channelId, userId) {
  const key = `${channelId}`;
  if (!moderatorsByChannel.has(key)) moderatorsByChannel.set(key, new Set());
  moderatorsByChannel.get(key).add(userId);
  ChatStats.addModerator(key, userId).catch(err => console.error('[Moderators] addModerator error:', err));
}

function removeModerator(channelId, userId) {
  const key = `${channelId}`;
  moderatorsByChannel.get(key)?.delete(userId);
  ChatStats.removeModerator(key, userId).catch(err => console.error('[Moderators] removeModerator error:', err));
}

// Seeds the cache from the DB. Call once per channel at startup, before anything else needs
// getModerators() for that channel - the cache stays empty (not an error) for a channel this
// hasn't been called for yet.
async function loadFromDatabase(channelId) {
  const key = `${channelId}`;
  const doc = await ChatStats.getModeratorsList(key);
  moderatorsByChannel.set(key, new Set(doc?.moderators || []));
  return moderatorsByChannel.get(key);
}

module.exports = { getModerators, isModerator, addModerator, removeModerator, loadFromDatabase };
