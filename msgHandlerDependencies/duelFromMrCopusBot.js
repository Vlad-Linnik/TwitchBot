const botInitInfo = require("../botInitInfo.js");
// check message form mistercopus_bot
function mcopDuelExecute(client, channel, userState, message) {
  if (userState["username"] == "mistercopus_bot") {
    //!duel
    var res = message.match(/Вас вызывает на дуэль @(\w+)/);
    if (res) {
      client.say(channel, `!accept @${res[1]}`);
      return 1;
    }

    // duel result
    var res = message.match(/Победа за @(\w+)/);
    if (res) {
      var smile = "";
      if (res[1] == botInitInfo["username"]) {
        smile = "EZ ";
      } else {
        smile = "PoroSad";
      }
      client.say(channel, `${smile}`);
      return 1;
    }
  }
  return 0;
}
module.exports = { mcopDuelExecute };
