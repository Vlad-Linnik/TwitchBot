const { MongoClient } = require('mongodb');

const uri = 'mongodb://localhost:27017';
const client = new MongoClient(uri);

let db;

async function connect() {
  if (!db) {
    await client.connect();
    db = client.db('twitch_chat_stats');
    console.log('Connected to MongoDB');
  }
  return db;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}

async function getDatabaseStatsSummary(dbName = 'twitch_chat_stats', collectionName = "messages") {
  // Подключаемся к базе
  const database = db || await connect();
  const collection = database.collection(collectionName);

  // Количество документов
  const totalRecords = await collection.countDocuments();

  // Дата первой записи (по timestamp)
  const oldestRecord = await collection.find({})
    .sort({ timestamp: 1 })
    .limit(1)
    .toArray();
  const firstRecordDate = oldestRecord[0]?.timestamp?.toISOString().split('T')[0] || '—';

  // Статистика базы
  const stats = await database.command({ dbStats: 1 });

  // Использовано/свободно на диске
  const free = stats.fsTotalSize - stats.fsUsedSize;

  return `Total records: ${totalRecords}, First record: ${firstRecordDate}, Used: ${formatBytes(stats.dataSize)}`;
}

module.exports = { 
  connect,
  getDatabaseStatsSummary
};
