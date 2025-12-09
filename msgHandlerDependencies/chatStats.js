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
    const endDate = new Date();

    // 1) получить количество сообщений пользователя за период
    const userAgg = await this.messagesCollection.aggregate([
      { $match: { channel, userId, timestamp: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: "$userId", totalMessages: { $sum: 1 } } }
    ]).toArray();

    const userTotal = (userAgg[0] && userAgg[0].totalMessages) || 0;

    if (userTotal === 0) {
      // если у пользователя нет сообщений в периоде — можно вернуть сразу
      // но всё равно посчитаем общее количество пользователей для полной информации
      const totalUsers = await this.getUniqueUsersCount(channel, period);

      return {
        userId,
        totalMessages: 0,
        rank: null,
        percentage: null,
        totalUsers: totalUsers[0] ? totalUsers[0].cnt : 0
      };
    }

    // 2) посчитать, сколько пользователей имеют totalMessages > userTotal
    // для этого сначала агрегируем кол-во сообщений у всех пользователей, затем фильтруем по > userTotal
    const greaterAgg = await this.messagesCollection.aggregate([
      { $match: { channel, timestamp: { $gte: startDate, $lte: endDate } } },
      {
        $group: {
          _id: "$userId",
          totalMessages: { $sum: 1 }
        }
      },
      { $match: { totalMessages: { $gt: userTotal } } },
      { $count: "countGreater" }
    ]).toArray();

    const countGreater = (greaterAgg[0] && greaterAgg[0].countGreater) || 0;

    // ранг = количество пользователей с большим count + 1
    const rank = countGreater + 1;

    // 3) получить общее число пользователей в периоде
    const totalUsersAgg = await this.messagesCollection.aggregate([
      { $match: { channel, timestamp: { $gte: startDate, $lte: endDate } } },
      { $group: { _id: "$userId" } },
      { $count: "cnt" }
    ]).toArray();

    const totalUsers = (totalUsersAgg[0] && totalUsersAgg[0].cnt) || 0;

    var percentage = totalUsers > 0 ? Number(((rank / totalUsers) * 100)) : null;
    if (percentage >= 0.1) {
      percentage = percentage.toFixed(2);
    } else {
      percentage = percentage.toFixed(4);
    }
    return {
      userId,
      totalMessages: userTotal,
      rank,
      percentage,
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

}

module.exports = new ChatStats();