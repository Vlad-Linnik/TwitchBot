const { connect } = require('./db.js');

class ChatStats {
  constructor() {
    this.dbInitialized = false;
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
  }

  async removeFromWhiteList(word) {
    await this.ensureInitialized();
    await this.whiteListCollection.deleteOne({ word });
  }

  async isInWhiteList(word) {
    await this.ensureInitialized();
    const found = await this.whiteListCollection.findOne({ word });
    return !!found;
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

  // Новый подход к извлечению "слов"
  const wordPatterns = [
    /\b\w+\b/g,                         // обычные слова
    /[=:;8xX][\-']?[)(\\\/|*DdPpOo]+/g, // смайлики :) :D :P
    /(?:^|\s)([!?]+)(?=\s|$)/g,         // повторяющиеся ! или ?
    /(?:^|\s)([\)]+)(?=\s|$)/g,         // повторяющиеся )
    /(?:^|\s)([\(]+)(?=\s|$)/g          // повторяющиеся (
  ];

  let words = [];
  for (const pattern of wordPatterns) {
    const matches = message.match(pattern) || [];
    words = [...words, ...matches];
  }

  // Удаляем возможные пробелы в начале/конце
  words = words.map(w => w.trim()).filter(w => w.length > 0);


  for (const word of words) {
    const isAllowed = await this.isInWhiteList(word);
    if (!isAllowed) continue;
    var today = new Date();
    today.setHours(12, 0, 0, 0);
    this.wordsCollection.updateOne(
      { word, channel, date: today },
      { $inc: { count: 1 } },
      { upsert: true }
      );
    }
  }

  async getUserRank(userId, channel, period) {
    await this.ensureInitialized();

    const startDate = this.selectPeriod(period);
    const now = new Date();

    // 1. Получаем ВЕСЬ список активных юзеров за период, отсортированный по кол-ву сообщений
    // Это гарантирует, что мы видим всю картину целиком и одновременно
    const fullTop = await this.messagesCollection.aggregate([
      { 
        $match: { 
          channel, 
          timestamp: { $gte: startDate, $lte: now } 
        } 
      },
      { 
        $group: { 
          _id: "$userId", 
          count: { $sum: 1 } 
        } 
      },
      { $sort: { count: -1 } }
    ]).toArray();

    const totalUsers = fullTop.length;

    // 2. Ищем нашего пользователя в этом списке
    const userIndex = fullTop.findIndex(item => item._id === userId);

    if (userIndex === -1) {
      return {
        userId,
        totalMessages: 0,
        rank: null,
        percentage: null,
        totalUsers
      };
    }

    const userTotal = fullTop[userIndex].count;
    const rank = userIndex + 1; // Индекс 0 станет рангом 1

    // 3. Математически корректный процент
    // Если ты 1-й из 2-х: (1 / 2) * 100 = 50%
    let percentage = (rank / totalUsers) * 100;

    return {
      userId,
      totalMessages: userTotal,
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