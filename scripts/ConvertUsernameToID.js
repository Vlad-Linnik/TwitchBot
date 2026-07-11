// One-off tool: convert a single Twitch username to its numeric ID, or vice versa.
// Usage: node scripts/ConvertUsernameToID.js <username|id>
const { getUsersByLogin, getUsersById } = require("../twitch/userLookup.js");

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error("Usage: node scripts/ConvertUsernameToID.js <username|id>");
    process.exit(1);
  }

  const value = arg.replace(/^@/, "").trim();
  const isId = /^\d+$/.test(value);
  const users = isId ? await getUsersById([value]) : await getUsersByLogin([value]);

  if (!users.length) {
    console.error(`No Twitch account found for "${arg}".`);
    process.exit(1);
  }

  const user = users[0];
  console.log(`login: ${user.login}`);
  console.log(`display_name: ${user.display_name}`);
  console.log(`id: ${user.id}`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[ConvertUsernameToID] Failed:", err);
  process.exit(1);
});
