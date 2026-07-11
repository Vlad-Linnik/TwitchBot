require('dotenv').config();
const startTime = new Date();
const settings_cfg = require('./config/settings.json');
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
// (the login->numeric-ID map the bot needs for Helix calls), falling back to
// config/settings.json if no channel is registered there yet or Mongo is
// unreachable. Must be awaited before requiring any module that reads
// botInitInfo.channels at its own top level (several games/*.js and
// commands/CustomCommands.js pre-seed per-channel Maps at require time) -
// see index.js's bootstrap().
async function loadChannels() {
  try {
    const docs = await channelsRepo.listEnabledChannels();
    if (docs.length > 0) {
      const channels = {};
      for (const doc of docs) channels[doc.channelLogin] = { id: doc.channelId };
      module.exports.channels = channels;
      return;
    }
  } catch (err) {
    console.error('[botInitInfo] Failed to load channels from Mongo, falling back to config/settings.json:', err.message);
  }
  module.exports.channels = settings_cfg.channels;
}

module.exports =
{
  settings: settings,
  channels: settings_cfg.channels,
  loadChannels: loadChannels,
};
