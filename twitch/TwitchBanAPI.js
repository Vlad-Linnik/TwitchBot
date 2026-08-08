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

// Which of `userIds` are currently banned or timed out on `broadcasterId`, according to Twitch
// itself - not our own records, so this also catches a ban/timeout issued by a human moderator
// through Twitch's native UI, which this bot would never otherwise know about. Used by the Бюро
// амнистии sniper (twitch/unbanRequestScheduler.js) so it can't "shoot" someone who's already gone.
// Chunked at Helix's own limit of 100 user_id params per call; the sniper's candidate pool (chatters
// active in the last minute) is realistically far smaller, so this is normally a single request.
async function getBannedUserIds(userIds, broadcasterId) {
  const ids = [...new Set(userIds.map(String))];
  if (!ids.length) return new Set();

  const CHUNK = 100;
  const banned = new Set();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const params = new URLSearchParams({ broadcaster_id: String(broadcasterId) });
    chunk.forEach(id => params.append('user_id', id));
    const headers = {
      Authorization: `Bearer ${botInitInfo.settings["password"]}`,
      "Client-Id": botInitInfo.settings["Client_Id"],
    };

    try {
      const response = await axios.get(`https://api.twitch.tv/helix/moderation/banned?${params.toString()}`, { headers });
      for (const row of response.data.data || []) banned.add(String(row.user_id));
    } catch (error) {
      console.error("[TwitchBanAPI] getBannedUserIds lookup failed:", describeError(error));
    }
  }
  return banned;
}

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
  getBannedUserIds,
};
