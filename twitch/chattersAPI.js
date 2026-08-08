// Helix "who is in this channel's chat right now" (GET /helix/chat/chatters), as a standalone
// function. Needs the BOT'S USER TOKEN and moderator:read:chatters, and Twitch requires
// moderator_id to be the token's own user - same constraint as twitch/unbanRequestsAPI.js.
//
// twitch/ActivitiTracker.js already has a working copy of this exact call, but it's an instance
// method on a per-channel tracker and index.js keeps only the LAST-processed channel's instance in
// a module-level `let` - there is no per-channel registry to look one up from. Refactoring that
// working feature just to serve the "Бюро амнистии" sniper (twitch/unbanRequestScheduler.js) would
// be a lot of risk for no benefit, so the pagination pattern is extracted here instead. Called at
// most once per closed vote, never on a scheduler tick - a channel with the sniper off pays nothing.
const axios = require("axios");
const botInitInfo = require("../botInitInfo.js");
const describeError = require("../shared/describeError.js");

const CHATTERS_URL = "https://api.twitch.tv/helix/chat/chatters";
const PAGE_SIZE = 1000; // Helix max for this endpoint
// A chat larger than this is one the sniper can pick from perfectly well already; the cap just
// stops a huge channel from spending ten round trips to pick one random name.
const MAX_PAGES = 10;

// Returns `[{ user_id, user_login, user_name }, ...]`, or `[]` if the lookup failed. Failure is
// deliberately indistinguishable from an empty chat here, unlike unbanRequestsAPI.getUnbanRequests
// (where an outage must not look like "queue empty"): the only caller treats both the same way -
// no eligible target, skip the shot - so there is nothing for it to do with the difference.
async function getChatters(broadcasterId) {
  const chatters = [];
  let cursor = null;

  try {
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        broadcaster_id: String(broadcasterId),
        moderator_id: String(botInitInfo.settings["bot_id"]),
        first: String(PAGE_SIZE),
      });
      if (cursor) params.set("after", cursor);

      const response = await axios.get(`${CHATTERS_URL}?${params.toString()}`, {
        headers: {
          Authorization: `Bearer ${botInitInfo.settings["password"]}`,
          "Client-Id": botInitInfo.settings["Client_Id"],
        },
      });
      chatters.push(...(response.data.data || []));

      // Helix hands back `pagination: {}` rather than omitting it when there's no next page (the
      // same quirk documented in unbanRequestsAPI.js) - check `.cursor`, not the object.
      cursor = response.data.pagination?.cursor || null;
      if (!cursor) break;
    }
    return chatters;
  } catch (error) {
    console.error(
      `[Chatters] Lookup failed for broadcaster ${broadcasterId}:`,
      describeError(error)
    );
    return [];
  }
}

module.exports = { getChatters };
