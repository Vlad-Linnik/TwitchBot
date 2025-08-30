const { isTimerReady } = require("./timer.js");
const { dota2Items } = require("./dota2Items.js");
const randomEventTimeDelay = 150_000; //milliseconds delay
const botInitInfo = require("../botInitInfo.js");

var lastRandomDota2ItemTime = new Map();
var lastMaaaanEventTime = new Map();
for (var i = 0; i < botInitInfo.channels.length; i++) {
  lastRandomDota2ItemTime.set("#" + botInitInfo.channels[i], 0);
  lastMaaaanEventTime.set("#" + botInitInfo.channels[i], 0);
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
    if (resp[1] != botInitInfo["username"]) {
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
  if (
    message.match(/!совет/) &&
    isTimerReady(lastRandomDota2ItemTime.get(channel), randomEventTimeDelay)
  ) {
    lastRandomDota2ItemTime.set(channel, new Date().getTime());
    client.say(channel, `Советую собрать ${dota2Items["Expensive"].random()}`);
    return 1;
  }
  return 0;
}
module.exports = {
  randomEventsAndThings: randomEventsAndThings,
  getDota2RandomItem: getDota2RandomItem,
};
