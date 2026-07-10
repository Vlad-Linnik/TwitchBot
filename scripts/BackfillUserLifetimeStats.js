const { connect } = require('../db/db.js');

async function backfillUserLifetimeStats(db) {
  const messages = db.collection('messages');
  const userLifetimeStats = db.collection('UserLifetimeStats');

  await userLifetimeStats.createIndex({ channel: 1, userId: 1 }, { unique: true });
  await userLifetimeStats.createIndex({ channel: 1, messageCount: -1 });

  const cursor = messages.aggregate([
    {
      $group: {
        _id: { channel: '$channel', userId: '$userId' },
        messageCount: { $sum: 1 },
        lastSeen: { $max: '$timestamp' }
      }
    }
  ], { allowDiskUse: true });

  let batch = [];
  let total = 0;
  const batchSize = 1000;

  for await (const doc of cursor) {
    batch.push({
      updateOne: {
        filter: { channel: doc._id.channel, userId: doc._id.userId },
        update: {
          $set: {
            channel: doc._id.channel,
            userId: doc._id.userId,
            messageCount: doc.messageCount,
            lastSeen: doc.lastSeen
          }
        },
        upsert: true
      }
    });

    if (batch.length >= batchSize) {
      await userLifetimeStats.bulkWrite(batch, { ordered: false });
      total += batch.length;
      console.log(`[Backfill] UserLifetimeStats: upserted ${total} records...`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await userLifetimeStats.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  console.log(`[Backfill] UserLifetimeStats done. Upserted ${total} records.`);
}

async function backfillUserIdentities(db) {
  const messages = db.collection('messages');
  const userIdentities = db.collection('UserIdentities');

  await userIdentities.createIndex({ userId: 1 }, { unique: true });

  // userId is a global Twitch account ID, so nickname history is tracked
  // per-user across all channels, not per-channel.
  const cursor = messages.aggregate([
    {
      $group: {
        _id: { userId: '$userId', userName: '$userName' },
        firstSeen: { $min: '$timestamp' },
        lastSeen: { $max: '$timestamp' }
      }
    },
    {
      $group: {
        _id: '$_id.userId',
        nicknames: { $push: { name: '$_id.userName', firstSeen: '$firstSeen', lastSeen: '$lastSeen' } },
        overallFirstSeen: { $min: '$firstSeen' }
      }
    }
  ], { allowDiskUse: true });

  let batch = [];
  let total = 0;
  const batchSize = 1000;

  for await (const doc of cursor) {
    const currentNickname = doc.nicknames.reduce((latest, entry) =>
      entry.lastSeen > latest.lastSeen ? entry : latest
    );

    batch.push({
      updateOne: {
        filter: { userId: doc._id },
        update: {
          $set: {
            userId: doc._id,
            currentUserName: currentNickname.name,
            firstSeen: doc.overallFirstSeen,
            nicknames: doc.nicknames
          }
        },
        upsert: true
      }
    });

    if (batch.length >= batchSize) {
      await userIdentities.bulkWrite(batch, { ordered: false });
      total += batch.length;
      console.log(`[Backfill] UserIdentities: upserted ${total} records...`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await userIdentities.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  console.log(`[Backfill] UserIdentities done. Upserted ${total} records.`);
}

async function backfillWordLifetimeStats(db) {
  const words = db.collection('words');
  const wordLifetimeStats = db.collection('WordLifetimeStats');

  await wordLifetimeStats.createIndex({ channel: 1, word: 1 }, { unique: true });
  await wordLifetimeStats.createIndex({ channel: 1, count: -1 });

  const cursor = words.aggregate([
    {
      $group: {
        _id: { channel: '$channel', word: '$word' },
        count: { $sum: '$count' },
        lastUsed: { $max: '$date' }
      }
    }
  ], { allowDiskUse: true });

  let batch = [];
  let total = 0;
  const batchSize = 1000;

  for await (const doc of cursor) {
    batch.push({
      updateOne: {
        filter: { channel: doc._id.channel, word: doc._id.word },
        update: {
          $set: {
            channel: doc._id.channel,
            word: doc._id.word,
            count: doc.count,
            lastUsed: doc.lastUsed
          }
        },
        upsert: true
      }
    });

    if (batch.length >= batchSize) {
      await wordLifetimeStats.bulkWrite(batch, { ordered: false });
      total += batch.length;
      console.log(`[Backfill] WordLifetimeStats: upserted ${total} records...`);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await wordLifetimeStats.bulkWrite(batch, { ordered: false });
    total += batch.length;
  }

  console.log(`[Backfill] WordLifetimeStats done. Upserted ${total} records.`);
}

async function main() {
  const db = await connect();
  await backfillUserLifetimeStats(db);
  await backfillUserIdentities(db);
  await backfillWordLifetimeStats(db);
  process.exit(0);
}

main().catch(err => {
  console.error('[Backfill] Failed:', err);
  process.exit(1);
});