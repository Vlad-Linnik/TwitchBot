// One-off backfill: builds ChatWordStats + UserMentionStats from the historical `messages`
// collection, so the web panel's word clouds and @mention tracker have history instead of only
// counting forward from deploy day.
//
//   node scripts/backfillWordAndMentionStats.js --dry-run        # report only, writes nothing
//   node scripts/backfillWordAndMentionStats.js                  # all channels
//   node scripts/backfillWordAndMentionStats.js --channel=#vlad_261
//   node scripts/backfillWordAndMentionStats.js --lifetime-only  # repair an interrupted run's
//                                                                # all-time rows; no message scan
//
// RUN THIS WITH THE BOT STOPPED. It computes the true count for each {channel, word, day} from
// the raw messages and writes it with $set, which makes the script idempotent and re-runnable -
// but it also means a concurrently-running bot's $inc for the current day could be overwritten.
// Stopping the bot for the few minutes this takes avoids the race entirely.
//
// Memory: ~1.9M messages is far too many to hold, so nothing is accumulated across the whole
// run. Messages are streamed in timestamp order and counts are held only for the day currently
// being read, then flushed when the stream rolls over to the next day - so peak memory is
// "distinct words in a single day", not "distinct words ever". Lifetime (all-time) rows are not
// accumulated in memory either: they're recomputed at the end by aggregating the daily rows that
// were just written, inside Mongo.
//
// Per repo convention (see ../CLAUDE.md), delete this script once it has been run and verified.
const { connect } = require('../db/db.js');
const { extractWords, extractMentions, dayBucket, LIFETIME_BUCKET } = require('../shared/textStats.js');

const BATCH_SIZE = 1000;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const channelArg = args.find((a) => a.startsWith('--channel='))?.split('=')[1] || null;

// --lifetime-only: skip the message scan entirely and just recompute the all-time rows from the
// daily rows that already exist.
//
// This is the cheap repair for an interrupted run. The expensive half of a backfill is streaming
// and tokenizing ~1.9M messages; the all-time rows are pure derivation on top of that (a $group
// over rows already in ChatWordStats), so a run that got through the daily pass but died before
// finishing the rollup does NOT need the whole thing redone. Symptom of needing this: date-ranged
// periods look right while `all` looks wrong, because `all` reads the (incomplete) epoch rows.
const LIFETIME_ONLY = args.includes('--lifetime-only');

// ---------------------------------------------------------------------------------------
// Progress reporting
//
// Two modes on purpose. An in-place bar (\r, no newline) is only legible on a real terminal; the
// moment this script's output is redirected to a file, piped, or run in the background - which is
// exactly how you'd run a 6-minute backfill on a VPS - carriage returns turn the log into a single
// unreadable smear, and a pipe's block buffering means nothing appears until it fills anyway.
// So: bar when stdout is a TTY, plain periodic lines otherwise. Both report the same numbers.
// ---------------------------------------------------------------------------------------
const IS_TTY = Boolean(process.stdout.isTTY);
const REDRAW_INTERVAL_MS = 120; // fast enough to look live, slow enough not to be the bottleneck
const LOG_EVERY_PERCENT = 10; // non-TTY: one line per 10% instead of a redraw

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

function formatRate(perSecond) {
  if (!Number.isFinite(perSecond) || perSecond <= 0) return '--';
  return perSecond >= 1000 ? `${(perSecond / 1000).toFixed(1)}k/s` : `${Math.round(perSecond)}/s`;
}

const heapMb = () => (process.memoryUsage().heapUsed / 1048576).toFixed(0);

// clearLine/cursorTo only exist on TTY streams, and this is a progress indicator - it must never
// be the thing that kills a 6-minute backfill. Optional-call, then fall back to a plain carriage
// return, which every terminal understands.
function clearCurrentLine() {
  if (typeof process.stdout.clearLine === 'function' && typeof process.stdout.cursorTo === 'function') {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  } else {
    process.stdout.write('\r');
  }
}

function createProgress(label, total) {
  const started = Date.now();
  let lastDraw = 0;
  let lastLoggedBucket = -1;
  let current = 0;

  const render = (force) => {
    const now = Date.now();
    if (!force && now - lastDraw < REDRAW_INTERVAL_MS) return;
    lastDraw = now;

    const elapsed = now - started;
    const rate = current / (elapsed / 1000);
    const fraction = total > 0 ? Math.min(current / total, 1) : 0;
    const pct = Math.floor(fraction * 100);

    if (IS_TTY) {
      const WIDTH = 28;
      const filled = Math.round(fraction * WIDTH);
      const bar = '█'.repeat(filled) + '░'.repeat(WIDTH - filled);
      // ETA is only meaningful once there's a rate to extrapolate from.
      const eta = rate > 0 && total > current ? formatDuration(((total - current) / rate) * 1000) : '--';
      const line =
        `  ${label} [${bar}] ${String(pct).padStart(3)}%  ` +
        `${current.toLocaleString()}/${total.toLocaleString()}  ` +
        `${formatRate(rate)}  ETA ${eta}  heap ${heapMb()}MB`;
      // clearLine so a shorter line never leaves trailing characters from a longer previous one.
      clearCurrentLine();
      process.stdout.write(line);
    } else {
      const bucket = Math.floor(pct / LOG_EVERY_PERCENT);
      if (bucket === lastLoggedBucket && !force) return;
      lastLoggedBucket = bucket;
      console.log(
        `  ${label} ${String(pct).padStart(3)}%  ${current.toLocaleString()}/${total.toLocaleString()}  ` +
          `${formatRate(rate)}  elapsed ${formatDuration(elapsed)}  heap ${heapMb()}MB`
      );
    }
  };

  return {
    tick(n = 1) {
      current += n;
      render(false);
    },
    done(summary) {
      current = total;
      if (IS_TTY) {
        clearCurrentLine();
      }
      const elapsed = Date.now() - started;
      console.log(`  ${label} done in ${formatDuration(elapsed)}${summary ? ` — ${summary}` : ''}`);
    },
  };
}

