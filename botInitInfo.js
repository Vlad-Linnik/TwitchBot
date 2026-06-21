require('dotenv').config();
const startTime = new Date();
const settings_cfg = require('./settings.json');


const settings = {
  "username": process.env.BotUsername,
  "bot_id": process.env.bot_id,
  "client_secret": process.env.client_secret,
  "refresh_token": process.env.refresh_token,
  "Client_Id": process.env.Client_Id,
  "password": process.env.password,
  "appAccessToken": null,
  "startTime": startTime
}
const channels = settings_cfg.channels;

module.exports = 
{
  settings: settings, 
  channels: channels
};
