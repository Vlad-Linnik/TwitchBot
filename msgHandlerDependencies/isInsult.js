const Twitch_ban_API = require("../TwitchBanAPI");
const MyRegex = require("./MyRegex");
const { isMod } = require("./isMod");
const { isTimerReady } = require("./timer");
const botInitInfo = require("../botInitInfo.js");

var lastInsultTime = new Map();
var extraTime = new Map();
for (channel in botInitInfo.channels) {
  lastInsultTime.set("#" + botInitInfo.channels[channel], 0);
  extraTime.set("#" + botInitInfo.channels[channel], 0);
}
var cumulativeEffectDelay = 150_000;
var smiles_arr = [
  "mcopDULYA ",
  "FeelsRainMan ",
  "mericCat ",
  "peepoBox ",
  "peepoBanana ",
  "SadgeCry ",
  "NOOOO ",
  "Offline ",
  "peepoRage ",
  "Rasengan ",
  "peepoRIP",
];

function isInsult(client, channel, userState, message) {
  message = message.toLowerCase();
  var res = message.match(MyRegex.insultsRegex);
  if (Boolean(res)) {
    // if bot not a moderator
    if (!client.isMod(channel, "#" + botInitInfo["username"])) {
      client.say(channel, `@${userState["username"]} XyliPizdish `);
      return 1;
    }
    // answer to mods
    if (isMod(userState)) {
      client.say(channel, `@${userState["username"]} ${smiles_arr.random()}`);
      return 1;
    } else {
      // accumulative effect
      if (isTimerReady(lastInsultTime.get(channel), cumulativeEffectDelay)) {
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
      Twitch_ban_API.timeout(userState["user-id"], timeout, userState["room-id"], "не понравился");
    }
    return 1;
  }
  return 0;
}

exports.isInsult = isInsult;