// Progress for a phase whose size isn't known up front (the all-time rollup: its size is "distinct
// words", which we'd have to run the aggregation to learn - so counting it first would double the
// work it's reporting on). Shows throughput instead of a percentage.
function createCounter(label) {
  const started = Date.now();
  let lastDraw = 0;
  let current = 0;

  const render = (force) => {
    const now = Date.now();
    if (!force && now - lastDraw < REDRAW_INTERVAL_MS) return;
    lastDraw = now;
    if (!IS_TTY) return; // non-TTY gets only the final summary line - no size to pace logs against
    const rate = current / ((now - started) / 1000);
    clearCurrentLine();
    process.stdout.write(`  ${label} ${current.toLocaleString()} rows  ${formatRate(rate)}  heap ${heapMb()}MB`);
  };

  return {
    tick(n = 1) {
      current += n;
      render(false);
    },
    done(summary) {
      if (IS_TTY) {
        clearCurrentLine();
      }
      console.log(`  ${label} ${summary ?? `${current.toLocaleString()} rows`} in ${formatDuration(Date.now() - started)}`);
      return current;
    },
  };
}

async function flushOps(collection, ops) {
  if (ops.length === 0 || DRY_RUN) return;
  await collection.bulkWrite(ops, { ordered: false });
}

// MUST run before the first write, and this is not a nicety.
//
// Every row is written as an upsert filtered on {channel, word, date}. On a collection with no
// index covering that filter, each upsert is a COLLECTION SCAN - and the collection is growing as
// we go, so the cost per write climbs with the number of rows already written. Backfilling ~1.9M
// rows that way is quadratic and effectively never finishes (learned the hard way: dropping the
// collection to rebuild it also drops its indexes, and the next run crawled).
//
// These definitions must stay identical to ChatStats.initialize()'s - the bot re-creates them at
// startup anyway, but the backfill cannot depend on the bot having run first.
async function ensureIndexes(db) {
  if (DRY_RUN) return;
  const chatWordStats = db.collection('ChatWordStats');
  const userMentionStats = db.collection('UserMentionStats');

  await Promise.all([
    chatWordStats.createIndex({ channel: 1, word: 1, date: 1 }, { unique: true }),
    chatWordStats.createIndex({ channel: 1, date: 1, count: -1, word: 1 }),
    userMentionStats.createIndex({ channel: 1, mentionedLogin: 1, date: 1 }, { unique: true }),
    userMentionStats.createIndex({ channel: 1, date: 1, count: -1, mentionedLogin: 1 }),
  ]);
  console.log('Indexes ensured on ChatWordStats / UserMentionStats');
}

