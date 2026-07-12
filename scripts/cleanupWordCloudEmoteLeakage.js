// One-off cleanup: deletes emote words that leaked into ChatWordStats (the word cloud) because
// they were written by scripts/backfillWordAndMentionStats.js's historical scan BEFORE this
// channel's whiteList had ever been synced with Twitch's global emotes (twitch/globalEmotes.js).
//
// Root cause: backfillWordAndMentionStats.js snapshots each channel's emote-exclusion set
// (whiteList UNION WordLifetimeStats) at the moment it runs, and that script must be run with
// the bot stopped - so if it ran before the bot's own startup-time syncGlobalEmotes() had ever
// populated whiteList with source:'twitch-global' rows, official Twitch emotes ("subprise",
// "bloodtrail", etc.) weren't yet excludable and got counted as ordinary words for the entire
// historical scan. Live writes going forward are unaffected - ChatStats.emoteExclusionCache
// already picks up new whiteList entries via rememberEmote()/syncEmoteSource() - this only
// repairs the already-written historical rows.
//
//   node scripts/cleanupWordCloudEmoteLeakage.js --dry-run        # report only, deletes nothing
//   node scripts/cleanupWordCloudEmoteLeakage.js                  # all channels
//   node scripts/cleanupWordCloudEmoteLeakage.js --channel=#vlad_261
//
// RUN THIS AFTER the bot has synced global emotes at least once (i.e. after a restart following
// the twitch-global emote sync feature), otherwise whiteList won't yet reflect the emotes that
// need excluding and this will find nothing to clean up.
//
// Per repo convention (see ../CLAUDE.md), delete this script once it has been run and verified.
const { connect } = require('../db/db.js');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const channelArg = args.find((a) => a.startsWith('--channel='))?.split('=')[1] || null;

// Mirrors ChatStats.emoteExclusionCache / backfillWordAndMentionStats.js exactly: emotes the
// channel tracks NOW (whiteList) union emotes it has EVER tracked (WordLifetimeStats), lowercased.
async function buildExclusionSet(db, channel) {
  const [current, historical] = await Promise.all([
    db.collection('whiteList').find({ channel }, { projection: { word: 1 } }).toArray(),
    db.collection('WordLifetimeStats').find({ channel }, { projection: { word: 1 } }).toArray(),
  ]);
  return new Set([...current, ...historical].map((w) => String(w.word).toLowerCase()));
}

async function cleanupChannel(db, channel) {
  const chatWordStats = db.collection('ChatWordStats');
  const exclusion = await buildExclusionSet(db, channel);

  const distinctWords = await chatWordStats.distinct('word', { channel });
  const leaked = distinctWords.filter((word) => exclusion.has(String(word).toLowerCase()));

  if (leaked.length === 0) {
    console.log(`[${channel}] no leaked emotes found in ChatWordStats (${distinctWords.length} distinct words)`);
    return { words: 0, rows: 0 };
  }

  const matchQuery = { channel, word: { $in: leaked } };
  const rowCount = await chatWordStats.countDocuments(matchQuery);

  console.log(
    `[${channel}] ${leaked.length} leaked emote word(s) found (${rowCount} rows total, daily + all-time): ` +
      leaked.slice(0, 20).join(', ') + (leaked.length > 20 ? `, ... +${leaked.length - 20} more` : '')
  );

  if (DRY_RUN) return { words: leaked.length, rows: rowCount };

  const result = await chatWordStats.deleteMany(matchQuery);
  console.log(`[${channel}] deleted ${result.deletedCount} rows`);
  return { words: leaked.length, rows: result.deletedCount };
}

async function main() {
  const db = await connect();

  if (DRY_RUN) console.log('DRY RUN - no writes will be performed\n');

  const channels = channelArg ? [channelArg] : await db.collection('ChatWordStats').distinct('channel');
  console.log('Channels to check:', channels.join(', ') || '(none)');

  let totalWords = 0;
  let totalRows = 0;
  for (const channel of channels) {
    const { words, rows } = await cleanupChannel(db, channel);
    totalWords += words;
    totalRows += rows;
  }

  console.log(
    `\nDone. ${totalWords} distinct leaked word(s), ${totalRows} row(s) ${DRY_RUN ? 'would be deleted (dry run)' : 'deleted'}.`
  );
  process.exit(0);
}

main().catch((err) => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
