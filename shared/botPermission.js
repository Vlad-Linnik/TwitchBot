const botInitInfo = require("../botInitInfo.js");

// Checks whether the bot itself currently holds moderator status in `channel`
// (distinct from shared/isMod.js, which checks a message *author's* badges).
function botHasMod(client, channel) {
  return client.isMod(channel, "#" + botInitInfo.settings["username"]);
}

// If the bot lacks the moderator privileges an action needs, replies with the
// channel's configured message and returns true so the caller can bail.
// Centralizes what used to be a one-off check duplicated per call site.
function replyIfBotLacksMod(client, channel, userState, settings) {
  if (botHasMod(client, channel)) return false;
  client.say(channel, settings.responses.insufficientPermissions, userState["id"]);
  return true;
}

exports.botHasMod = botHasMod;
exports.replyIfBotLacksMod = replyIfBotLacksMod;
