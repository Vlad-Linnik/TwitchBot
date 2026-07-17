const { isTimerReady } = require("../shared/timer.js");
const { dota2Items } = require("./dota2Items.js");
const randomEventTimeDelay = 3 * 60 * 1000; //3 minutes deley
const botInitInfo = require("../botInitInfo.js");
const streamStatus = require("../twitch/streamStatus.js");

const DOTA2_CATEGORY = "Dota 2";

var lastRandomDota2ItemTime = new Map();
var lastMaaaanEventTime = new Map();
for (channel of Object.keys(botInitInfo.channels)) {
  lastRandomDota2ItemTime.set("#" + channel, 0);
  lastMaaaanEventTime.set("#" + channel, 0);
}

// See games/isInsult.js's addChannel - same reason, same fix.
function addChannel(channel) {
  if (lastRandomDota2ItemTime.has(channel)) return;
  lastRandomDota2ItemTime.set(channel, 0);
  lastMaaaanEventTime.set(channel, 0);
}

function randomEventsAndThings(client, channel, userState, message) {
  var random_things = ["+", "я", "Я", "ну я", "ну, я", "ну Я", "Ну я"];
  if (random_things.includes(message)) {
    if (isTimerReady(lastMaaaanEventTime.get(channel), randomEventTimeDelay)) {
      lastMaaaanEventTime.set(channel, new Date().getTime());
      client.say(channel, message);
      return 1;
    }
    return 1;
  }
  var maaaaan_regex = /@(\w+) maaaaan/;
  resp = message.match(maaaaan_regex);
  if (resp) {
    if (resp[1] != botInitInfo.settings["username"]) {
      if (isTimerReady(lastMaaaanEventTime, randomEventTimeDelay)) {
        lastMaaaanEventTime = new Date().getTime();
        client.say(channel, `@${resp[1]} maaaaan`);
        return 1;
      }
    }
  }
  return 0;
}

function getDota2RandomItem(client, channel, userState, message) {
  if (!message.match(/!совет/)) return 0;

  const broadcasterId = botInitInfo.channels[channel.replace(/^#/, "")]?.id;
  if (streamStatus.getCategory(broadcasterId) !== DOTA2_CATEGORY) return 0;

  if (isTimerReady(lastRandomDota2ItemTime.get(channel), randomEventTimeDelay)) {
    lastRandomDota2ItemTime.set(channel, new Date().getTime());
    client.say(channel, `Советую собрать ${dota2Items["Expensive"].random()}`);
    return 1;
  }
  return 1;
}
module.exports = {
  randomEventsAndThings: randomEventsAndThings,
  getDota2RandomItem: getDota2RandomItem,
  addChannel,
};
