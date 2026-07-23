// Lets a channel newly registered in TwitchBot-Web's `Channels` collection (scripts/seedChannel.js,
// or an approved /request-bot request via /admin) join the ALREADY-RUNNING bot instead of waiting
// for a manual restart. Historically nothing ever re-read that collection after boot - the tmi.js
// `channels` list is fixed at Client construction (see index.js's bootstrap()) - so a freshly
// registered channel just sat in Mongo, unjoined, until someone restarted the process by hand.
//
// This polls the same collection on an interval (same spirit as config/channelSettings.js's 5s
// TTL cache and CustomCommands' 10s refresh, just slower - a new channel is a rare event, not
// something that needs sub-minute latency) and, for every enabled login not yet in
// botInitInfo.channels, runs the same per-channel bring-up index.js's start() runs for every
// channel already known at boot: moderator cache, EventSub, activity tracking, an initial emote
// sync, and - the part a channel known since boot never needs, because those modules already
// seeded it at require time - registering the channel with every module that keeps its own
// per-channel Map/object (commands/CustomCommands.js's Counter and CustomCommands, and the
// games/ modules with a per-channel cooldown). Skipping that last part is what would make this
// dangerous instead of just slow: e.g. CustomCommands.exex_custom_command() iterates
// this.CommandsKeysList[channel], which throws on a channel that was never registered.
const channelsRepo = require('../db/channelsRepo.js');
const botInitInfo = require('../botInitInfo.js');
const moderators = require('./moderators.js');
const eventSub = require('./events.js');
const ActivityTracker = require('./ActivitiTracker.js');
const emoteSyncScheduler = require('./emoteSyncScheduler.js');
const { counter, customCommands } = require('../commands/CustomCommands.js');
const isInsult = require('../games/isInsult.js');
const muteDuel = require('../games/muteDuel.js');
const questionToThisBot = require('../games/questionToThisBot.js');
const randomEvents = require('../games/randomEvents.js');

const POLL_INTERVAL_MS = 60 * 1000;

async function joinChannel(client, login, channelId) {
  botInitInfo.channels[login] = { id: channelId };
  const channel = `#${login}`;

  // Same per-channel state every other module keeping one needs seeded before any message from
  // this channel can be handled safely - mirrors index.js's start() loop.
  await counter.addChannel(channel);
  await customCommands.addChannel(channel);
  isInsult.addChannel(channel);
  muteDuel.addChannel(channel);
  questionToThisBot.addChannel(channel);
  randomEvents.addChannel(channel);

  // Same order/rationale as index.js's start(): moderator cache before EventSub/ActivityTracker
  // so neither reads an empty cache while it loads; emote sync fire-and-forget so a slow/failed
  // 7TV or Helix call can't delay the channel actually joining chat. The EventSub subscription
  // goes onto the bot's single shared socket (twitch/events.js) rather than a new one.
  await moderators.loadFromDatabase(channelId);
  eventSub.addChannel(channelId, channel);
  new ActivityTracker(channelId, channel).start();
  emoteSyncScheduler.syncNow(channel)
    .catch(err => console.error(`[ChannelJoin] Emote sync failed for ${channel}:`, err.message));

  await client.join(login);
  console.log(`[ChannelJoin] Joined ${channel} without a restart.`);
}

function start(client) {
  const interval = setInterval(async () => {
    try {
      const docs = await channelsRepo.listEnabledChannels();
      for (const doc of docs) {
        if (botInitInfo.channels[doc.channelLogin]) continue;
        await joinChannel(client, doc.channelLogin, doc.channelId).catch(err =>
          console.error(`[ChannelJoin] Failed to join #${doc.channelLogin}:`, err.message)
        );
      }
    } catch (err) {
      console.error('[ChannelJoin] Poll failed:', err.message);
    }
  }, POLL_INTERVAL_MS);
  // Don't hold the event loop open - standalone scripts that require modules pulling this one in
  // must still be able to exit, same convention as CustomCommands.startAutoRefresh.
  interval.unref?.();
}

module.exports = { start, joinChannel };
