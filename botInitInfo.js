require('dotenv').config();
const axios = require('axios');
const startTime = new Date();
const channelsRepo = require('./db/channelsRepo.js');

// Node's HTTP client has NO default timeout, and neither does axios: a request that stalls at the
// network level (a flaky route to Twitch, a DNS hiccup) blocks until the OS gives up - about 130s
// on Linux with the default tcp_syn_retries=6. That is not a theoretical concern here. On
// 2026-07-24 two such stalls inside TokenManager.start() alone stretched startup to ~280s, which
// collided with index.js's 5-minute watchdog: the process was killed before tmi.js ever connected,
// pm2 restarted it, and it stalled again - a loop that could not break itself. Every Twitch/7TV
// call in this bot is a small REST request that answers in well under a second when the network is
// healthy, so a bounded failure is strictly better than an unbounded wait.
// axios is a module singleton, so setting this once here covers every caller in the process, and
// every entry point (index.js and scripts/) requires this module.
const HTTP_TIMEOUT_MS = 15000;
axios.defaults.timeout = HTTP_TIMEOUT_MS;

// No explicit http(s).Agent is set here on purpose. Node 19 flipped `http(s).globalAgent` to
// `keepAlive: true`, axios passes no agent of its own and so inherits it, and prod runs Node 20 -
// verified empirically (three sequential Helix calls reuse the same local port). Pinning an agent
// with the same options would be a no-op. Worth re-checking only if the box's Node is ever
// downgraded below 19, where the default is the opposite and every Helix call - including each
// chat message send - would open a fresh TCP+TLS connection.


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
