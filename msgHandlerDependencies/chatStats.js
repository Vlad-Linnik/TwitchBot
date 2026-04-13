const { connect } = require('./db.js');

const wordPatterns = [
  /\b\w+\b/g,                         // обычные слова
  /[=:;8xX][\-']?[)(\\\/|*DdPpOo]+/g, // смайлики :) :D :P
  /(?:^|\s)([!?]+)(?=\s|$)/g,         // повторяющиеся ! или ?
  /(?:^|\s)([\)]+)(?=\s|$)/g,         // повторяющиеся )    /(?:^|\s)([\(]+)(?=\s|$)/g          // повторяющиеся (
];


class ChatStats {
  constructor() {
    this.dbInitialized = false;
    this.whiteListCache = new Set();
    this.messagesCollection = null;
    this.whiteListCollection = null;
    this.wordsCollection = null;
    this.customCommandsCollection = null;
  }

  async initialize() {
    try {
      const db = await connect();
      this.messagesCollection = db.collection('messages');
      this.wordsCollection = db.collection('words');
      this.whiteListCollection = db.collection('whiteList');
      this.customCommandsCollection = db.collection("custom_commands");
      this.countersCollection = db.collection("counters");

      await this.messagesCollection.createIndex({ channel: 1, timestamp: -1, userId: 1 });
      await this.wordsCollection.createIndex({ channel: 1, date: -1 });
      await this.whiteListCollection.createIndex({ word: 1 }, { unique: true });
      const list = await this.whiteListCollection.find({}).toArray();
      this.whiteListCache = new Set(list.map(item => item.word));
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

  async isCommandExist(channel, command) {
    await this.ensureInitialized();
    return !! await this.customCommandsCollection.findOne( {channel:channel, command:command} );
  }

  async getAllCommands(channel) {
    await this.ensureInitialized();
    var CommandsDict = {}
    var Info = await this.customCommandsCollection.find({channel: channel}).toArray();
    for (const command of Info) {
        CommandsDict[command["command"]] = {result: command["result"], timer: command["timer"]};
    }
    return CommandsDict;
  }

  async addNewCustomCommand(channel, command, result, timer = null) {
    await this.ensureInitialized();
    this.customCommandsCollection.insertOne({channel, command, result, timer});
  } 



  async deleteCustomCommand(channel, command) {
    await this.ensureInitialized();
    this.customCommandsCollection.deleteOne({channel:channel,command:command});
  }
  
  async editCustomCommand(channel, command, new_result, new_timer = null) {
    await this.ensureInitialized();
    this.customCommandsCollection.updateOne({channel:channel, command:command}, 
    {
      $set: 
      {
        result: new_result,
        timer: new_timer
      }
    })
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

  async addToWhiteList(word) {
    await this.ensureInitialized();
    await this.whiteListCollection.updateOne(
      { word },
      { $set: { word } },
      { upsert: true }
    );
    this.whiteListCache.add(word);
  }

  async removeFromWhiteList(word) {
    await this.ensureInitialized();
    await this.whiteListCollection.deleteOne({ word });
    this.whiteListCache.delete(word);
  }

  isInWhiteList(word) {
    return this.whiteListCache.has(word);
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
    });


    let words = [];
    for (const pattern of wordPatterns) {
      const matches = message.match(pattern) || [];
      words = [...words, ...matches];
    }

    words = words.map(w => w.trim()).filter(w => w.length > 0);


    const allowedWords = words.filter(word => this.isInWhiteList(word));

    if (allowedWords.length > 0) {
      const today = new Date();
      today.setHours(12, 0, 0, 0);

      const wordCounts = {};
      allowedWords.forEach(w => wordCounts[w] = (wordCounts[w] || 0) + 1);

      const operations = Object.keys(wordCounts).map(word => ({
        updateOne: {
          filter: {word, channel, date: today},
          update: {$inc: { count: wordCounts[word] } },
          upsert: true
        }
      }));
      this.wordsCollection.bulkWrite(operations, { ordered: false}).catch(err => {
        console.error('Bulk write error', err);
      });
    }
  }

async getUserRank(userId, channel, period) {
    await this.ensureInitialized();
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
    this.countersCollection.insertOne({channel, counter_name, count: 0, access, exceptions: []});
  }

  async changeCounterAccess(channel, counter_name, new_access) {
    await this.ensureInitialized();
    this.countersCollection.updateOne({channel:channel, counter_name:counter_name}, 
    {
      $set: {access: new_access}
    });
  }

  async changeCounterExceptions(channel, counter_name, new_exceptions) {
    await this.ensureInitialized();
    this.countersCollection.updateOne({channel:channel, counter_name:counter_name}, 
    {
      $set: {exceptions: new_exceptions}
    });
  }

  async isCounterExist(channel, counter_name) {
    await this.ensureInitialized();
    return !! await this.countersCollection.findOne( {channel:channel, counter_name:counter_name} );
  }

  async updateCounter(channel, counter_name, new_count) {
    await this.ensureInitialized();
    this.countersCollection.updateOne({channel:channel, counter_name:counter_name}, 
    {
      $set: {count: new_count}
    });
  }
  
  async deleteCounter(channel, counter_name) {
    await this.ensureInitialized();
    this.countersCollection.deleteOne({channel:channel, counter_name:counter_name});
  }

  async getCounter(channel, counter_name){
    await this.ensureInitialized();
    var Counter = await this.countersCollection.find({channel: channel, counter_name: counter_name}).toArray();
    return Counter;
  }

  async getAllCounters(channel) {
    await this.ensureInitialized();
    var Counters = await this.countersCollection.find({channel: channel}).toArray();
    var CommandsDict = {};
    for (const counter of Counters) {
        CommandsDict[counter["counter_name"]] = counter["count"];
    }
    return CommandsDict;
  }

}

module.exports = new ChatStats();