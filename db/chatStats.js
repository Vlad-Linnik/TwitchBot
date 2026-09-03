const { connect } = require('./db.js');
const { extractWords, extractMentions, parseGifTag, stripGifSpans, parseEmotesTag, dayBucket, LIFETIME_BUCKET } = require('../shared/textStats.js');
const { isKnownBot } = require('../config/knownBots.js');

const MIN_TIMEOUT_MS = 1000; // 1 second, Twitch's shortest timeout
const MAX_TIMEOUT_MS = 1_209_600_000; // 1,209,600s = 2 weeks, Twitch's longest timeout

// A reaction slower than this is excluded from a moderator's daily "Avg reaction" average -
// past this, it's less "how fast do they react" and more "were they even watching", which
// would drag the average away from what it's meant to represent. Matches
// TwitchBot-Web/db/statsRepo.js's MOD_ACTION_CONTEXT_MAX_TTA_MS (kept in sync by hand, same
// convention as the other shared-schema constants documented in ../CLAUDE.md).
const REACTION_SPEED_MAX_TTA_MS = 120000; // 2 minutes

// Maps a timeout's duration onto the 1-9 severity band. Log-scaled because timeouts span
// six orders of magnitude (1s..2 weeks) - a linear scale would put almost every real-world
// timeout near 1.
function timeoutSeverity(durationMs) {
  if (!durationMs || durationMs <= 0) return 1;
  const clampedMs = Math.min(Math.max(durationMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
  const scale = Math.log(clampedMs / MIN_TIMEOUT_MS) / Math.log(MAX_TIMEOUT_MS / MIN_TIMEOUT_MS);
  return 1 + scale * 8;
}

// Per-action severity score feeding into a moderator's daily average (0 = no restriction,
// 10 = permanent ban). Only ban/timeout/delete are on this scale per spec; warn is tracked
// for moderation-activity volume but doesn't itself restrict the user, so it scores 0.
function actionSeverity(log) {
  if (log.action === 'ban') return 10;
  if (log.action === 'delete') return 1;
  if (log.action === 'timeout') return timeoutSeverity(log.durationMs);
  return 0;
}

// Splits a [start, end) interval into per-calendar-day chunks (local time), each carrying how
// many minutes of that interval actually fall on that day. Without this, an interval that
// straddles midnight (e.g. a 5-minute poll from 23:58 to 00:03) would get attributed entirely
// to whichever day the DB write happens to land on, instead of resetting cleanly at midnight.
function splitIntoDaySegments(start, end) {
  const segments = [];
  let cursor = new Date(start);

  while (cursor < end) {
    const dayStart = new Date(cursor);
    dayStart.setHours(0, 0, 0, 0);
    const nextDayStart = new Date(dayStart);
    nextDayStart.setDate(nextDayStart.getDate() + 1);

    const segmentEnd = end < nextDayStart ? end : nextDayStart;
    const minutes = (segmentEnd - cursor) / 60000;
    segments.push({ date: dayStart, minutes });
    cursor = segmentEnd;
  }

  return segments;
}

// Separator packing {channel, word, day} into a single in-memory buffer key. NUL is used
// because it is the one character a channel name, a tokenized word and a numeric day bucket
// can never themselves contain - so the key is always unambiguous to split back apart.
const KEY_SEP = '\u0000';

// How long chat-word / @mention counts accumulate in memory before being flushed to Mongo as
// one coalesced bulkWrite. See ChatStats.bufferTextStats() for why this buffer exists.
const TEXT_STATS_FLUSH_INTERVAL_MS = 5000;

// The whitelist `source` of an emote nobody configured: a Twitch emote seen in this channel's
// chat that belongs to some OTHER broadcaster's set - a sub emote of a channel a viewer here
// subscribes to, or its bits/follower emotes. Every other source is a list somebody fetched;
// this one is learnt from the `emotes` tag one message at a time, so no sync ever owns these
// rows and none of them may be pruned as "stale" (the same standing 'manual' rows have).
const EXTERNAL_EMOTE_SOURCE = 'twitch-external';

class ChatStats {
  constructor() {
    this.dbInitialized = false;
    this.whiteListCache = new Map();
    this.messagesCollection = null;
    this.whiteListCollection = null;
    this.wordsCollection = null;
    this.customCommandsCollection = null;
    this.modLogs = null;
    this.modStats = null;
    this.modList = null;
    this.modsUpTimeStats = null;
    this.userLifetimeStats = null;
    this.userIdentities = null;
    this.wordLifetimeStats = null;
    this.commandStats = null;
    this.globalEmoteStats = null;
    this.chatWordStats = null;
    this.userMentionStats = null;
    this.userDailyMessageStats = null;
    this.emoteExclusions = null;
    this.streamSessions = null;
    this.streamViewerSamples = null;
    this.wordBuffer = new Map();
    this.mentionBuffer = new Map();
    this.messageCountBuffer = new Map();
    this.exclusionBuffer = new Map();
    this.textStatsFlushTimer = null;
    // Deliberately NOT the same thing as whiteListCache, even though they overlap:
    //   whiteListCache        - what currently COUNTS as a tracked emote (gates `words` /
    //                           WordLifetimeStats). Case-sensitive, because 7TV emotes are.
    //   emoteExclusionCache   - what is barred from the WORD cloud. The union of currently and
    //                           historically tracked emotes, lowercased.
    // They must differ, because a channel can stop tracking emotes while its chat keeps using
    // them: #mistercop has an empty whiteList but 488 emotes in WordLifetimeStats, so gating the
    // word cloud on whiteListCache alone let `jokerge`, `arolf` and `wideNessie` - emotes, with
    // tens of thousands of uses each - straight into its word cloud as if they were words.
    this.emoteExclusionCache = new Map();
    // Третий взгляд на тот же набор: строчное написание -> написание, которым смайлик
    // нарисуется. Нужен ровно одному потребителю - правке ответа модели (shared/emoteFix.js),
    // которая должна не спросить «смайлик ли это», а получить ПРАВИЛЬНОЕ написание для «kekw».
    // Всегда пересобирается вместе с whiteListCache, потому что отвечает про тот же набор.
    this.emoteSpellingCache = new Map();
    // Четвёртый взгляд, и единственный, который держится ОТДЕЛЬНО от whiteListCache: смайлики
    // Twitch, замеченные в чате, но принадлежащие чужому каналу (см. EXTERNAL_EMOTE_SOURCE).
    // Канал -> Map(написание -> id смайлика). Считаются они наравне со своими, а вот в
    // whiteListCache им нельзя: из него берётся написание для ОТВЕТА бота (shared/emoteFix.js),
    // а чужой подписочный смайлик у бота не нарисуется - подписки-то у него нет.
    // id хранится потому, что он единственный ключ к картинке: сайт достаёт свои смайлики из
    // Helix и 7TV по имени, а чужого подписочного нет ни в одном наборе, который он читает.
    this.externalEmoteCache = new Map();
  }

  async initialize() {
    try {
      const db = await connect();
      this.messagesCollection = db.collection('messages');
      this.wordsCollection = db.collection('words');
      this.whiteListCollection = db.collection('whiteList');
      this.customCommandsCollection = db.collection("custom_commands");
      this.countersCollection = db.collection("counters");
      this.customCommandExceptions = db.collection("custom_command_exceptions");
      this.modLogs = db.collection("ModeratorActionLogs");
      this.modStats = db.collection("ModeratorStatistics");
      this.modList = db.collection("ModsList");
      this.modsUpTimeStats = db.collection("ModUpTimeStats");
      this.userLifetimeStats = db.collection("UserLifetimeStats");
      this.userIdentities = db.collection("UserIdentities");
      this.wordLifetimeStats = db.collection("WordLifetimeStats");
      this.commandStats = db.collection("CommandExecutionStats");
      this.globalEmoteStats = db.collection("GlobalEmoteStats");
      // NOTE the naming: `words`/`WordLifetimeStats` above are, despite their names, EMOTE
      // stats - addMessage() only counts tokens present in the channel's whiteList, which is
      // synced from its 7TV emote set. They are not a word-frequency index (as of this writing
      // WordLifetimeStats holds ~500 distinct entries against ~1.9M messages). ChatWordStats
      // below is the actual word-frequency index: every non-emote, non-stopword, non-command
      // token. The two are deliberately disjoint so the web panel's Word Cloud and Emote Cloud
      // show genuinely different things.
      this.chatWordStats = db.collection("ChatWordStats");
      this.userMentionStats = db.collection("UserMentionStats");
      // Per-user daily message counts (same epoch-sentinel convention as ChatWordStats), backing
      // the web panel's period-switchable Top Chatters. UserLifetimeStats stays the all-time
      // source; this collection exists for the day/week/month ranges.
      this.userDailyMessageStats = db.collection("UserDailyMessageStats");
      // Persistent tombstones for the word-cloud emote exclusion. words/WordLifetimeStats rows
      // of un-tracked emotes get DELETED by pruneUntrackedEmoteStats(), so "ever tracked" can no
      // longer be derived from WordLifetimeStats alone - this collection is what survives.
      this.emoteExclusions = db.collection("EmoteExclusions");
      // Stream-level viewer/category history, backing the web panel's per-stream stats chart.
      // See ensureOpenSession/endStreamSession/recordStreamSample - piggybacked on
      // ActivitiTracker's existing Get Streams poll, no new Helix calls or EventSub subscriptions.
      this.streamSessions = db.collection("StreamSessions");
      this.streamViewerSamples = db.collection("StreamViewerSamples");

      await this.commandStats.createIndex({ channel: 1 }, { unique: true });
      await this.modsUpTimeStats.createIndex({ channelId: 1, userId: 1, timestamp: 1 }, { unique: true });
      await this.modsUpTimeStats.createIndex({ channelId: 1, timestamp: 1, hours: -1 });
      await this.modStats.createIndex({ channelId: 1, userId: 1, date: 1 }, { unique: true });
      await this.modList.createIndex({ channelId: 1 }, { unique: true });
      await this.modLogs.createIndex({ channel: 1, timestamp: -1, userId: 1 });
      // The web panel's mod-action log filters by moderator ($in on modID, newest first) and
      // builds its filter options from distinct('modID', {channel}) - both ride this index.
      // The exclude ($nin) and action-type filters stay on the {channel, timestamp} scan above,
      // which is fine at this collection's size.
      await this.modLogs.createIndex({ channel: 1, modID: 1, timestamp: -1 });
      await this.messagesCollection.createIndex({ channel: 1, timestamp: -1, userId: 1 });
      // Every per-user page on the web panel (message-count chart, activity heatmap, that
      // user's word/emote cloud, the moderator-only log view) filters by {channel, userId}
      // then ranges over time. The index above leads with timestamp, so those queries would
      // scan the channel's whole time range and post-filter on userId; this one puts userId
      // in the prefix so a single user's history is a tight, bounded index range. It also
      // serves the multi-user log search ($in on userId).
      await this.messagesCollection.createIndex({ channel: 1, userId: 1, timestamp: -1 });
      await this.wordsCollection.createIndex({ channel: 1, date: -1 });
      await this.userLifetimeStats.createIndex({ channel: 1, userId: 1 }, { unique: true });
      await this.userLifetimeStats.createIndex({ channel: 1, messageCount: -1 });
      await this.userIdentities.createIndex({ userId: 1 }, { unique: true });
      // Поиск ПО НИКУ, а не по id: им пользуется память о зрителях (games/aiReply.js), чтобы
      // проверить, существует ли названный человек. Без этих двух индексов такой запрос был
      // полным сканом коллекции - терпимо на 23 тысячах строк и уже нет на горячем пути ответа.
      // История ников индексируется отдельно: на Twitch переименовываются, а факт живёт долго.
      await this.userIdentities.createIndex({ currentUserName: 1 });
      await this.userIdentities.createIndex({ 'nicknames.name': 1 });
      await this.wordLifetimeStats.createIndex({ channel: 1, word: 1 }, { unique: true });
      await this.wordLifetimeStats.createIndex({ channel: 1, count: -1 });
      await this.whiteListCollection.createIndex({ channel: 1, word: 1 }, { unique: true });
      await this.customCommandExceptions.createIndex({ channel: 1 }, { unique: true });

      // Both new collections carry their daily rows AND an all-time row in the same place,
      // the all-time one keyed by the epoch sentinel date (textStats.LIFETIME_BUCKET) - the
      // same trick ModUpTimeStats uses. Two consequences worth knowing:
      //   - "top N of all time" is an O(limit) index scan on {channel, date, count} rather
      //     than a $group across every day ever recorded. That's what makes the channel word
      //     cloud affordable on a 2GB box.
      //   - any real date range starts after the epoch, so range queries skip the all-time
      //     row automatically without needing to exclude it.
      await this.chatWordStats.createIndex({ channel: 1, word: 1, date: 1 }, { unique: true });
      await this.userMentionStats.createIndex({ channel: 1, mentionedLogin: 1, date: 1 }, { unique: true });

      // COVERING indexes for the two read patterns, and the word/login field is in them on
      // purpose. ChatWordStats runs to ~1 row per message (~1.9M for #mistercop), so a read
      // that has to FETCH the documents to learn each row's `word` would pull hundreds of
      // thousands of docs through a 2GB box's cache. With the term in the index, both the
      // all-time top-N (date = epoch, sorted by count) and the date-range $group are answered
      // entirely from the index - zero document fetches. This is the single most important
      // thing making the channel word cloud affordable on that VPS.
      await this.chatWordStats.createIndex({ channel: 1, date: 1, count: -1, word: 1 });
      await this.userMentionStats.createIndex({ channel: 1, date: 1, count: -1, mentionedLogin: 1 });
      await this.userDailyMessageStats.createIndex({ channel: 1, userId: 1, date: 1 }, { unique: true });
      await this.userDailyMessageStats.createIndex({ channel: 1, date: 1, count: -1, userId: 1 });
      await this.emoteExclusions.createIndex({ channel: 1, word: 1 }, { unique: true });
      // At most one OPEN session per channel - a defense-in-depth invariant, not just a query
      // optimization: ensureOpenSession() below is careful to close a stale session before
      // opening a new one, but this index makes "two open sessions for the same channel" a
      // write-time impossibility rather than something only application logic prevents.
      await this.streamSessions.createIndex(
        { channelId: 1 },
        { unique: true, partialFilterExpression: { endedAt: null } }
      );
      await this.streamSessions.createIndex({ channelId: 1, startedAt: -1 });
      await this.streamViewerSamples.createIndex({ channelId: 1, timestamp: 1 }, { unique: true });
      const list = await this.whiteListCollection.find({}).toArray();
      this.whiteListCache = new Map();
      this.externalEmoteCache = new Map();
      for (const item of list) {
        // Чужие подписочные - в свой кэш, а не в набор канала: считаются они так же, но
        // написание для ответа бота должно браться только из того, что бот может отправить.
        if (item.source === EXTERNAL_EMOTE_SOURCE) {
          if (!this.externalEmoteCache.has(item.channel)) this.externalEmoteCache.set(item.channel, new Map());
          this.externalEmoteCache.get(item.channel).set(item.word, item.emoteId);
          continue;
        }
        if (!this.whiteListCache.has(item.channel)) this.whiteListCache.set(item.channel, new Set());
        this.whiteListCache.get(item.channel).add(item.word);
      }
      this.emoteSpellingCache = new Map();
      for (const channel of this.whiteListCache.keys()) this.reindexEmoteSpellings(channel);

      // Word-cloud exclusion set: every emote this channel tracks now (whiteList), ever tracked
      // (WordLifetimeStats), or had pruned away (EmoteExclusions tombstones). Lowercased, because
      // `AROLF` the emote and `arolf` as typed are the same token to a reader even though Twitch
      // treats them as distinct. A few hundred entries per channel - negligible memory, and it is
      // what keeps the word cloud full of words.
      this.emoteExclusionCache = new Map();
      const addExclusion = (channel, word) => {
        if (!this.emoteExclusionCache.has(channel)) this.emoteExclusionCache.set(channel, new Set());
        this.emoteExclusionCache.get(channel).add(String(word).toLowerCase());
      };
      for (const item of list) addExclusion(item.channel, item.word);
      const historical = await this.wordLifetimeStats.find({}, { projection: { channel: 1, word: 1 } }).toArray();
      for (const item of historical) addExclusion(item.channel, item.word);
      const tombstones = await this.emoteExclusions.find({}, { projection: { channel: 1, word: 1 } }).toArray();
      for (const item of tombstones) addExclusion(item.channel, item.word);

      this.dbInitialized = true;
      console.log('DB collections initialized');
    } catch (err) {
      console.error('Database initialization failed:', err);
    }
  }

  async ensureInitialized() {
    if (!this.dbInitialized) {
      await this.initialize();
    }
  }

  // activeUserIds were all present for the entire [intervalStart, intervalEnd) window (the
  // approximation ModActivityTracker already made: presence at a poll implies presence since
  // the last one). The all-time bucket just gets the whole interval; the per-day buckets get
  // it split at any midnight the interval crosses, so a day's total actually resets at 00:00
  // instead of absorbing minutes that happened the day before (or vice versa).
  async updateModUpTime(channelId, activeUserIds, intervalStart, intervalEnd) {
    await this.ensureInitialized();
    // Bot accounts (config/knownBots.js) hold mod status but aren't people - filtered at the
    // write itself so no caller can accidentally track them.
    activeUserIds = (activeUserIds || []).filter((id) => !isKnownBot(id));
    if (activeUserIds.length === 0) return;

    const allTimeDate = new Date(0);
    const totalHours = (intervalEnd - intervalStart) / 3600000;
    const daySegments = splitIntoDaySegments(intervalStart, intervalEnd);
    const lastSeenDate = intervalEnd;

    const operations = [];
    for (const userId of activeUserIds) {
      operations.push({
        updateOne: {
          filter: { channelId, userId, timestamp: allTimeDate },
          update: { $inc: { hours: totalHours }, $set: { lastSeen: lastSeenDate } },
          upsert: true
        }
      });

      for (const segment of daySegments) {
        operations.push({
          updateOne: {
            filter: { channelId, userId, timestamp: segment.date },
            update: { $inc: { hours: segment.minutes / 60 }, $set: { lastSeen: lastSeenDate } },
            upsert: true
          }
        });
      }
    }

    try {
      if (operations.length > 0) {
        await this.modsUpTimeStats.bulkWrite(operations, { ordered: false });
      }
    } catch (err) {
      console.error('[DB] updatemoduptime Error:', err);
    }
  }

  // Called on every live poll tick (not just the live-transition edge), same idempotent-piggyback
  // pattern as recordDailyModeratorStats' hourly refresh - so a bot restart mid-stream just finds
  // the still-open session and keeps appending to it instead of needing separate "just went live"
  // vs "already live, bot restarted" handling.
  //
  // The one thing that pattern alone can't tell apart: a session left open because the bot was
  // down (crashed/redeployed) through the real end of THAT stream, possibly through the start of
  // a later one too. Blindly reusing "the channel's open session" in that case would silently glue
  // two unrelated streams (and the dead gap between them) into one. staleAfterMs guards against
  // that - if the open session hasn't seen a sample in longer than that, it's abandoned: close it
  // at its own last-known-good timestamp (an honest estimate, not "now") and start a fresh one.
  async ensureOpenSession(channelId, channelLogin, now, staleAfterMs) {
    await this.ensureInitialized();
    channelId = String(channelId);

    const open = await this.streamSessions.findOne({ channelId, endedAt: null });
    if (!open) {
      await this.streamSessions.insertOne({ channelId, channelLogin, startedAt: now, endedAt: null });
      return;
    }

    const lastSample = await this.streamViewerSamples.findOne(
      { channelId },
      { sort: { timestamp: -1 } }
    );
    const lastActivity = lastSample && lastSample.timestamp > open.startedAt
      ? lastSample.timestamp
      : open.startedAt;

    if (now - lastActivity > staleAfterMs) {
      await this.streamSessions.updateOne({ _id: open._id }, { $set: { endedAt: lastActivity } });
      await this.streamSessions.insertOne({ channelId, channelLogin, startedAt: now, endedAt: null });
    }
    // else: still fresh - reuse the open session as-is, nothing to write.
  }

  // Closes every open session for the channel (there is at most one - see the partial unique
  // index on StreamSessions). updateMany rather than updateOne purely for idempotence-under-retry;
  // this only ever matches zero or one document in practice.
  async endStreamSession(channelId, endedAt) {
    await this.ensureInitialized();
    await this.streamSessions.updateMany(
      { channelId: String(channelId), endedAt: null },
      { $set: { endedAt } }
    );
  }

  // One row per live poll tick - deliberately NOT tagged with a sessionId (see ../../CLAUDE.md-
  // style reasoning elsewhere in this file: session membership is derived by the reader via a
  // [startedAt, endedAt) time-range scan, same convention as querying `messages` by channel+time
  // range rather than a foreign key).
  async recordStreamSample(channelId, timestamp, viewerCount, category) {
    await this.ensureInitialized();
    try {
      await this.streamViewerSamples.insertOne({
        channelId: String(channelId),
        timestamp,
        viewerCount,
        category
      });
    } catch (err) {
      console.error('[DB] recordStreamSample error:', err);
    }
  }

  // Rolls up one calendar day of per-moderator stats into ModeratorStatistics. Called from
  // ModActivityTracker when it detects the stream just went offline (see ActivitiTracker.js) -
  // upserting on {channelId, userId, date} makes it safe to call more than once for the same
  // day (e.g. the stream flaps offline/online again later) without creating duplicate rows.
  async recordDailyModeratorStats(channelId, channelLogin, moderatorIds) {
    await this.ensureInitialized();
    // Same known-bot filter as updateModUpTime - a bot's daily roll-up row would put it
    // straight into the web panel's moderator table.
    moderatorIds = (moderatorIds || []).filter((id) => !isKnownBot(id));
    if (moderatorIds.length === 0) return;

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    const chatChannel = `#${channelLogin}`;

    const operations = [];
    for (const userId of moderatorIds) {
      const [chatActivity, upTimeDoc, actionLogs] = await Promise.all([
        this.messagesCollection.countDocuments({
          channel: chatChannel,
          userId,
          timestamp: { $gte: dayStart, $lt: dayEnd }
        }),
        this.modsUpTimeStats.findOne({ channelId, userId, timestamp: dayStart }),
        this.modLogs.find({
          channel: channelLogin,
          modID: userId,
          timestamp: { $gte: dayStart, $lt: dayEnd }
        }).toArray()
      ]);

      const streamPresence = upTimeDoc?.hours || 0;

      const validTTAs = actionLogs
        .map(log => log.TTA)
        .filter(tta => tta !== null && tta !== undefined && tta <= REACTION_SPEED_MAX_TTA_MS);
      const reactionSpeed = validTTAs.length > 0
        ? validTTAs.reduce((sum, tta) => sum + tta, 0) / validTTAs.length
        : null;

      const severity = actionLogs.length > 0
        ? actionLogs.reduce((sum, log) => sum + actionSeverity(log), 0) / actionLogs.length
        : 0;

      const moderationActivity = actionLogs.length;

      // A moderator who never showed up that day (no messages, no presence, no actions) gets
      // NO row at all - an all-zero row carries no information, but its existence used to make
      // the web panel treat the mod as "has data", rendering a zero line even with the
      // "show moderators with no data" toggle off. scripts/cleanupModeratorStats.js removes
      // the all-zero rows written before this guard existed.
      if (chatActivity === 0 && streamPresence === 0 && moderationActivity === 0) continue;

      operations.push({
        updateOne: {
          filter: { channelId, userId, date: dayStart },
          update: {
            $set: {
              channelId, userId, date: dayStart,
              chatActivity, streamPresence, reactionSpeed, severity, moderationActivity,
              updatedAt: new Date()
            }
          },
          upsert: true
        }
      });
    }

    try {
      // Can be empty now that all-zero days are skipped - bulkWrite rejects an empty batch.
      if (operations.length > 0) {
        await this.modStats.bulkWrite(operations, { ordered: false });
      }
    } catch (err) {
      console.error('[DB] recordDailyModeratorStats error:', err);
    }
  }

  // --- Chat word / @mention stats -------------------------------------------------------
  //
  // Writes are COALESCED rather than issued per message. Done naively, one message would fan
  // out into up to (30 words + 5 mentions) x 2 rows (daily + all-time) = ~70 upserts; on a busy
  // channel that is hundreds of upserts a second against a 2GB VPS, for data nobody reads in
  // real time. Instead each message just increments counters in an in-memory Map, and a timer
  // flushes the aggregate every TEXT_STATS_FLUSH_INTERVAL_MS. Repeats of the same word inside
  // the window collapse into a single $inc, which is where most of the saving comes from.
  //
  // Consequence, and it's the right trade for stats: up to one flush interval of counts is lost
  // if the process dies, and a failed flush drops that batch. Both are consistent with the
  // fire-and-forget, never-block-chat convention used by every other counter in this file.
  // Barred from the word cloud: anything this channel tracks or has ever tracked as an emote.
  // Broader than isInWhiteList() on purpose - see emoteExclusionCache in the constructor.
  isTrackedEmote(channel, token) {
    return this.emoteExclusionCache.get(channel)?.has(String(token).toLowerCase()) ?? false;
  }

  // `message` here is the STAT text, not the raw line: addMessage() has already blanked out any
  // GIF spans (shared/textStats.js). Passing a raw line with a GIF in it puts the GIPHY title's
  // words into the cloud.
  bufferTextStats(userId, userName, message, channel, timestamp) {
    const day = dayBucket(timestamp).getTime();

    // Every message counts here, including pure-emote/command ones that produce no words or
    // mentions below - same semantics as the UserLifetimeStats counter this sits beside.
    const countKey = `${channel}${KEY_SEP}${userId}${KEY_SEP}${day}`;
    this.messageCountBuffer.set(countKey, (this.messageCountBuffer.get(countKey) || 0) + 1);

    const words = extractWords(message, (word) => this.isTrackedEmote(channel, word));
    const mentions = extractMentions(message, [userName]);
    for (const word of words) {
      const key = `${channel}${KEY_SEP}${word}${KEY_SEP}${day}`;
      this.wordBuffer.set(key, (this.wordBuffer.get(key) || 0) + 1);
    }
    for (const login of mentions) {
      const key = `${channel}${KEY_SEP}${login}${KEY_SEP}${day}`;
      this.mentionBuffer.set(key, (this.mentionBuffer.get(key) || 0) + 1);
    }

    this.scheduleTextStatsFlush();
  }

  scheduleTextStatsFlush() {
    if (this.textStatsFlushTimer) return;
    this.textStatsFlushTimer = setTimeout(() => {
      this.textStatsFlushTimer = null;
      this.flushTextStats().catch((err) => console.error('[DB] flushTextStats error:', err));
    }, TEXT_STATS_FLUSH_INTERVAL_MS);
    // Don't let a pending stats flush hold the event loop open - one-off scripts that require
    // this module (scripts/AddModerators.js, the backfill) must still be able to exit.
    this.textStatsFlushTimer.unref?.();
  }

  // Swap-then-write: the buffers are emptied before the await so counts arriving during the
  // flush accumulate into the next batch instead of being double-counted or lost.
  async flushTextStats() {
    if (
      this.wordBuffer.size === 0 &&
      this.mentionBuffer.size === 0 &&
      this.messageCountBuffer.size === 0 &&
      this.exclusionBuffer.size === 0
    ) return;

    const words = this.wordBuffer;
    const mentions = this.mentionBuffer;
    const messageCounts = this.messageCountBuffer;
    const exclusions = this.exclusionBuffer;
    this.wordBuffer = new Map();
    this.mentionBuffer = new Map();
    this.messageCountBuffer = new Map();
    this.exclusionBuffer = new Map();

    await this.ensureInitialized();

    const buildOps = (buffer, field) => {
      const ops = [];
      for (const [key, count] of buffer) {
        const [channel, value, day] = key.split(KEY_SEP);
        const date = new Date(Number(day));
        // The daily row and the all-time row differ only by their `date`; the all-time one uses
        // the epoch sentinel so "top N ever" stays a single indexed scan (see initialize()).
        for (const bucket of [date, LIFETIME_BUCKET]) {
          ops.push({
            updateOne: {
              filter: { channel, [field]: value, date: bucket },
              update: { $inc: { count }, $set: { lastUsed: new Date() } },
              upsert: true,
            },
          });
        }
      }
      return ops;
    };

    const wordOps = buildOps(words, 'word');
    const mentionOps = buildOps(mentions, 'mentionedLogin');
    const messageCountOps = buildOps(messageCounts, 'userId');

    const exclusionOps = [];
    for (const key of exclusions.keys()) {
      const [channel, word] = key.split(KEY_SEP);
      exclusionOps.push({
        updateOne: {
          filter: { channel, word },
          update: { $setOnInsert: { channel, word, createdAt: new Date() } },
          upsert: true,
        },
      });
    }

    await Promise.all([
      wordOps.length
        ? this.chatWordStats.bulkWrite(wordOps, { ordered: false })
            .catch((err) => console.error('[DB] chatWordStats bulk write error:', err))
        : null,
      mentionOps.length
        ? this.userMentionStats.bulkWrite(mentionOps, { ordered: false })
            .catch((err) => console.error('[DB] userMentionStats bulk write error:', err))
        : null,
      messageCountOps.length
        ? this.userDailyMessageStats.bulkWrite(messageCountOps, { ordered: false })
            .catch((err) => console.error('[DB] userDailyMessageStats bulk write error:', err))
        : null,
      exclusionOps.length
        ? this.emoteExclusions.bulkWrite(exclusionOps, { ordered: false })
            .catch((err) => console.error('[DB] emoteExclusions bulk write error:', err))
        : null,
    ]);
  }

  async getModeratorsList(channelId) {
    await this.ensureInitialized();
    try {
      const answer = await this.modList.findOne(
        {channelId: channelId}
      );
      return answer;
    } catch (err) {
      console.error('[DB] Error:', err);
    }
  }

  async updateModeratorList(channelId, ModList) {
    await this.ensureInitialized();
    try {
      const result = await this.modList.updateOne(
        {channelId: channelId},
        {
          $set: {
            channelId: channelId,
            moderators: ModList,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
      console.log(result);
    } catch (err) {
      console.error('[DB]',err);
      }
  }

  async addModerator(channelId, userId) {
    await this.ensureInitialized();
    try {
      await this.modList.updateOne(
        { channelId },
        { $addToSet: { moderators: userId }, $set: { updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (err) {
      console.error('[DB] addModerator error:', err);
    }
  }

  async removeModerator(channelId, userId) {
    await this.ensureInitialized();
    try {
      await this.modList.updateOne(
        { channelId },
        { $pull: { moderators: userId }, $set: { updatedAt: new Date() } }
      );
    } catch (err) {
      console.error('[DB] removeModerator error:', err);
    }
  }

  async addModeratorAction(channel, modID, userId, action, timestamp, reason, expiresAt = null) {
    await this.ensureInitialized();
    const User_msg = await this.messagesCollection.findOne(
      {'userId': userId, 'channel': `#${channel}`},
      {sort: {timestamp: -1}}
    );
    // User_msg is null when the moderated user never posted in this channel
    // (e.g. a proactive ban with no prior chat history).
    const TTA = User_msg ? timestamp - new Date(User_msg.timestamp) : null;
    // Only meaningful for timeouts - the severity scale needs the duration, but Twitch's
    // EventSub payload only gives an expiry timestamp, so derive it relative to the action.
    const durationMs = action === 'timeout' && expiresAt ? expiresAt - timestamp : null;
    this.modLogs.insertOne({channel, modID, userId, action, reason, timestamp, TTA, durationMs, messageId: User_msg?._id ?? null})
      .catch(err => console.error('[DB] modLogs insert error:', err));
  }

  // Fire-and-forget counter for "commands executed" site-wide stats (TwitchBot-Web
  // home page) - incremented once per message any handler in execCommands() resolves
  // (built-ins, custom commands, and mini-games alike), so it must never block chat handling.
  async incrementCommandCount(channel) {
    await this.ensureInitialized();
    this.commandStats.updateOne(
      { channel },
      { $inc: { count: 1 }, $set: { lastUsed: new Date() } },
      { upsert: true }
    ).catch(err => console.error('[DB] incrementCommandCount error:', err));
  }

  async isCommandExist(channel, command) {
    await this.ensureInitialized();
    return !! await this.customCommandsCollection.findOne( {channel:channel, command:command} );
  }

  async getAllCommands(channel) {
    await this.ensureInitialized();
    var CommandsDict = {}
    var Info = await this.customCommandsCollection.find({channel: channel}).toArray();
    for (const command of Info) {
        CommandsDict[command["command"]] = {
          result: command["result"],
          timer: command["timer"],
          pin: command["pin"] || false,
          announce: command["announce"] || false,
          announceColor: command["announceColor"] || "primary",
          // enabled/categoryTexts/modOnly/aliases are web-panel-only (TwitchBot-Web's
          // /<channel>/commands) - chat has no command that sets any of them, so a doc predating
          // one of these features just gets the defaults.
          enabled: command["enabled"] !== false,
          categoryTexts: command["categoryTexts"] || [],
          modOnly: command["modOnly"] === true,
          aliases: Array.isArray(command["aliases"]) ? command["aliases"] : [],
        };
    }
    return CommandsDict;
  }

  async addNewCustomCommand(channel, command, result, timer = null, pin = false, announce = false, announceColor = "primary") {
    await this.ensureInitialized();
    this.customCommandsCollection.insertOne({channel, command, result, timer, pin, announce, announceColor, enabled: true, categoryTexts: [], modOnly: false, aliases: []})
      .catch(err => console.error('[DB] addNewCustomCommand error:', err));
  }



  async deleteCustomCommand(channel, command) {
    await this.ensureInitialized();
    this.customCommandsCollection.deleteOne({channel:channel,command:command})
      .catch(err => console.error('[DB] deleteCustomCommand error:', err));
  }

  async editCustomCommand(channel, command, new_result, new_timer = null, new_pin = false, new_announce = false, new_announceColor = "primary", new_enabled = true, new_categoryTexts = [], new_modOnly = false, new_aliases = []) {
    await this.ensureInitialized();
    this.customCommandsCollection.updateOne({channel:channel, command:command},
    {
      $set:
      {
        result: new_result,
        timer: new_timer,
        pin: new_pin,
        announce: new_announce,
        announceColor: new_announceColor,
        enabled: new_enabled,
        categoryTexts: new_categoryTexts,
        modOnly: new_modOnly,
        aliases: new_aliases
      }
    }).catch(err => console.error('[DB] editCustomCommand error:', err));
  }
  
  selectPeriod(period) {
    let startDate = new Date();
    switch (period) {
      case 'day':
        break;
      case 'week':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate.setMonth(startDate.getMonth() - 1);
        break;
      case 'all':
        startDate = new Date(0);
        break;
      default:
        break;
    }
    startDate.setHours(0,0,0,0);
    return startDate;
  }

  async countWordOccurrences(word, channel, period) {
    await this.ensureInitialized();
    
    // Create date range based on period
    let startDate = this.selectPeriod(period);
    const endDate = new Date();
    // Create regex to match the whole word (case insensitive)
    const escapedWord = word.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const wordRegex = new RegExp(`(^|[^\\p{L}])${escapedWord}([^\\p{L}]|$)`, 'iu');
    // Build query
    const query = {
      channel,
      message: wordRegex
    };
    
    if (startDate) {
      query.timestamp = { $gte: startDate, $lte: endDate };
    }
    
    // Count matching messages
    const count = await this.messagesCollection.countDocuments(query);
    return count;
  }

  // Exclusion is append-only: a 7TV set that drops an emote stops it being COUNTED, but it must
  // stay barred from the word cloud, because the chat still uses it and its counts once existed.
  // Un-excluding it would let it resurface as a fake "word". Besides the in-memory cache, each
  // pair is buffered into the persistent EmoteExclusions tombstones (flushed with the text-stats
  // batch, never awaited here) - pruneUntrackedEmoteStats() deletes the WordLifetimeStats rows
  // the exclusion used to be derivable from, so the tombstone is what makes it survive restarts.
  // Returns true when the word was NEW to the exclusion set - the cache is seeded at startup
  // from the full whiteList ∪ WordLifetimeStats ∪ EmoteExclusions union, so "new here" means
  // "was never excluded by any mechanism", which is exactly the population whose accumulated
  // ChatWordStats rows need purging (see purgeWordStatsForEmotes).
  rememberEmote(channel, word) {
    if (!this.emoteExclusionCache.has(channel)) this.emoteExclusionCache.set(channel, new Set());
    const lowered = String(word).toLowerCase();
    if (this.emoteExclusionCache.get(channel).has(lowered)) return false;
    this.emoteExclusionCache.get(channel).add(lowered);
    this.exclusionBuffer.set(`${channel}${KEY_SEP}${lowered}`, true);
    this.scheduleTextStatsFlush();
    return true;
  }

  // Retroactive word-cloud cleanup: a token that chat used BEFORE it became a tracked emote has
  // been accumulating in ChatWordStats as an ordinary "word", and the exclusion cache only stops
  // FUTURE counting. Deleting by {channel, word} (no date) removes the daily rows and the
  // epoch-sentinel all-time row in one call, riding the {channel, word, date} unique index's
  // prefix. Never throws - a failed purge must not fail the emote sync it runs inside; the
  // exclusion tombstone is already buffered, so the emote stays out of the cloud either way
  // (the stale rows would just survive until the emote is next "new" somewhere).
  async purgeWordStatsForEmotes(channel, loweredWords) {
    if (!loweredWords || loweredWords.length === 0) return { purged: 0 };
    try {
      // Sweep the pending flush buffer too: a count buffered in the current <=5s window would
      // otherwise be upserted right back after the delete.
      const purgeSet = new Set(loweredWords);
      for (const key of [...this.wordBuffer.keys()]) {
        const [keyChannel, word] = key.split(KEY_SEP);
        if (keyChannel === channel && purgeSet.has(word)) this.wordBuffer.delete(key);
      }
      const result = await this.chatWordStats.deleteMany({ channel, word: { $in: loweredWords } });
      if (result.deletedCount > 0) {
        console.log(`[Emotes] Purged ${result.deletedCount} word-stat row(s) for ${loweredWords.length} newly-excluded emote(s) in ${channel}`);
      }
      return { purged: result.deletedCount };
    } catch (err) {
      console.error(`[Emotes] purgeWordStatsForEmotes failed for ${channel}:`, err);
      return { purged: 0 };
    }
  }

  isInWhiteList(channel, word) {
    return this.whiteListCache.get(channel)?.has(word) ?? false;
  }

  // Считается ли токен смайликом ЭТОГО канала: свой набор плюс чужие подписочные, замеченные
  // здесь в чате. Одна проверка на оба множества, потому что для счётчиков разницы нет - обе
  // половины попадают в один и тот же индекс `words`/WordLifetimeStats.
  isCountedEmote(channel, word) {
    return this.isInWhiteList(channel, word) || (this.externalEmoteCache.get(channel)?.has(word) ?? false);
  }

  /**
   * Заводит в реестр смайлики Twitch, которых у канала нет в наборе (см. EXTERNAL_EMOTE_SOURCE).
   *
   * Синхронная часть - кэши, и это не оптимизация: вызывающий (addMessage) сразу после этого
   * считает слова и смайлики ТОГО ЖЕ сообщения, а первое появление смайлика должно быть уже
   * смайликом. Она же и защита от гонки: имя, положенное в кэш здесь, не даст соседнему
   * сообщению завести строку второй раз, пока не вернулась запись в базу.
   *
   * @param {{id: string, name: string}[]} emotes - из shared/textStats.js parseEmotesTag.
   */
  learnExternalEmotes(channel, emotes) {
    if (!emotes || emotes.length === 0) return;

    const fresh = [];
    for (const emote of emotes) {
      if (this.isCountedEmote(channel, emote.name)) continue;
      if (!this.externalEmoteCache.has(channel)) this.externalEmoteCache.set(channel, new Map());
      this.externalEmoteCache.get(channel).set(emote.name, emote.id);
      fresh.push(emote);
    }
    if (fresh.length === 0) return;

    // Те, что до сих пор вообще ни за что не считались смайликами, всё это время копились в
    // ChatWordStats как обычные слова - их накопленное надо перенести (см. миграцию ниже).
    // Остальные (например, уже прибранные тумбстоуном) переносить нечего.
    const unseen = fresh.filter(emote => this.rememberEmote(channel, emote.name)).map(emote => emote.name);

    this.persistExternalEmotes(channel, fresh)
      .then(() => this.migrateWordStatsToEmoteIndex(channel, unseen))
      .catch(err => console.error('[Emotes] learnExternalEmotes failed:', err));
  }

  // Строка реестра пишется ТОЛЬКО при вставке: если имя уже занято строкой другого источника
  // (глобальный смайлик Twitch, набор канала), она не наша и трогать её нечем - картинка и
  // происхождение у неё уже есть. Так же это делает запись идемпотентной при гонке двух
  // сообщений с одним и тем же новым смайликом.
  async persistExternalEmotes(channel, emotes) {
    await this.ensureInitialized();
    await this.whiteListCollection.bulkWrite(emotes.map(emote => ({
      updateOne: {
        filter: { channel, word: emote.name },
        update: {
          $setOnInsert: {
            channel,
            word: emote.name,
            source: EXTERNAL_EMOTE_SOURCE,
            // Единственный ключ к картинке: у сайта нет набора, в котором этот смайлик лежит.
            emoteId: emote.id,
            firstSeen: new Date(),
          },
        },
        upsert: true,
      },
    })), { ordered: false });
    console.log(`[Emotes] ${channel}: learnt ${emotes.length} foreign Twitch emote(s): ${emotes.map(e => e.name).join(', ')}`);
  }

  /**
   * Переносит накопленное словом в индекс смайликов - для токена, который только что стал
   * смайликом, а до этого копился в ChatWordStats.
   *
   * Перенос, а не удаление (purgeWordStatsForEmotes), потому что обе коллекции считают ОДНО И
   * ТО ЖЕ: «в скольких сообщениях встретился токен», раз на сообщение. Число уже посчитано и
   * верно - удалить его значит выбросить историю смайлика ровно в тот момент, когда мы наконец
   * узнали, что это смайлик (у `otirahi` на #mistercop это 1079 сообщений). Дневные строки
   * ложатся в `words` по своей дате: обе коллекции бьют день по полудню (dayBucket), так что
   * даты совпадают без пересчёта. Строка-сентинел эпохи - в WordLifetimeStats.
   *
   * Никогда не бросает: перенос - уборка, а не часть учёта сообщения.
   *
   * @param {string[]} words - написания, которыми смайлик рисуется (ChatWordStats хранит
   *   строчное, индекс смайликов - настоящее).
   */
  async migrateWordStatsToEmoteIndex(channel, words) {
    if (!words || words.length === 0) return { moved: 0 };
    try {
      await this.ensureInitialized();
      const canonicalByLowered = new Map(words.map(word => [String(word).toLowerCase(), word]));
      const lowered = [...canonicalByLowered.keys()];
      const rows = await this.chatWordStats.find({ channel, word: { $in: lowered } }).toArray();
      if (rows.length === 0) return { moved: 0 };

      const dailyOps = [];
      const lifetimeOps = [];
      let moved = 0;
      for (const row of rows) {
        const word = canonicalByLowered.get(row.word);
        const count = Number(row.count) || 0;
        if (!word || count <= 0) continue;
        moved += count;
        if (row.date instanceof Date && row.date.getTime() === LIFETIME_BUCKET.getTime()) {
          lifetimeOps.push({
            updateOne: {
              filter: { channel, word },
              update: { $inc: { count }, $max: { lastUsed: row.lastUsed instanceof Date ? row.lastUsed : new Date(0) } },
              upsert: true,
            },
          });
        } else {
          dailyOps.push({
            updateOne: { filter: { channel, word, date: row.date }, update: { $inc: { count } }, upsert: true },
          });
        }
      }

      if (dailyOps.length > 0) await this.wordsCollection.bulkWrite(dailyOps, { ordered: false });
      if (lifetimeOps.length > 0) await this.wordLifetimeStats.bulkWrite(lifetimeOps, { ordered: false });
      // Снос словарных строк - тем же кодом, что и всегда: он ещё и подметает буфер, в котором
      // могло осесть несколько секунд счёта, иначе они вернулись бы обратно после удаления.
      await this.purgeWordStatsForEmotes(channel, lowered);
      if (moved > 0) {
        console.log(`[Emotes] ${channel}: moved ${moved} message-count(s) of ${lifetimeOps.length} token(s) from the word index to the emote index`);
      }
      return { moved };
    } catch (err) {
      console.error(`[Emotes] migrateWordStatsToEmoteIndex failed for ${channel}:`, err);
      return { moved: 0 };
    }
  }

  // Строчное написание -> написание из набора канала. Пересобирается целиком, а не правится по
  // одному слову: набор одного канала - несколько сотен строк, а два места, где он меняется
  // (загрузка и синхронизация), обязаны давать одинаковый индекс.
  //
  // Столкновение регистров реально: в глобальном наборе Twitch лежат и «:p», и «:P», и все
  // четыре написания «o.O». Побеждает первое встреченное, и это безопасно ровно потому, что
  // столкнуться могут только НАСТОЯЩИЕ смайлики - любое из них нарисуется.
  reindexEmoteSpellings(channel) {
    const spellings = new Map();
    for (const word of this.whiteListCache.get(channel) || []) {
      const key = String(word).toLowerCase();
      if (!spellings.has(key)) spellings.set(key, word);
    }
    this.emoteSpellingCache.set(channel, spellings);
  }

  // Как этот смайлик пишется на самом деле, или null, если такого смайлика у канала нет.
  //
  // Точное написание проверяется первым: канал, у которого есть и «SVIN», и «svin», должен
  // получить обратно ровно то, что ему написали, а не то, что первым попало в индекс.
  canonicalEmote(channel, word) {
    const token = String(word ?? '');
    if (!token) return null;
    if (this.isInWhiteList(channel, token)) return token;
    return this.emoteSpellingCache.get(channel)?.get(token.toLowerCase()) ?? null;
  }

  // Makes `channel`'s whitelist entries FOR ONE SOURCE exactly match `words`: upserts the current
  // ones, drops the ones that source no longer lists, and leaves every other source alone.
  //
  // `source` is the isolation boundary, and that is the whole point of this being generic. The
  // whitelist holds four independent populations:
  //   'manual'         - added by a mod with the (since-removed) !addword command. The command is
  //                      gone but its rows persist and must still never be touched by any sync.
  //   '7tv'            - the channel's own 7TV emote set.
  //   'twitch-global'  - Twitch's official global emotes (Kappa, LUL, ...), the same for every
  //                      channel, so they're written per-channel but fetched once.
  //   'twitch-channel' - the broadcaster's own Twitch emotes (sub tiers, bits, follower), fetched
  //                      and written per-channel since they genuinely differ per broadcaster.
  // A sync of one must never delete another's rows, which is why the stale-delete below is
  // scoped by `source` and not just by `channel`.
  //
  // Collisions: the unique index is {channel, word}, so if two sources ship the same name, the
  // LAST sync to run owns the row. emoteSyncScheduler.syncNow() syncs globals, then channel
  // emotes, then 7TV last, precisely so the channel's own 7TV set wins - a 7TV set is the most
  // deliberately curated of the three, so it's the most meaningful attribution on a collision.
  async syncEmoteSource(channel, source, words, extraFields = {}) {
    await this.ensureInitialized();
    const wordSet = new Set(words);

    const existing = await this.whiteListCollection.find({ channel, source }).toArray();
    const staleWords = existing.filter(item => !wordSet.has(item.word)).map(item => item.word);

    if (staleWords.length > 0) {
      await this.whiteListCollection.deleteMany({ channel, source, word: { $in: staleWords } });
    }

    if (words.length > 0) {
      await this.whiteListCollection.bulkWrite(words.map(word => ({
        updateOne: {
          filter: { channel, word },
          update: { $set: { channel, word, source, ...extraFields } },
          upsert: true
        }
      })));
    }

    const cacheSet = this.whiteListCache.get(channel) || new Set();
    staleWords.forEach(word => cacheSet.delete(word));
    wordSet.forEach(word => cacheSet.add(word));
    this.whiteListCache.set(channel, cacheSet);
    this.reindexEmoteSpellings(channel);
    // staleWords are intentionally NOT un-excluded from the word cloud - see rememberEmote().
    // Words that are NEW to the exclusion set were, until now, being counted into ChatWordStats
    // as ordinary words - move those counts into the emote index, so the emote leaves the word
    // cloud retroactively AND arrives in the emote cloud with the history it actually has.
    const newlyExcluded = [];
    wordSet.forEach(word => {
      if (this.rememberEmote(channel, word)) newlyExcluded.push(word);
    });
    if (newlyExcluded.length > 0) {
      await this.migrateWordStatsToEmoteIndex(channel, newlyExcluded);
    }

    return { synced: words.length, removed: staleWords.length };
  }

  async syncSevenTvEmoteSet(channel, setId, words) {
    return this.syncEmoteSource(channel, '7tv', words, { setId });
  }

  // The three browser-extension emote providers. Each is ONE source per provider even though it
  // covers that provider's channel set AND its global one: both are fetched in a single call, so
  // one source is what keeps "the source's rows are exactly this list" true.
  async syncSevenTvGlobalEmotes(channel, words) {
    return this.syncEmoteSource(channel, '7tv-global', words);
  }

  async syncBttvEmotes(channel, words) {
    return this.syncEmoteSource(channel, 'bttv', words);
  }

  async syncFfzEmotes(channel, words) {
    return this.syncEmoteSource(channel, 'ffz', words);
  }

  // Deletes the accumulated stats (words + WordLifetimeStats) of every emote the channel no
  // longer tracks under ANY source, so un-tracked emotes stop showing on the web emote cloud.
  // Must only run after this channel's syncs succeeded - index.js chains it after both - since
  // the whitelist is the reference for what "tracked" means. Tombstones are written BEFORE the
  // delete so a crash in between can never un-exclude an emote from the word cloud.
  async pruneUntrackedEmoteStats(channel) {
    await this.ensureInitialized();

    const whitelisted = new Set(
      (await this.whiteListCollection.find({ channel }, { projection: { word: 1 } }).toArray())
        .map(item => item.word)
    );
    // A successful global-emote sync alone leaves ~290 rows, so an empty whitelist here means
    // something upstream went wrong - sweeping now would delete the channel's entire emote
    // history. Skip rather than trust it.
    if (whitelisted.size === 0) {
      console.warn(`[Emotes] Prune skipped for ${channel}: whitelist is empty`);
      return { pruned: 0 };
    }

    const [lifetimeWords, dailyWords] = await Promise.all([
      this.wordLifetimeStats.distinct('word', { channel }),
      this.wordsCollection.distinct('word', { channel }),
    ]);
    const orphans = [...new Set([...lifetimeWords, ...dailyWords])].filter(word => !whitelisted.has(word));
    if (orphans.length === 0) return { pruned: 0 };

    await this.emoteExclusions.bulkWrite(orphans.map(word => ({
      updateOne: {
        filter: { channel, word: String(word).toLowerCase() },
        update: { $setOnInsert: { channel, word: String(word).toLowerCase(), createdAt: new Date() } },
        upsert: true,
      },
    })), { ordered: false });

    await Promise.all([
      this.wordsCollection.deleteMany({ channel, word: { $in: orphans } }),
      this.wordLifetimeStats.deleteMany({ channel, word: { $in: orphans } }),
    ]);

    // Keep the in-memory exclusion set consistent (usually a no-op - initialize() already read
    // these words out of WordLifetimeStats before they were deleted).
    orphans.forEach(word => this.rememberEmote(channel, word));

    console.log(`[Emotes] Pruned ${orphans.length} un-tracked emote(s) from ${channel}'s stats`);
    return { pruned: orphans.length };
  }

  // Twitch's official global emotes. They are identical for every channel, so the caller fetches
  // the list once (twitch/globalEmotes.js caches it) and calls this per channel - the counters in
  // `words`/`WordLifetimeStats` are per-channel, so the rows have to be too.
  async syncTwitchGlobalEmotes(channel, words) {
    return this.syncEmoteSource(channel, 'twitch-global', words);
  }

  // The broadcaster's own Twitch emotes (sub tiers, bits/cheer, follower) - see
  // twitch/channelEmotes.js. Unlike syncTwitchGlobalEmotes, the words differ per channel, so
  // there's no shared-fetch caller pattern here - each channel fetches and syncs its own.
  async syncTwitchChannelEmotes(channel, words) {
    return this.syncEmoteSource(channel, 'twitch-channel', words);
  }

  // Ник -> человек, если он вообще писал в ЭТОМ канале. Нужен памяти о зрителях: рассказывают в
  // чате и про тех, кто сегодня молчит, а «нет в последних пяти строках» не доказывает, что такого
  // ника не существует.
  //
  // Две коллекции, а не одна, потому что они отвечают на разные вопросы. UserIdentities общая на
  // все каналы и говорит только «такой человек боту известен»; без второй проверки факт можно было
  // бы завести на любого, кого бот видел где угодно, и он бы всплывал в чужом чате. UserLifetimeStats
  // ключуется {channel, userId} и говорит «он писал именно здесь» - это и есть нужное условие.
  //
  // История ников просматривается наравне с текущим: сослаться могут на старое имя, а человек тот же.
  async findUserByLogin(channel, login) {
    await this.ensureInitialized();
    const name = String(login || '').replace('@', '').trim().toLowerCase();
    if (!name) return null;

    const identity =
      (await this.userIdentities.findOne({ currentUserName: name })) ||
      (await this.userIdentities.findOne({ 'nicknames.name': name }));
    if (!identity) return null;

    // Канал может быть и списком: память о зрителях читается по пулу каналов, делящих её между
    // собой (games/aiReply.js:memoryPool). UserIdentities глобальна, и без этой проверки «есть ли
    // такой человек» отвечало бы «да» про любого, кто когда-либо писал в любом чате.
    const channels = Array.isArray(channel) ? channel : [channel];
    const seenHere = await this.userLifetimeStats.findOne(
      { channel: { $in: channels }, userId: identity.userId },
      { projection: { _id: 1 } }
    );
    if (!seenHere) return null;

    // Отдаём тот ник, под которым человек известен сейчас, а не тот, которым его назвали: строка
    // памяти подписывается им же, и в админке человек должен узнаваться по актуальному имени.
    return { userId: String(identity.userId), login: String(identity.currentUserName || name).toLowerCase() };
  }

  async recordUserIdentity(userId, userName, timestamp) {
    const updateResult = await this.userIdentities.updateOne(
      { userId, 'nicknames.name': userName },
      { $set: { 'nicknames.$.lastSeen': timestamp, currentUserName: userName } }
    );
    if (updateResult.matchedCount > 0) return;

    await this.userIdentities.updateOne(
      { userId },
      {
        $set: { currentUserName: userName },
        $setOnInsert: { userId, firstSeen: timestamp },
        $push: { nicknames: { name: userName, firstSeen: timestamp, lastSeen: timestamp } }
      },
      { upsert: true }
    );
  }

  // `gifsTag` is Twitch's raw `gifs` tag (T2/T3 subscriber GIFs). It is stored parsed and, more
  // importantly, kept OUT of the text stats: see shared/textStats.js. The tag is the only thing
  // that tells a real GIF from a viewer typing the same bracketed title by hand, so it is stored
  // rather than merely consumed - the site's per-user word cloud tokenizes `messages` at READ
  // time (TwitchBot-Web/db/wordStatsRepo.js) and would otherwise re-introduce exactly the
  // pollution stripped here. The GIF's id and URL exist nowhere else once the line is written.
  async addMessage(userId, userName, message, channel, gifsTag, emotesTag) {
    await this.ensureInitialized();

    const timestamp = new Date();
    const gifs = parseGifTag(gifsTag);
    // Every Twitch emote Twitch itself recognised in this line, id and all - including the ones
    // no list of ours could ever hold (another broadcaster's sub/bits/follower emotes). Learnt
    // BEFORE the counters below run, so this very message already counts them as emotes instead
    // of first putting them in the word cloud and taking them out on the next sighting.
    this.learnExternalEmotes(channel, parseEmotesTag(emotesTag, message));
    // Everything the stat counters below see, with the GIF titles blanked out. The document
    // itself keeps `message` verbatim - it is what the viewer actually sent, and the site
    // displays it.
    const statText = stripGifSpans(message, gifs);

    this.messagesCollection.insertOne({
      userId,
      userName,
      message,
      channel,
      timestamp,
      // Absent on the overwhelming majority of messages; only set when Twitch says so.
      ...(gifs.length > 0 ? { gifs } : {})
    }).catch(err => console.error('[DB] messagesCollection insert error:', err));

    this.userLifetimeStats.updateOne(
      { channel, userId },
      { $inc: { messageCount: 1 }, $set: { lastSeen: timestamp } },
      { upsert: true }
    ).catch(err => console.error('[DB] userLifetimeStats update error:', err));

    this.recordUserIdentity(userId, userName, timestamp)
      .catch(err => console.error('[DB] userIdentities update error:', err));

    // Word-frequency + @mention counters for the web panel's clouds and mention tracker.
    // Purely in-memory here (no await, no I/O) - the actual Mongo write is the coalesced
    // flush a few seconds later, so this costs the chat path a tokenize and a few Map sets.
    this.bufferTextStats(userId, userName, statText, channel, timestamp);

    // Twitch only ever renders emotes/smileys as their own whitespace-delimited
    // token anyway, so a plain split is enough - no regex needed.
    const candidateWords = new Set();
    for (const token of statText.trim().split(/\s+/)) {
      if (token.length > 0) candidateWords.add(token);
    }

    // Each word counts at most once per message, even if repeated in it.
    const allowedWords = [...candidateWords].filter(word => this.isCountedEmote(channel, word));

    if (allowedWords.length > 0) {
      const today = new Date();
      today.setHours(12, 0, 0, 0);

      const dailyOperations = allowedWords.map(word => ({
        updateOne: {
          filter: { word, channel, date: today },
          update: { $inc: { count: 1 } },
          upsert: true
        }
      }));
      this.wordsCollection.bulkWrite(dailyOperations, { ordered: false }).catch(err => {
        console.error('Bulk write error', err);
      });

      const lifetimeOperations = allowedWords.map(word => ({
        updateOne: {
          filter: { word, channel },
          update: { $inc: { count: 1 }, $set: { lastUsed: timestamp } },
          upsert: true
        }
      }));
      this.wordLifetimeStats.bulkWrite(lifetimeOperations, { ordered: false }).then(result => {
        // Site-wide running total (TwitchBot-Web home page) - upsertedCount is how many
        // of these {channel, word} pairs were brand new, so the same emote signature
        // added in two different channels correctly counts as two separate entries.
        this.globalEmoteStats.updateOne(
          { _id: 'global' },
          {
            $inc: { totalUsageCount: allowedWords.length, totalEntriesAdded: result.upsertedCount || 0 },
            $set: { updatedAt: new Date() }
          },
          { upsert: true }
        ).catch(err => console.error('[DB] globalEmoteStats update error:', err));
      }).catch(err => {
        console.error('[DB] wordLifetimeStats bulk write error:', err);
      });
    }
  }

  // Distinct senders of an actual chat message in `channel` (with leading `#`) since `sinceDate`,
  // each with the timestamp of their most recent message in the window.
  // Used by the Бюро амнистии sniper (twitch/unbanRequestScheduler.js, 2-minute window) so its
  // target pool is "who is actually talking right now", not Twitch's Get Chatters list - that list
  // includes silent lurkers with the chat window merely open, which is how the sniper could
  // previously land on someone who hadn't typed in days. `last_message_at` is what lets that pool
  // be weighted towards whoever spoke most recently instead of drawn flat. Backed by the existing
  // {channel:1, timestamp:-1, userId:1} index, so this is a covered range scan, not a collection scan.
  async getRecentChatters(channel, sinceDate) {
    await this.ensureInitialized();
    const rows = await this.messagesCollection.aggregate([
      { $match: { channel, timestamp: { $gte: sinceDate } } },
      {
        $group: {
          _id: '$userId',
          userName: { $last: '$userName' },
          lastMessageAt: { $max: '$timestamp' },
        },
      },
    ]).toArray();
    return rows.map(row => ({
      user_id: row._id,
      user_login: row.userName,
      last_message_at: row.lastMessageAt,
    }));
  }

  // Which of `userIds` were banned or timed out in `channel` (WITHOUT a leading `#`, the
  // ModeratorActionLogs convention) since `sinceDate`, and are still serving it now.
  //
  // This replaces a Helix "Get Banned Users" call the sniper used to make (2026-08-12). That
  // endpoint can never work from this bot: `broadcaster_id` must equal the token's own user id,
  // so a moderator token asking about the channel it moderates gets 401 "incorrect user
  // authorization" - which is exactly what prod was logging, several times per shot, while the
  // call silently degraded to "nobody is banned" and the guard did nothing at all.
  //
  // Our own log is a fair substitute HERE specifically because of how narrow the question is.
  // EventSub's `channel.moderate` reports every ban/timeout in the channel no matter who issued
  // it - including a human moderator using Twitch's native UI, which is the case the Helix call
  // was reached for - and the sniper only asks about people who sent a chat message inside the
  // last couple of minutes, so any punishment that matters was necessarily issued inside that
  // same window and would have arrived over that subscription. (Two known gaps, both harmless:
  // an EventSub outage across the window loses a punishment, and `unban`/`untimeout` aren't
  // recorded at all, so a ban lifted seconds later still excludes that candidate. Both cost at
  // most one skipped candidate out of the pool.)
  //
  // Backed by the existing {channel:1, timestamp:-1, userId:1} index.
  async getPunishedUserIds(channel, userIds, sinceDate) {
    await this.ensureInitialized();
    const ids = [...new Set(userIds.map(String))];
    if (!ids.length) return new Set();

    const rows = await this.modLogs.find(
      {
        channel,
        timestamp: { $gte: sinceDate },
        userId: { $in: ids },
        action: { $in: ['ban', 'timeout'] },
      },
      { projection: { userId: 1, action: 1, timestamp: 1, durationMs: 1 } }
    ).toArray();

    const now = Date.now();
    const punished = new Set();
    for (const row of rows) {
      // A timeout shorter than the sniper's own activity window can already have expired by the
      // time we look, and an expired timeout is not a reason to skip anyone. A ban has no
      // duration, so it always counts.
      // A timeout with no recorded duration (no expiry in the EventSub payload) counts as still
      // serving: the uncertainty is cheap in this direction - it costs one candidate out of the
      // pool - while guessing "expired" is how the shot lands on someone already muted.
      if (row.action === 'timeout' && row.durationMs
          && new Date(row.timestamp).getTime() + row.durationMs <= now) {
        continue;
      }
      punished.add(String(row.userId));
    }
    return punished;
  }

async getUserRank(userId, channel, period) {
    await this.ensureInitialized();

    if (period === 'all') {
      const userDoc = await this.userLifetimeStats.findOne({ channel, userId });
      const userTotalMessages = userDoc?.messageCount || 0;
      const totalUsers = await this.userLifetimeStats.countDocuments({ channel });

      if (userTotalMessages === 0) {
        return { userId, totalMessages: 0, rank: null, percentage: null, totalUsers };
      }

      const usersAbove = await this.userLifetimeStats.countDocuments({ channel, messageCount: { $gt: userTotalMessages } });
      const rank = usersAbove + 1;
      const percentage = (rank / totalUsers) * 100;

      return {
        userId,
        totalMessages: userTotalMessages,
        rank,
        percentage: percentage >= 0.1 ? percentage.toFixed(2) : percentage.toFixed(4),
        totalUsers
      };
    }

    const startDate = this.selectPeriod(period);
    const now = new Date();

    // 1. Получаем количество сообщений конкретного пользователя
    const userStatsPipeline = [
      { $match: { channel, userId, timestamp: { $gte: startDate, $lte: now } } },
      { $count: "totalMessages" }
    ];
    const userStats = await this.messagesCollection.aggregate(userStatsPipeline).toArray();
    const userTotalMessages = userStats.length > 0 ? userStats[0].totalMessages : 0;

    // Получаем общее количество пользователей
    const totalUsers = await this.getUniqueUsersCount(channel, period);

    if (userTotalMessages === 0) {
      return { userId, totalMessages: 0, rank: null, percentage: null, totalUsers };
    }

    // 2. Считаем, сколько людей написали БОЛЬШЕ сообщений (это и даст нам ранг)
    const rankPipeline = [
      { $match: { channel, timestamp: { $gte: startDate, $lte: now } } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
      { $match: { count: { $gt: userTotalMessages } } },
      { $count: "usersAbove" }
    ];
    const rankResult = await this.messagesCollection.aggregate(rankPipeline).toArray();
    const usersAbove = rankResult.length > 0 ? rankResult[0].usersAbove : 0;
    
    const rank = usersAbove + 1;
    let percentage = (rank / totalUsers) * 100;

    return {
      userId,
      totalMessages: userTotalMessages,
      rank,
      percentage: percentage >= 0.1 ? percentage.toFixed(2) : percentage.toFixed(4),
      totalUsers
    };
  }

  async getTopWords(limit, channel, period) {
    await this.ensureInitialized();

    if (period === 'all') {
      const result = await this.wordLifetimeStats
        .find({ channel })
        .sort({ count: -1 })
        .limit(limit)
        .toArray();

      return result.map(item => ({ word: item.word, count: item.count }));
    }

    const startDate = this.selectPeriod(period);
    const endDate = new Date();
    endDate.setHours(23,59,59,999);
    const pipeline = [
      { 
        $match: { 
          channel,
          date: { $gte:startDate, $lte: endDate }
        }
      },
      { $group: { _id: "$word", total: { $sum: "$count" } } },
      { $sort: { total: -1 } },
      { $limit: limit }
    ];

    const result = await this.wordsCollection.aggregate(pipeline).toArray();
    return result.map(item => ({ word: item._id, count: item.total }));
  }


  //метод для получения топ пользователей
  async getTopUsers(limit, channel, period) {
    await this.ensureInitialized();

    if (period === 'all') {
      const result = await this.userLifetimeStats.aggregate([
        { $match: { channel } },
        { $sort: { messageCount: -1 } },
        { $limit: limit },
        {
          $lookup: {
            from: 'UserIdentities',
            localField: 'userId',
            foreignField: 'userId',
            as: 'identity'
          }
        }
      ]).toArray();

      return result.map(item => ({
        userId: item.userId,
        userName: item.identity[0]?.currentUserName,
        count: item.messageCount
      }));
    }

    const startDate = this.selectPeriod(period);
    const endDate = new Date();
    endDate.setHours(23,59,59,999);
    const result = await this.messagesCollection.aggregate([
      { 
        $match: {
          channel: channel,
          timestamp: { 
            $gte: startDate,
            $lte: endDate
          }
        }
      },
      { 
        $group: {
          _id: "$userId",
          userName: { $first: "$userName" },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: limit }
    ]).toArray();

    return result.map(item => ({
      userId: item._id,
      userName: item.userName,
      count: item.count
    }));
  }
//Получение количества уникальных пользователей
  async getUniqueUsersCount(channel, period) {
    await this.ensureInitialized();

    if (period === 'all') {
      try {
        return await this.userLifetimeStats.countDocuments({ channel });
      } catch (err) {
        console.error('Ошибка при получении уникальных пользователей:', err);
        return 0;
      }
    }

    const startDate = this.selectPeriod(period);
    const endDate = new Date();
    endDate.setHours(23, 59, 59, 999);
    
    const pipeline = [
      {
        $match: {
          channel: channel,
          timestamp: {
            $gte: startDate,
            $lte: endDate
          }
        }
      },
      {
        $group: {
          _id: "$userId"
        }
      },
      {
        $count: "uniqueUsersCount"
      }
    ];
    
    try {
      const result = await this.messagesCollection.aggregate(pipeline).toArray();
      return result.length > 0 ? result[0].uniqueUsersCount : 0;
    } catch (err) {
      console.error('Ошибка при получении уникальных пользователей:', err);
      return 0;
    }
  }

  // Counter methods
  async addNewCounter(channel, counter_name, access) {
    await this.ensureInitialized();
    this.countersCollection.insertOne({channel, counter_name, count: 0, access})
      .catch(err => console.error('[DB] addNewCounter error:', err));
  }

  async changeCounterAccess(channel, counter_name, new_access) {
    await this.ensureInitialized();
    this.countersCollection.updateOne({channel:channel, counter_name:counter_name},
    {
      $set: {access: new_access}
    }).catch(err => console.error('[DB] changeCounterAccess error:', err));
  }

  async isCounterExist(channel, counter_name) {
    await this.ensureInitialized();
    return !! await this.countersCollection.findOne( {channel:channel, counter_name:counter_name} );
  }

  // Atomic increment/decrement so concurrent updates to the same counter can't
  // clobber each other regardless of the order their writes reach the server -
  // unlike a read-modify-write "$set" of an absolute value, $inc is commutative.
  // Returns the post-update count (or null if the counter no longer exists).
  async incrementCounter(channel, counter_name, delta) {
    await this.ensureInitialized();
    const result = await this.countersCollection.findOneAndUpdate(
      {channel: channel, counter_name: counter_name},
      {$inc: {count: delta}},
      {returnDocument: 'after'}
    );
    return result ? result.count : null;
  }

  async deleteCounter(channel, counter_name) {
    await this.ensureInitialized();
    this.countersCollection.deleteOne({channel:channel, counter_name:counter_name})
      .catch(err => console.error('[DB] deleteCounter error:', err));
  }

  async getCounter(channel, counter_name){
    await this.ensureInitialized();
    var Counter = await this.countersCollection.find({channel: channel, counter_name: counter_name}).toArray();
    return Counter;
  }

  async getAllCounters(channel) {
    await this.ensureInitialized();
    var Counters = await this.countersCollection.find({channel: channel}).toArray();
    var CountersDict = {};
    for (const counter of Counters) {
        CountersDict[counter["counter_name"]] = {count: counter["count"], access: counter["access"]};
    }
    return CountersDict;
  }

  // Custom-command exceptions: usernames exempt from a mod-only counter's access
  // check. Shared across every custom command/counter in the channel (one list
  // per channel), rather than tracked separately per counter.
  async getCustomCommandExceptions(channel) {
    await this.ensureInitialized();
    const doc = await this.customCommandExceptions.findOne({channel});
    return doc?.users || [];
  }

  async addCustomCommandException(channel, username) {
    await this.ensureInitialized();
    await this.customCommandExceptions.updateOne(
      {channel},
      {$addToSet: {users: username}},
      {upsert: true}
    ).catch(err => console.error('[DB] addCustomCommandException error:', err));
  }

  async removeCustomCommandException(channel, username) {
    await this.ensureInitialized();
    await this.customCommandExceptions.updateOne(
      {channel},
      {$pull: {users: username}}
    ).catch(err => console.error('[DB] removeCustomCommandException error:', err));
  }

}

module.exports = new ChatStats();