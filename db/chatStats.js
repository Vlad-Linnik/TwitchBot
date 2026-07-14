const { connect } = require('./db.js');
const { extractWords, extractMentions, dayBucket, LIFETIME_BUCKET } = require('../shared/textStats.js');
const { isKnownBot } = require('../config/knownBots.js');

const MIN_TIMEOUT_MS = 1000; // 1 second, Twitch's shortest timeout
const MAX_TIMEOUT_MS = 1_209_600_000; // 1,209,600s = 2 weeks, Twitch's longest timeout

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

      await this.commandStats.createIndex({ channel: 1 }, { unique: true });
      await this.modsUpTimeStats.createIndex({ channelId: 1, userId: 1, timestamp: 1 }, { unique: true });
      await this.modsUpTimeStats.createIndex({ channelId: 1, timestamp: 1, hours: -1 });
      await this.modStats.createIndex({ channelId: 1, userId: 1, date: 1 }, { unique: true });
      await this.modList.createIndex({ channelId: 1 }, { unique: true });
      await this.modLogs.createIndex({ channel: 1, timestamp: -1, userId: 1 });
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
      const list = await this.whiteListCollection.find({}).toArray();
      this.whiteListCache = new Map();
      for (const item of list) {
        if (!this.whiteListCache.has(item.channel)) this.whiteListCache.set(item.channel, new Set());
        this.whiteListCache.get(item.channel).add(item.word);
      }

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
        .filter(tta => tta !== null && tta !== undefined && tta <= 30000);
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
        CommandsDict[command["command"]] = {result: command["result"], timer: command["timer"], pin: command["pin"] || false};
    }
    return CommandsDict;
  }

  async addNewCustomCommand(channel, command, result, timer = null, pin = false) {
    await this.ensureInitialized();
    this.customCommandsCollection.insertOne({channel, command, result, timer, pin})
      .catch(err => console.error('[DB] addNewCustomCommand error:', err));
  }



  async deleteCustomCommand(channel, command) {
    await this.ensureInitialized();
    this.customCommandsCollection.deleteOne({channel:channel,command:command})
      .catch(err => console.error('[DB] deleteCustomCommand error:', err));
  }

  async editCustomCommand(channel, command, new_result, new_timer = null, new_pin = false) {
    await this.ensureInitialized();
    this.customCommandsCollection.updateOne({channel:channel, command:command},
    {
      $set:
      {
        result: new_result,
        timer: new_timer,
        pin: new_pin
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
  rememberEmote(channel, word) {
    if (!this.emoteExclusionCache.has(channel)) this.emoteExclusionCache.set(channel, new Set());
    const lowered = String(word).toLowerCase();
    if (this.emoteExclusionCache.get(channel).has(lowered)) return;
    this.emoteExclusionCache.get(channel).add(lowered);
    this.exclusionBuffer.set(`${channel}${KEY_SEP}${lowered}`, true);
    this.scheduleTextStatsFlush();
  }

  isInWhiteList(channel, word) {
    return this.whiteListCache.get(channel)?.has(word) ?? false;
  }

  // Makes `channel`'s whitelist entries FOR ONE SOURCE exactly match `words`: upserts the current
  // ones, drops the ones that source no longer lists, and leaves every other source alone.
  //
  // `source` is the isolation boundary, and that is the whole point of this being generic. The
  // whitelist holds three independent populations:
  //   'manual'        - added by a mod with the (since-removed) !addword command. The command is
  //                     gone but its rows persist and must still never be touched by any sync.
  //   '7tv'           - the channel's own 7TV emote set.
  //   'twitch-global' - Twitch's official global emotes (Kappa, LUL, ...), the same for every
  //                     channel, so they're written per-channel but fetched once.
  // A sync of one must never delete another's rows, which is why the stale-delete below is
  // scoped by `source` and not just by `channel`.
  //
  // Collisions: the unique index is {channel, word}, so if two sources ship the same name, the
  // LAST sync to run owns the row. index.js syncs globals before 7TV precisely so the channel's
  // own 7TV set wins - a channel-specific emote is the more meaningful attribution.
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
    // staleWords are intentionally NOT un-excluded from the word cloud - see rememberEmote().
    wordSet.forEach(word => this.rememberEmote(channel, word));

    return { synced: words.length, removed: staleWords.length };
  }

  async syncSevenTvEmoteSet(channel, setId, words) {
    return this.syncEmoteSource(channel, '7tv', words, { setId });
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

  async addMessage(userId, userName, message, channel) {
    await this.ensureInitialized();
    
    const timestamp = new Date();
    this.messagesCollection.insertOne({
      userId,
      userName,
      message,
      channel,
      timestamp
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
    this.bufferTextStats(userId, userName, message, channel, timestamp);

    // Twitch only ever renders emotes/smileys as their own whitespace-delimited
    // token anyway, so a plain split is enough - no regex needed.
    const candidateWords = new Set();
    for (const token of message.trim().split(/\s+/)) {
      if (token.length > 0) candidateWords.add(token);
    }

    // Each word counts at most once per message, even if repeated in it.
    const allowedWords = [...candidateWords].filter(word => this.isInWhiteList(channel, word));

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