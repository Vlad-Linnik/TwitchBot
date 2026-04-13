require('dotenv').config();
const startTime = new Date();


const botInitInfo = {
  "username": process.env.BotUsername,
  "password": process.env.password,
  "bot_id": process.env.bot_id,
  "OAUTHtoken": process.env.OAUTHtoken,
  "Client_Id": process.env.Client_Id,
  "channels": [process.env.channel],
  "version": "0.2.3a",
  "startTime": startTime
}

module.exports = botInitInfo;
