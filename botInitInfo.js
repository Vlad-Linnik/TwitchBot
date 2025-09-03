require('dotenv').config();
const channelEnv = process.env.CHANNEL;
const startTime = new Date();
if (channelEnv) {
  var channel = "vlad_261";
} else {
  var channel = "mistercop";
}

channel = channel.toString();
const botInitInfo = {
  "username": process.env.BotUsername,
  "password": process.env.password,
  "bot_id": process.env.bot_id,
  "OAUTHtoken": process.env.OAUTHtoken,
  "Client_Id": process.env.Client_Id,
  "password_Not_TMI_Token": process.env.password_Not_TMI_Token,
  "channels": [channel],
  "version": "0.1.1",
  "startTime": startTime
}

module.exports = botInitInfo;
