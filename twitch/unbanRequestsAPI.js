// Twitch's unban-request endpoints, plus the one follower lookup the "Бюро разбанов" dossier
// needs. Same shape as twitch/TwitchBanAPI.js: thin axios wrappers, user token, errors logged
// through shared/describeError.js.
//
// All three need the BOT'S USER TOKEN (settings.password), not the app token - they're
// moderator-scoped and Twitch requires moderator_id to equal the token's own user. That's the
// whole reason TwitchBot-Web can't call them itself (its Twitch app has no moderation scopes at
// all - see ../CLAUDE.md's shared-collections table).
//
// Required scopes, granted to the bot account's token:
//   moderator:read:unban_requests    - getUnbanRequests
//   moderator:manage:unban_requests  - resolveUnbanRequest
//   moderator:read:followers         - getFollowedAt
// A 401 here almost always means the token predates one of those and needs re-authorizing (the
// authorize URL is kept in ../../планы.txt).
const axios = require("axios");
const botInitInfo = require("../botInitInfo.js");
const describeError = require("../shared/describeError.js");

const UNBAN_REQUESTS_URL = "https://api.twitch.tv/helix/moderation/unban_requests";
const FOLLOWERS_URL = "https://api.twitch.tv/helix/channels/followers";
const PAGE_SIZE = 100; // Helix max for this endpoint
// A channel with more pending appeals than this has a backlog problem no poller should try to
// drain in one tick; the rest arrive on the next one.
const MAX_PAGES = 10;
// Twitch's own cap on resolution_text.
const MAX_RESOLUTION_TEXT = 500;

function userHeaders() {
  return {
    Authorization: `Bearer ${botInitInfo.settings["password"]}`,
    "Client-Id": botInitInfo.settings["Client_Id"],
  };
}

// Returns every unban request in `status` for the channel, following pagination.
//
// The live response shape does NOT match Twitch's own reference docs (verified 2026-08-02 against
// a real pending request): the docs describe `resolution_status` / `resolution_created_at`, but
// what actually comes back is `status` / `resolved_at`. The fields this mirror reads (`id`,
// `user_id`, `user_login`, `user_name`, `text`, `created_at`) are the same in both, and the caller
// sets twitchStatus itself from the status it asked for - so nothing here depends on the
// difference. Anyone extending this to read the resolution fields should trust the names below,
// not the docs. A resolved request also carries `moderator_id`/`moderator_login` (null while
// pending) - that's Twitch attributing the decision to whoever's token made the PATCH, i.e. this
// bot account; the real human moderator only exists in our own resolution.decidedByLogin.
//   { id, broadcaster_id, broadcaster_name, broadcaster_login,
//     moderator_id, moderator_name, moderator_login,
//     user_id, user_name, user_login,
//     text, status, created_at, resolved_at, resolution_text }
// Throws on failure (the caller - twitch/unbanRequestScheduler.js - logs per channel and moves on;
// swallowing here would make an outage look like "no pending requests", which would in turn make
// markMissingAsResolvedElsewhere() wrongly retire every live case).
async function getUnbanRequests(broadcasterId, status = "pending") {
  const results = [];
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      broadcaster_id: String(broadcasterId),
      moderator_id: String(botInitInfo.settings["bot_id"]),
      status,
      first: String(PAGE_SIZE),
    });
    if (cursor) params.set("after", cursor);

    const response = await axios.get(`${UNBAN_REQUESTS_URL}?${params.toString()}`, {
      headers: userHeaders(),
    });
    results.push(...(response.data.data || []));

    cursor = response.data.pagination?.cursor || null;
    if (!cursor) break;
  }

  return results;
}

// Approves or denies one request. `status` is Twitch's own vocabulary: 'approved' | 'denied'.
// Returns true/false rather than throwing, like TwitchBanAPI.unban() - the scheduler needs to
// distinguish "applied" from "leave it pending and retry next tick".
async function resolveUnbanRequest(broadcasterId, requestId, status, resolutionText) {
  const params = new URLSearchParams({
    broadcaster_id: String(broadcasterId),
    moderator_id: String(botInitInfo.settings["bot_id"]),
    unban_request_id: String(requestId),
    status,
  });
  // Everything is a query parameter on this endpoint, resolution_text included - there is no
  // request body, which is why this PATCH sends `null` as its data argument.
  if (resolutionText) params.set("resolution_text", resolutionText.slice(0, MAX_RESOLUTION_TEXT));

  try {
    await axios.patch(`${UNBAN_REQUESTS_URL}?${params.toString()}`, null, {
      headers: userHeaders(),
    });
    return true;
  } catch (error) {
    console.error(
      `[UnbanRequests] resolve ${status} failed for request ${requestId}:`,
      describeError(error)
    );
    return false;
  }
}

// When `userId` started following `broadcasterId`, or null if they don't follow (or the lookup
// failed - a missing follow date just leaves that dossier line blank, never blocks a review).
// Needs moderator:read:followers; an app token is NOT accepted by this endpoint.
async function getFollowedAt(broadcasterId, userId) {
  const params = new URLSearchParams({
    broadcaster_id: String(broadcasterId),
    user_id: String(userId),
  });

  try {
    const response = await axios.get(`${FOLLOWERS_URL}?${params.toString()}`, {
      headers: userHeaders(),
    });
    const entry = response.data.data?.[0];
    return entry ? new Date(entry.followed_at) : null;
  } catch (error) {
    console.error(
      `[UnbanRequests] follow lookup failed for user ${userId} in ${broadcasterId}:`,
      describeError(error)
    );
    return null;
  }
}

module.exports = {
  getUnbanRequests,
  resolveUnbanRequest,
  getFollowedAt,
  MAX_RESOLUTION_TEXT,
};