async function backfillChannel(db, channel) {
  const messages = db.collection('messages');
  const chatWordStats = db.collection('ChatWordStats');
  const userMentionStats = db.collection('UserMentionStats');

  // Emote-exclusion set, mirroring ChatStats.emoteExclusionCache exactly: emotes the channel
  // tracks NOW (whiteList) union emotes it has EVER tracked (WordLifetimeStats), lowercased.
  //
  // The union is the whole point. #mistercop's whiteList is empty but WordLifetimeStats holds 488
  // emotes with tens of thousands of uses each - backfilling against whiteList alone produced a
  // "word cloud" whose top entries were jokerge / arolf / wideNessie, i.e. emotes. If this set
  // ever disagrees with the bot's, backfilled history stops matching new writes.
  const [current, historical] = await Promise.all([
    db.collection('whiteList').find({ channel }, { projection: { word: 1 } }).toArray(),
    db.collection('WordLifetimeStats').find({ channel }, { projection: { word: 1 } }).toArray(),
  ]);
  const emotes = new Set([...current, ...historical].map((w) => String(w.word).toLowerCase()));
  const isEmote = (token) => emotes.has(String(token).toLowerCase());

  const total = await messages.countDocuments({ channel });
  console.log(
    `\n[${channel}] ${total.toLocaleString()} messages, ${emotes.size} emotes excluded ` +
      `(${current.length} tracked now, ${historical.length} historical)`
  );
  if (total === 0) return { words: 0, mentions: 0, days: 0 };

  // Counts for the single day currently being streamed. Bounded memory: reset on every rollover.
  let currentDay = null;
  let dayWords = new Map();
  let dayMentions = new Map();

  let wordOps = [];
  let mentionOps = [];
  let seen = 0;
  let daysWritten = 0;
  let wordRows = 0;
  let mentionRows = 0;

  const writeDay = async () => {
    if (currentDay === null) return;
    const date = new Date(currentDay);

    for (const [word, count] of dayWords) {
      // $set, not $inc: the count computed here IS the true total for this day, so re-running
      // the script converges instead of doubling. $setOnInsert-style fields go in $set too.
      wordOps.push({
        updateOne: {
          filter: { channel, word, date },
          update: { $set: { count } },
          upsert: true,
        },
      });
    }
    for (const [login, count] of dayMentions) {
      mentionOps.push({
        updateOne: {
          filter: { channel, mentionedLogin: login, date },
          update: { $set: { count } },
          upsert: true,
        },
      });
    }

    wordRows += dayWords.size;
    mentionRows += dayMentions.size;
    daysWritten++;

    if (wordOps.length >= BATCH_SIZE) {
      await flushOps(chatWordStats, wordOps);
      wordOps = [];
    }
    if (mentionOps.length >= BATCH_SIZE) {
      await flushOps(userMentionStats, mentionOps);
      mentionOps = [];
    }

    dayWords = new Map();
    dayMentions = new Map();
  };

  // Ascending timestamp so days arrive contiguously and a rollover means "that day is complete".
  const cursor = messages
    .find({ channel }, { projection: { message: 1, userName: 1, timestamp: 1 } })
    .sort({ timestamp: 1 })
    .batchSize(2000);

  const progress = createProgress('scanning messages', total);

  for await (const doc of cursor) {
    const day = dayBucket(doc.timestamp).getTime();
    if (day !== currentDay) {
      await writeDay();
      currentDay = day;
    }

    for (const word of extractWords(doc.message, isEmote)) {
      dayWords.set(word, (dayWords.get(word) || 0) + 1);
    }
    for (const login of extractMentions(doc.message, [doc.userName])) {
      dayMentions.set(login, (dayMentions.get(login) || 0) + 1);
    }

    seen++;
    progress.tick();
  }

  await writeDay();
  await flushOps(chatWordStats, wordOps);
  await flushOps(userMentionStats, mentionOps);

  progress.done(
    `${wordRows.toLocaleString()} word / ${mentionRows.toLocaleString()} mention daily rows across ${daysWritten} days`
  );
  return { words: wordRows, mentions: mentionRows, days: daysWritten };
}

// All-time rows are derived, never accumulated: sum the daily rows we just wrote, per word.
// Done inside Mongo so nothing large crosses into Node's heap. $match excludes the epoch row
// itself, so re-running can't feed the all-time total back into itself.
async function rebuildLifetimeRows(db, channel, collectionName, keyField, label) {
  if (DRY_RUN) return 0;
  const collection = db.collection(collectionName);

  const cursor = collection.aggregate(
    [
      { $match: { channel, date: { $gt: LIFETIME_BUCKET } } },
      { $group: { _id: `$${keyField}`, total: { $sum: '$count' } } },
    ],
    { allowDiskUse: false }
  );

  // Unknown total by design: its size IS "distinct words", which we could only learn by running
  // this very aggregation first - so a percentage would cost as much as the work it measures.
  const progress = createCounter(`rebuilding all-time ${label}`);

  let ops = [];
  let n = 0;
  for await (const row of cursor) {
    ops.push({
      updateOne: {
        filter: { channel, [keyField]: row._id, date: LIFETIME_BUCKET },
        update: { $set: { count: row.total } },
        upsert: true,
      },
    });
    n++;
    progress.tick();
    if (ops.length >= BATCH_SIZE) {
      await collection.bulkWrite(ops, { ordered: false });
      ops = [];
    }
  }
  if (ops.length) await collection.bulkWrite(ops, { ordered: false });

  progress.done(`${n.toLocaleString()} rows`);
  return n;
}

async function main() {
  const started = Date.now();
  const db = await connect();

  if (DRY_RUN) console.log('DRY RUN - no writes will be performed\n');

  await ensureIndexes(db);

  // `messages` contains a small number of docs with a null channel (pre-dating the current
  // logging path); they belong to no channel and are skipped rather than silently bucketed.
  const channels = channelArg
    ? [channelArg]
    : (await db.collection('messages').distinct('channel')).filter((c) => typeof c === 'string' && c.startsWith('#'));

  console.log('Channels to backfill:', channels.join(', ') || '(none)');

  for (const channel of channels) {
    if (LIFETIME_ONLY) {
      console.log(`\n[${channel}] recomputing all-time rows from existing daily rows (no message scan)`);
    } else {
      await backfillChannel(db, channel);
    }

    await rebuildLifetimeRows(db, channel, 'ChatWordStats', 'word', 'words');
    await rebuildLifetimeRows(db, channel, 'UserMentionStats', 'mentionedLogin', 'mentions');
  }

  console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s${DRY_RUN ? ' (dry run - nothing written)' : ''}`);
  process.exit(0); // matches scripts/BackfillUserLifetimeStats.js - db.js exposes no close()
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
