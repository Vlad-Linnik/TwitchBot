const { MongoClient } = require('mongodb');

async function getDatabaseStats(connectionString, dbName, collectionName) {
  const client = new MongoClient(connectionString);
  
  try {
    await client.connect();
    const db = client.db(dbName);
    const collection = db.collection(collectionName);

    // 1. Общее количество записей
    const totalRecords = await collection.countDocuments();

    // 2. Дата самой первой записи (по полю `date` или `timestamp`)
    const oldestRecord = await collection
      .find({})
      .sort({ date: 1 }) // или `timestamp: 1`
      .limit(1)
      .toArray();
    const firstRecordDate = oldestRecord[0]?.date || null;

    // 3. Объем занимаемой памяти (в МБ)
    const stats = await db.command({ dbStats: 1 });
    const sizeInMB = (stats.dataSize / (1024 * 1024)).toFixed(2);

    return {
      totalRecords,
      oldestRecord,
      size: `${sizeInMB} MB`,
      rawStats: stats // Полная статистика (опционально)
    };
  } catch (err) {
    console.error('Error fetching database stats:', err);
    throw err;
  } finally {
    await client.close();
  }
}

// Пример использования
(async () => {
  const stats = await getDatabaseStats(
    'mongodb://localhost:27017',
    'twitch_chat_stats',
    'messages'
  );
  console.log('Database Stats:', stats);
})();