// One-off tool: resolve a string of Twitch usernames to numeric IDs (via twitch/userLookup.js)
// and add them to a channel's ModsList in the database.
// Usage: node scripts/AddModerators.js <channel> "name1, name2 name3"
const botInitInfo = require("../botInitInfo.js");
const ChatStats = require("../db/chatStats.js");
const { getUsersByLogin } = require("../twitch/userLookup.js");

function parseNames(raw) {
  return raw
    .split(/[\s,]+/)
    .map((name) => name.replace(/^@/, "").trim())
    .filter(Boolean);
}

async function main() {
  const [channelArg, namesArg] = process.argv.slice(2);
  if (!channelArg || !namesArg) {
    console.error('Usage: node scripts/AddModerators.js <channel> "name1, name2 name3"');
    process.exit(1);
  }

  const channelInfo = botInitInfo.channels[channelArg];
  if (!channelInfo) {
    console.error(`Unknown channel "${channelArg}" - not found in config/settings.json`);
    process.exit(1);
  }
  const channelId = `${channelInfo.id}`;

  const names = parseNames(namesArg);
  if (!names.length) {
    console.error("No moderator names provided.");
    process.exit(1);
  }

  const users = await getUsersByLogin(names);
  const foundLogins = new Set(users.map((user) => user.login.toLowerCase()));
  const notFound = names.filter((name) => !foundLogins.has(name.toLowerCase()));

  for (const user of users) {
    await ChatStats.addModerator(channelId, user.id);
    console.log(`Added moderator: ${user.display_name} (${user.id})`);
  }

  if (notFound.length) {
    console.warn(`Could not resolve these names to Twitch accounts: ${notFound.join(", ")}`);
  }

  console.log(`Done: ${users.length} added, ${notFound.length} not found.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[AddModerators] Failed:", err);
  process.exit(1);
});
