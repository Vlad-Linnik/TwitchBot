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
  "channels": [channel],
  "version": "0.2.1",
  "startTime": startTime
}

module.exports = botInitInfo;
