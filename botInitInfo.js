require('dotenv').config();
const botInitInfo = {
  "username": process.env.BotUsername,
  "password": process.env.password,
  "bot_id": process.env.bot_id,
  "OAUTHtoken": process.env.OAUTHtoken,
  "Client_Id": process.env.Client_Id,
  "password_Not_TMI_Token": process.env.password_Not_TMI_Token,
  "channels": ["mistercop", "floim_", "meowgumin","vlad_261"]
}

module.exports = botInitInfo;
