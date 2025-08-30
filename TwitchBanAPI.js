const axios = require("axios");
const botInitInfo = require("./botInitInfo.js");
// max and min values of timeout for twitch
const max_timeout = 1_209_600; // equivalent to 2 weeks
const min_timeout = 1;

// /timeout
async function timeout(userId, duration, broadcasterId, reason = "No reason") {
  const url = `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${botInitInfo["bot_id"]}`;
  const headers = {
    Authorization: `Bearer ${botInitInfo["OAUTHtoken"]}`,
    "Client-Id": botInitInfo["Client_Id"],
    "Content-Type": "application/json",
  };
  const data = {
    data: {
      user_id: userId,
      duration: Math.min(max_timeout, Math.max(min_timeout, duration)),
      reason: reason,
    },
  };

  try {
    await axios.post(url, data, { headers: headers });
  } catch (error) {
    //console.error(error);
  }
}
// /ban
async function ban(userId, broadcasterId, reason = "No reason") {
  const url = `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${botInitInfo["bot_id"]}`;
  const headers = {
    Authorization: `Bearer ${botInitInfo["OAUTHtoken"]}`,
    "Client-Id": botInitInfo["Client_Id"],
    "Content-Type": "application/json",
  };
  const data = {
    data: {
      user_id: userId,
      reason: reason,
    },
  };

  try {
    await axios.post(url, data, { headers: headers });
  } catch (error) {
    console.log("timeout error!");
    //console.error(error);
  }
}

const isMod = (userState) => {
  if (userState["badges"]) {
    if (
      userState["badges"]["broadcaster"] ||
      userState["badges"]["moderator"]
    ) {
      return true;
    }
    return false;
  }
};

module.exports = {
  timeout: timeout,
  isMod: isMod,
  ban: ban,
};
