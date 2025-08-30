const { isTimerReady } = require("./timer.js");
const botInitInfo = require("../botInitInfo.js");
var lastQuestionTime = new Map();
for (channel in botInitInfo.channels) {
  lastQuestionTime.set("#" + botInitInfo.channels[channel], 0);
}
var questionTimeDelay = 30_000;
function question(client, channel, userState, message) {
  if (message.includes("?")) {
    // timer
    if (isTimerReady(lastQuestionTime.get(channel), questionTimeDelay)) {
      client.say(
        channel,
        `@${userState["username"]} ${[
          "Да",
          "Нет",
          "Не могу сказать",
          "eeeh ",
        ].random()}`
      );
      lastQuestionTime.set(channel, new Date().getTime());
      return 1;
    }
    return 0;
  }
}

module.exports = {
  question,
};
