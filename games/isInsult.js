const Twitch_ban_API = require("../twitch/TwitchBanAPI.js");
const { isMod } = require("../shared/isMod.js");
const { isTimerReady } = require("../shared/timer.js");
const botInitInfo = require("../botInitInfo.js");
const channelSettings = require("../config/channelSettings.js");

var lastInsultTime = new Map();
var extraTime = new Map();
for (channel of Object.keys(botInitInfo.channels)) {
  lastInsultTime.set("#" + channel, 0);
  extraTime.set("#" + channel, 0);
}

function isInsult(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.insult.enabled) return 0;

  message = message.toLowerCase();
  const bannedWordsRegex = channelSettings.getBannedWordsRegex(channel);
  var res = bannedWordsRegex && message.match(bannedWordsRegex);
  if (Boolean(res)) {
    // if bot not a moderator
    if (!client.isMod(channel, "#" + botInitInfo.settings["username"])) {
      client.say(channel, settings.responses.insultBotNotMod, userState["id"]);
      return 1;
    }
    // answer to mods
    if (isMod(userState)) {
      client.say(channel, settings.responses.insultModExempt.random(), userState["id"]);
      return 1;
    } else {
      // accumulative effect
      if (isTimerReady(lastInsultTime.get(channel), settings.commands.insult.cumulativeDelayMs)) {
        extraTime.set(channel, 0);
      } else {
        extraTime.set(channel, 15 + extraTime.get(channel));
      }
      lastInsultTime.set(channel, new Date().getTime());
      //answer to not mod
      var random_x =
        Math.floor(Math.random() * 2038) + 1 + extraTime.get(channel);
      var timeout = Math.floor(1.015 ** random_x / random_x ** 2.66 + 100);
      timeout = Math.min(100_000, timeout);
      Twitch_ban_API.timeout(userState["user-id"], timeout, userState["room-id"], settings.bannedWords.timeoutReason);
    }
    return 1;
  }
  return 0;
}

exports.isInsult = isInsult;
