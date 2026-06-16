require('dotenv').config();
const startTime = new Date();


const botInitInfo = {
  "username": process.env.BotUsername,
  "bot_id": process.env.bot_id,
  "client_secret": process.env.client_secret,
  "refresh_token": process.env.refresh_token,
  "Client_Id": process.env.Client_Id,
  "password": null,
  "appAccessToken": null,
  "channels": [process.env.channel],
  "startTime": startTime
}

module.exports = botInitInfo;
