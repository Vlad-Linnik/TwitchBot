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

const ANNOUNCEMENT_COLORS = ["blue", "green", "orange", "purple", "primary"];

// POST /helix/chat/announcements - sends the message itself as a highlighted, colored system
// message. Unlike pinMessage, this isn't a follow-up action on an already-sent message - it's
// the send itself, so callers use it INSTEAD of client.say, not alongside it. Needs
// moderator:manage:announcements on the bot's own user token (same auth shape as pinMessage).
// Returns whether the send succeeded, so a caller whose token lacks that scope can fall back
// to a plain client.say instead of silently posting nothing.
async function sendAnnouncement(broadcasterId, message, color = "primary") {
  const url = "https://api.twitch.tv/helix/chat/announcements";
  const headers = {
    Authorization: `Bearer ${botInitInfo.settings["password"]}`,
    "Client-Id": botInitInfo.settings["Client_Id"],
    "Content-Type": "application/json",
  };
  const params = {
    broadcaster_id: broadcasterId,
    moderator_id: botInitInfo.settings["bot_id"],
  };
  const body = {
    message,
    color: ANNOUNCEMENT_COLORS.includes(color) ? color : "primary",
  };

  try {
    await axios.post(url, body, { headers, params });
    return true;
  } catch (error) {
    console.error("[API] sendAnnouncement error:", error.response?.data || error.message);
    return false;
  }
}

module.exports = {
  pinMessage: pinMessage,
  sendAnnouncement: sendAnnouncement,
  ANNOUNCEMENT_COLORS,
};