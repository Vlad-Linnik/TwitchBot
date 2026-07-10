const axios = require("axios");
const botInitInfo = require("../botInitInfo.js");

// PUT /helix/chat/pins - pins until the stream ends (no duration_seconds passed).
// Uses the moderator user token (like TwitchBanAPI) since this requires the
// moderator:manage:chat_messages scope.
async function pinMessage(broadcasterId, messageId) {
  const url = "https://api.twitch.tv/helix/chat/pins";
  const headers = {
    Authorization: `Bearer ${botInitInfo.settings["password"]}`,
    "Client-Id": botInitInfo.settings["Client_Id"],
    "Content-Type": "application/json",
  };
  const params = {
    broadcaster_id: broadcasterId,
    moderator_id: botInitInfo.settings["bot_id"],
    message_id: messageId,
  };

  try {
    await axios.put(url, null, { headers, params });
  } catch (error) {
    console.error("[API] pinMessage error:", error.response?.data || error.message);
  }
}

module.exports = {
  pinMessage: pinMessage,
};