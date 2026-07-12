const { connect } = require('./db.js');

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

      await this.commandStats.createIndex({ channel: 1 }, { unique: true });
      await this.modsUpTimeStats.createIndex({ channelId: 1, userId: 1, timestamp: 1 }, { unique: true });
      await this.modsUpTimeStats.createIndex({ channelId: 1, timestamp: 1, hours: -1 });
      await this.modStats.createIndex({ channelId: 1, userId: 1, date: 1 }, { unique: true });
      await this.modList.createIndex({ channelId: 1 }, { unique: true });
      await this.modLogs.createIndex({ channel: 1, timestamp: -1, userId: 1 });
      await this.messagesCollection.createIndex({ channel: 1, timestamp: -1, userId: 1 });
      await this.wordsCollection.createIndex({ channel: 1, date: -1 });
      await this.userLifetimeStats.createIndex({ channel: 1, userId: 1 }, { unique: true });
      await this.userLifetimeStats.createIndex({ channel: 1, messageCount: -1 });
      await this.userIdentities.createIndex({ userId: 1 }, { unique: true });
      await this.wordLifetimeStats.createIndex({ channel: 1, word: 1 }, { unique: true });
      await this.wordLifetimeStats.createIndex({ channel: 1, count: -1 });
      await this.whiteListCollection.createIndex({ channel: 1, word: 1 }, { unique: true });
      await this.customCommandExceptions.createIndex({ channel: 1 }, { unique: true });
      const list = await this.whiteListCollection.find({}).toArray();
      this.whiteListCache = new Map();
      for (const item of list) {
        if (!this.whiteListCache.has(item.channel)) this.whiteListCache.set(item.channel, new Set());
        this.whiteListCache.get(item.channel).add(item.word);
      }
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
    if (!activeUserIds || activeUserIds.length === 0) return;

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
    if (!moderatorIds || moderatorIds.length === 0) return;

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
      await this.modStats.bulkWrite(operations, { ordered: false });
    } catch (err) {
      console.error('[DB] recordDailyModeratorStats error:', err);
    }
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

  async addToWhiteList(channel, word) {
    await this.ensureInitialized();
    await this.whiteListCollection.updateOne(
      { channel, word },
      { $set: { channel, word, source: 'manual' }, $unset: { setId: '' } },
      { upsert: true }
    );
    if (!this.whiteListCache.has(channel)) this.whiteListCache.set(channel, new Set());
    this.whiteListCache.get(channel).add(word);
  }

  async removeFromWhiteList(channel, word) {
    await this.ensureInitialized();
    await this.whiteListCollection.deleteOne({ channel, word });
    this.whiteListCache.get(channel)?.delete(word);
  }

  isInWhiteList(channel, word) {
    return this.whiteListCache.get(channel)?.has(word) ?? false;
  }

  // Adds/updates the channel's 7TV-sourced whitelist entries to exactly match `words`,
  // without touching words added manually via !addword (source: 'manual').
  async syncSevenTvEmoteSet(channel, setId, words) {
    await this.ensureInitialized();
    const wordSet = new Set(words);

    const existing7tv = await this.whiteListCollection.find({ channel, source: '7tv' }).toArray();
    const staleWords = existing7tv.filter(item => !wordSet.has(item.word)).map(item => item.word);

    if (staleWords.length > 0) {
      await this.whiteListCollection.deleteMany({ channel, source: '7tv', word: { $in: staleWords } });
    }

    if (words.length > 0) {
      await this.whiteListCollection.bulkWrite(words.map(word => ({
        updateOne: {
          filter: { channel, word },
          update: { $set: { channel, word, source: '7tv', setId } },
          upsert: true
        }
      })));
    }

    const cacheSet = this.whiteListCache.get(channel) || new Set();
    staleWords.forEach(word => cacheSet.delete(word));
    wordSet.forEach(word => cacheSet.add(word));
    this.whiteListCache.set(channel, cacheSet);
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