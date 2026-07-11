// Twitch login <-> numeric user ID conversion via the Helix "Get Users" endpoint.
// https://dev.twitch.tv/docs/api/reference/#get-users
const axios = require("axios");
const botInitInfo = require("../botInitInfo.js");
const TokenManager = require("./TokenManager.js");

const HELIX_USERS_URL = "https://api.twitch.tv/helix/users";
const MAX_PER_REQUEST = 100; // Helix caps login/id params at 100 per call

function chunk(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

// Get Users accepts an app access token, which only needs the static client_id/client_secret
// (no refresh-token dance) - fetch one on demand so this also works from a standalone script
// where TokenManager's background refresh loop (started only by index.js) never ran.
async function ensureAppAccessToken() {
  if (!botInitInfo.settings["appAccessToken"]) {
    await TokenManager.getAppAccessToken();
  }
  return botInitInfo.settings["appAccessToken"];
}

async function fetchUsers(paramName, values) {
  if (!values.length) return [];
  const headers = {
    Authorization: `Bearer ${await ensureAppAccessToken()}`,
    "Client-Id": botInitInfo.settings["Client_Id"],
  };
  const results = [];
  for (const batch of chunk(values, MAX_PER_REQUEST)) {
    const params = new URLSearchParams();
    for (const value of batch) params.append(paramName, value);
    const response = await axios.get(`${HELIX_USERS_URL}?${params.toString()}`, { headers });
    results.push(...response.data.data);
  }
  return results;
}

// logins (usernames) -> [{id, login, display_name, ...}]. Unmatched logins are simply absent
// from the result (Twitch doesn't error on unknown logins).
async function getUsersByLogin(logins) {
  const normalized = logins.map((login) => login.trim().toLowerCase()).filter(Boolean);
  return fetchUsers("login", normalized);
}

// numeric user IDs -> [{id, login, display_name, ...}]
async function getUsersById(ids) {
  const normalized = ids.map((id) => `${id}`.trim()).filter(Boolean);
  return fetchUsers("id", normalized);
}

module.exports = { getUsersByLogin, getUsersById };
