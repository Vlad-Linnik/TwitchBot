// One-off migration: push this repo's file-based channel login -> numeric Twitch ID
// map (config/settings.json) into the TwitchBot-Web repo's `Channels` Mongo collection,
// so the bot can read its channel list from Mongo instead of this JSON file.
//
// The write shape here mirrors TwitchBot-Web/db/channelsRepo.js's upsertChannel by hand
// (the two repos share no code) - channelId and ownerId are set to the same value,
// matching this codebase's existing "owner doubles as broadcaster ID" convention (see
// ../../CLAUDE.md). If that shape changes, update this script to match.
//
// Safe to re-run: a channel that already has a Channels doc is skipped unless --force
// is given, so this won't silently clobber a real owner/channel-owner split entered via
// TwitchBot-Web/scripts/seedChannel.js.
//
// Usage: node scripts/migrateChannelIds.js [--dry-run] [--force]
const { MongoClient } = require("mongodb");
const settings_cfg = require("../config/settings.json");

const MONGO_URI = "mongodb://localhost:27017";
const MONGO_DB = "twitch_chat_stats";

function parseArgs(argv) {
  const flags = new Set(argv);
  return { dryRun: flags.has("--dry-run"), force: flags.has("--force") };
}

async function main() {
  const { dryRun, force } = parseArgs(process.argv.slice(2));

  const entries = Object.entries(settings_cfg.channels || {});
  if (entries.length === 0) {
    console.log("[migrate] No channels found in config/settings.json - nothing to do.");
    return;
  }

  const client = new MongoClient(MONGO_URI);
  const results = [];

  try {
    await client.connect();
    const db = client.db(MONGO_DB);
    const channelsCol = db.collection("Channels");
    // Mirrors the unique indexes TwitchBot-Web/db/channelsRepo.js creates - idempotent.
    await channelsCol.createIndex({ channelLogin: 1 }, { unique: true });
    await channelsCol.createIndex({ channelId: 1 }, { unique: true });

    console.log(`[migrate] Found ${entries.length} channel(s) in config/settings.json${dryRun ? " (dry run)" : ""}`);

    for (const [rawLogin, info] of entries) {
      const login = rawLogin.toLowerCase();
      const id = String(info.id);

      const existing = await channelsCol.findOne({ channelLogin: login });

      if (existing && !force) {
        results.push({ login, status: "skipped (already registered, use --force to overwrite)" });
        continue;
      }

      if (dryRun) {
        results.push({ login, status: existing ? "would overwrite (--force)" : "would create" });
        continue;
      }

      await channelsCol.updateOne(
        { channelLogin: login },
        {
          $set: {
            channelId: id,
            ownerId: id,
            enabled: true,
            updatedAt: new Date(),
          },
          $setOnInsert: { channelLogin: login, createdAt: new Date() },
        },
        { upsert: true }
      );
      results.push({ login, status: existing ? "overwritten" : "created" });
    }

    console.table(results);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error("[migrate] Failed:", err);
  process.exitCode = 1;
});
