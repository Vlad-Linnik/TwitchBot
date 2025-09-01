const { MongoClient } = require('mongodb');

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}

async function getDatabaseStatsSummary(connectionString, dbName, collectionName) {
  const client = new MongoClient(connectionString);

  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // Количество документов
    const totalRecords = await collection.countDocuments();

    // Дата первой записи
    const oldestRecord = await collection.find({}).sort({ date: 1 }).limit(1).toArray();
    const firstRecordDate = oldestRecord[0]?.date?.toISOString().split('T')[0] || '—';

    // Статистика
    const stats = await db.command({ dbStats: 1 });

    // Использовано/свободно на диске
    const used = stats.fsUsedSize;
    const free = stats.fsTotalSize - stats.fsUsedSize;

    return `Всего записей: ${totalRecords} • Первая запись: ${firstRecordDate} • Использовано: ${formatBytes(used)} / Свободно: ${formatBytes(free)}`;
  } finally {
    await client.close();
  }
}

// Пример использования
(async () => {
  const summary = await getDatabaseStatsSummary(
    'mongodb://localhost:27017',   // строка подключения
    'twitch_chat_stats',           // имя БД
    'messages'                     // коллекция
  );

  console.log(summary);
})();
