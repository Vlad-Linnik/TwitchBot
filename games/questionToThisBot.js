const { isTimerReady } = require("../shared/timer.js");
const botInitInfo = require("../botInitInfo.js");
const channelSettings = require("../config/channelSettings.js");
var lastQuestionTime = new Map();
for (channel of Object.keys(botInitInfo.channels)) {
  lastQuestionTime.set("#" + channel, 0);
}
function question(client, channel, userState, message) {
  if (message.includes("?")) {
    const settings = channelSettings.getSettings(channel);
    if (!settings.commands.question.enabled) return 0;
    // timer
    if (isTimerReady(lastQuestionTime.get(channel), settings.commands.question.cooldownMs)) {
      client.say(
        channel,
        settings.responses.yesNo.random(),
        userState["id"]
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
