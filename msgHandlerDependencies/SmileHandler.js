const { SmileRegex } = require("./MyRegex");
function isSmile(client, channel, userState, message) {
  var Smile = message.match(SmileRegex);
  // repeat smile
  if (Smile) {
    if (Smile[1] == "Fishinge") {
      client.say(channel, `@${userState["username"]} voblya `);
      return 1;
    }
    client.say(channel, `@${userState["username"]} ${Smile[1]}`);
    return 1;
  }
  return 0;
}

module.exports = { isSmile: isSmile };
