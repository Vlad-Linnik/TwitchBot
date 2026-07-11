// One-off migration: push this repo's file-based per-channel config
// (config/channels/<login>.json, deep-merged over default.json via
// config/channelSettings.js) into the TwitchBot-Web repo's `ChannelConfig`
// Mongo collection, so the website has something to show/edit for channels
// that were only ever configured via these JSON files.
//
// The write shape here mirrors TwitchBot-Web/db/channelConfigRepo.js by
// hand (the two repos share no code) - if that shape changes, update this
// script to match, the same way config/channels/default.json's shape is
// kept in sync with TwitchBot-Web/config/defaultChannelConfig.json.
//
// Safe to re-run: a channel that already has a ChannelConfig doc is skipped
// unless --force is given, so this won't silently clobber edits made from
// the website.
//
// Usage: node scripts/migrateChannelConfigs.js [--dry-run] [--force]
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const channelSettings = require("../config/channelSettings.js");

const MONGO_URI = "mongodb://localhost:27017";
const MONGO_DB = "twitch_chat_stats";

const CHANNELS_DIR = path.join(__dirname, "..", "config", "channels");
const SETTINGS_FILE = path.join(__dirname, "..", "config", "settings.json");

function parseArgs(argv) {
  const flags = new Set(argv);
  return { dryRun: flags.has("--dry-run"), force: flags.has("--force") };
}

async function main() {
  const { dryRun, force } = parseArgs(process.argv.slice(2));

  const channelFiles = fs
    .readdirSync(CHANNELS_DIR)
    .filter((f) => f.endsWith(".json") && f !== "default.json");

  if (channelFiles.length === 0) {
    console.log("[migrate] No per-channel config files found besides default.json - nothing to do.");
    return;
  }

  // Purely informational cross-check: does this login have a Channels doc on
  // the website side? Doesn't create anything, just warns.
  const botChannelIds = fs.existsSync(SETTINGS_FILE)
    ? JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8")).channels || {}
    : {};

  const client = new MongoClient(MONGO_URI);
  const results = [];

  try {
    await client.connect();
    const db = client.db(MONGO_DB);
    const channelConfigCol = db.collection("ChannelConfig");
    const channelsCol = db.collection("Channels");
    // Mirrors the unique index TwitchBot-Web/db/channelConfigRepo.js creates - idempotent.
    await channelConfigCol.createIndex({ channelLogin: 1 }, { unique: true });

    console.log(`[migrate] Found ${channelFiles.length} channel config file(s) in ${CHANNELS_DIR}${dryRun ? " (dry run)" : ""}`);

    for (const file of channelFiles) {
      const login = path.basename(file, ".json").toLowerCase();
      const merged = channelSettings.getSettings(login);
      const { bannedWords, spamSignatures, sevenTv, commands, responses } = merged;

      const existing = await channelConfigCol.findOne({ channelLogin: login });

      if (existing && !force) {
        results.push({ login, status: "skipped (already on site, use --force to overwrite)" });
        continue;
      }

      if (!(login in botChannelIds)) {
        console.warn(`[migrate] Note: "${login}" has no entry in config/settings.json.`);
      }
      if (!(await channelsCol.findOne({ channelLogin: login }))) {
        console.warn(`[migrate] Note: "${login}" has no Channels doc on the website yet - run scripts/seedChannel.js in TwitchBot-Web before it's usable on the site.`);
      }

      if (dryRun) {
        results.push({ login, status: existing ? "would overwrite (--force)" : "would create" });
        continue;
      }

      await channelConfigCol.updateOne(
        { channelLogin: login },
        {
          $set: {
            bannedWords,
            spamSignatures,
            sevenTv,
            commands,
            responses,
            updatedAt: new Date(),
            updatedBy: "migration:config-folder",
          },
          $setOnInsert: { channelLogin: login },
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
