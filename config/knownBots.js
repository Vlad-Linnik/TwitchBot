// Chat bots that hold moderator status but are not people - their "activity" (presence
// hours, reaction speed, action counts) is machine output and only pollutes the per-human
// moderator statistics on the web panel. This module is the single place that decides who
// counts as a bot; db/chatStats.js consults it before writing ModeratorStatistics /
// ModUpTimeStats rows. Their ModeratorActionLogs entries are still recorded - an automated
// ban is still part of the channel's moderation history (user decision, 2026-07-14).
//
// The list is hand-maintained by LOGIN (stable enough for bot accounts); numeric IDs are
// resolved once at startup via Helix Get Users because every stats write is keyed by userId.
// TwitchBot-Web/config/knownBots.js is a hand-kept copy of the same login list (repos don't
// import from each other - same convention as shared/textStats.js).
const botInitInfo = require('../botInitInfo.js');

const KNOWN_BOT_LOGINS = ['chatwizardbot', 'moobot', 'mistercopus_bot'];

const knownBotIds = new Set();

/**
 * Resolves KNOWN_BOT_LOGINS to numeric user IDs and remembers them for isKnownBot().
 * Call once at startup (index.js). Failure is non-fatal: the bot's own id is seeded from
 * .env regardless, and an unresolved third-party bot just keeps its stats until the next
 * successful start - never a reason to stop the bot from joining channels.
 */
async function resolveKnownBotIds() {
  // Seed the running bot's own id from .env - but ONLY when the account it runs under is
  // actually in the bot list. On the production box that's chatwizardbot, and the seed means
  // even a total Helix outage can't let its activity into the stats. On a dev setup the bot
  // runs under the developer's own HUMAN account (BotUsername=vlad_261 locally) - seeding
  // that id would mark a real person as a bot and delete their stats via the cleanup script.
  const runsAs = String(botInitInfo.settings['username'] || '').toLowerCase();
  if (botInitInfo.settings['bot_id'] && KNOWN_BOT_LOGINS.includes(runsAs)) {
    knownBotIds.add(String(botInitInfo.settings['bot_id']));
  }

  try {
    // Required lazily so standalone scripts can use isKnownBot()/KNOWN_BOT_LOGINS without
    // pulling in the Helix/token machinery.
    const { getUsersByLogin } = require('../twitch/userLookup.js');
    const users = await getUsersByLogin(KNOWN_BOT_LOGINS);
    for (const user of users) knownBotIds.add(String(user.id));
    console.log(`[KnownBots] Resolved ${users.length}/${KNOWN_BOT_LOGINS.length} bot logins to ids`);
  } catch (err) {
    console.error('[KnownBots] Failed to resolve bot logins (their stats will be recorded until next restart):', err.message);
  }
}

function isKnownBot(userId) {
  return knownBotIds.has(String(userId));
}

// For tests/scripts that already know the ids and must not hit Helix.
function addKnownBotId(userId) {
  knownBotIds.add(String(userId));
}

// Snapshot of the resolved ids (for scripts that delete by id, e.g. cleanupModeratorStats.js).
function getKnownBotIds() {
  return [...knownBotIds];
}

module.exports = { KNOWN_BOT_LOGINS, resolveKnownBotIds, isKnownBot, addKnownBotId, getKnownBotIds };
