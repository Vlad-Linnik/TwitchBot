const { connect } = require('./db.js');

class ChatStats {
  constructor() {
    this.dbInitialized = false;
    this.messagesCollection = null;
    this.whiteListCollection = null;
    this.wordsCollection = null;
  }

  async initialize() {
    try {
      const db = await connect();
      this.messagesCollection = db.collection('messages');
      this.wordsCollection = db.collection('words');
      this.whiteListCollection = db.collection('whiteList');
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
// получить количество сообщений от пользователя за период
  async getUserMessageCount(userId, channel, period) {
    await this.ensureInitialized();
    let startDate = this.selectPeriod(period);
    let endDate = new Date();
    const count = await this.messagesCollection.countDocuments({
      userId,
      channel,
      timestamp: { $gte: startDate, $lte: endDate }
    });
    return count;
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