const axios = require("axios");
const botInitInfo = require("../botInitInfo.js");
const describeError = require("../shared/describeError.js");

const max_timeout = 1_209_600; // equivalent to 2 weeks
const min_timeout = 1;

// /timeout
async function timeout(userId, duration, broadcasterId, reason = "No reason") {
  const url = `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${botInitInfo.settings["bot_id"]}`;
  const headers = {
    Authorization: `Bearer ${botInitInfo.settings["password"]}`,
    "Client-Id": botInitInfo.settings["Client_Id"],
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
  }
}
// /ban
async function ban(userId, broadcasterId, reason = "No reason") {
  const url = `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${botInitInfo.settings["bot_id"]}`;
  const headers = {
    Authorization: `Bearer ${botInitInfo.settings["password"]}`,
    "Client-Id": botInitInfo.settings["Client_Id"],
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
  }
}

// NOTE: there is deliberately no "is this user banned?" reader here. Helix's Get Banned Users
// (GET /helix/moderation/banned) is the only endpoint that answers it, and it requires
// `broadcaster_id` to equal the user id in the access token - a moderator token asking about a
// channel it merely moderates is answered 401 "incorrect user authorization" at any scope. One
// lived here until 2026-08-12 and failed exactly that way on every prod call, returning an empty
// set (i.e. "nobody is banned") each time. The Бюро амнистии sniper, its only caller, now asks
// db/chatStats.js's getPunishedUserIds() instead - our own EventSub-fed ModeratorActionLogs, which
// does see bans issued by human moderators through Twitch's native UI. Don't reintroduce this
// without a broadcaster's own token, which this bot does not have.

// /unban (also lifts an active timeout - same Twitch mechanism under the hood)
// Unlike timeout()/ban() above, this returns true/false instead of swallowing silently: both
// callers (twitch/longBanScheduler.js and commands/longBan.js's cancel handler) need to know
// whether the unban actually happened rather than optimistically assuming success.
async function unban(userId, broadcasterId) {
  const url = `https://api.twitch.tv/helix/moderation/bans?broadcaster_id=${broadcasterId}&moderator_id=${botInitInfo.settings["bot_id"]}&user_id=${userId}`;
  const headers = {
    Authorization: `Bearer ${botInitInfo.settings["password"]}`,
    "Client-Id": botInitInfo.settings["Client_Id"],
  };

  try {
    await axios.delete(url, { headers: headers });
    return true;
  } catch (error) {
    console.error("[TwitchBanAPI] unban failed:", describeError(error));
    return false;
  }
}

module.exports = {
  timeout: timeout,
  ban: ban,
  unban: unban,
};
