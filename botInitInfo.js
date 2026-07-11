require('dotenv').config();
const startTime = new Date();
const channelsRepo = require('./db/channelsRepo.js');


const settings = {
  "username": process.env.BotUsername,
  "bot_id": process.env.bot_id,
  "client_secret": process.env.client_secret,
  "refresh_token": process.env.refresh_token,
  "Client_Id": process.env.Client_Id,
  "password": process.env.password,
  "appAccessToken": null,
  "startTime": startTime,
  "debug": process.env.DEBUG_MODE === 'true'
}

// Populates module.exports.channels from TwitchBot-Web's `Channels` collection
// (the login->numeric-ID map the bot needs for Helix calls). Must be awaited
// before requiring any module that reads botInitInfo.channels at its own top
// level (several games/*.js and commands/CustomCommands.js pre-seed per-channel
// Maps at require time) - see index.js's bootstrap(). There's no file-based
// fallback anymore (config/settings.json is gone) - if Mongo has no enabled
// channels or is unreachable, the bot has nothing to join, so this fails fast
// rather than silently starting with an empty channel list.
async function loadChannels() {
  const docs = await channelsRepo.listEnabledChannels();
  if (docs.length === 0) {
    throw new Error('[botInitInfo] No enabled channels found in the Channels collection - nothing to join.');
  }
  const channels = {};
  for (const doc of docs) channels[doc.channelLogin] = { id: doc.channelId };
  module.exports.channels = channels;
}

module.exports =
{
  settings: settings,
  channels: {},
  loadChannels: loadChannels,
};
