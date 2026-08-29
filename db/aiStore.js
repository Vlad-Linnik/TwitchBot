// Bot-side Mongo access for the AI mention replies: the two lookaside tables checked before any
// API call, the per-call journal, the permanent ignore list, and the channel memory.
//
// This repo owns the document shapes for AiFilter / AiAnswerCache / AiReplyLog / AiIgnoredUsers /
// AiChannelMemory - the site reads and curates them (TwitchBot-Web's db/ai*Repo.js) but the bot is
// what writes them at runtime. Channel keys carry the leading '#', the same convention as every
// other chat-stat collection in this database.
const { connect } = require('./db.js');
const { aiTextKey } = require('../shared/aiTextKey.js');

let cols = null;

async function ensureInitialized() {
  if (cols) return cols;
  const db = await connect();
  cols = {
    filter: db.collection('AiFilter'),
    cache: db.collection('AiAnswerCache'),
    log: db.collection('AiReplyLog'),
    ignored: db.collection('AiIgnoredUsers'),
    memory: db.collection('AiChannelMemory'),
    sessions: db.collection('StreamSessions'),
    samples: db.collection('StreamViewerSamples'),
  };
  // Indexes are created by whichever side touches the collection first; both sides declare the
  // same ones, and createIndex is idempotent.
  await Promise.all([
    cols.filter.createIndex({ text: 1 }, { unique: true }),
    cols.cache.createIndex({ channel: 1, text: 1 }, { unique: true }),
    // Для выборки «о чём этого канала уже спрашивали» - см. recentAnswers ниже.
    cols.cache.createIndex({ channel: 1, lastHitAt: -1, createdAt: -1 }),
    cols.log.createIndex({ channel: 1, userId: 1, createdAt: -1 }),
    cols.log.createIndex({ createdAt: -1 }),
    cols.ignored.createIndex({ channel: 1, userId: 1 }, { unique: true }),
    cols.memory.createIndex({ channel: 1, key: 1 }, { unique: true }),
    cols.memory.createIndex({ channel: 1, createdAt: 1 }),
  ]);
  return cols;
}

// --- lookaside tables ------------------------------------------------------

async function findFilterAnswer(text) {
  const c = await ensureInitialized();
  const key = aiTextKey(text);
  if (!key) return null;
  const doc = await c.filter.findOneAndUpdate(
    { text: key },
    { $inc: { hits: 1 }, $set: { lastHitAt: new Date() } },
    { returnDocument: 'after' }
  );
  // mongodb@6 returns the document itself on a hit and null on a miss; older drivers wrapped it
  // in { value }. Same unwrap idiom the rest of both repos use.
  const found = doc && doc.value !== undefined ? doc.value : doc;
  return found ? found.answer : null;
}

async function addFilterEntry(text, answer) {
  const c = await ensureInitialized();
  const key = aiTextKey(text);
  if (!key) return;
  await c.filter.updateOne(
    { text: key },
    {
      $set: { answer: String(answer || '') },
      $setOnInsert: { text: key, source: 'ai', hits: 0, lastHitAt: null, createdAt: new Date() },
    },
    { upsert: true }
  );
}

async function findCachedAnswer(channel, text) {
  const c = await ensureInitialized();
  const key = aiTextKey(text);
  if (!key) return null;
  const doc = await c.cache.findOneAndUpdate(
    { channel, text: key },
    { $inc: { hits: 1 }, $set: { lastHitAt: new Date() } },
    { returnDocument: 'after' }
  );
  const found = doc && doc.value !== undefined ? doc.value : doc;
  return found ? found.answer : null;
}

async function cacheAnswer(channel, text, answer) {
  const c = await ensureInitialized();
  const key = aiTextKey(text);
  if (!key) return;
  await c.cache.updateOne(
    { channel, text: key },
    {
      $set: { answer: String(answer || '') },
      $setOnInsert: { channel, text: key, hits: 0, lastHitAt: null, createdAt: new Date() },
    },
    { upsert: true }
  );
}

// Вопросы этого канала, на которые ответ уже был, - для поиска похожего в
// shared/memoryRecall.js. Не замена findCachedAnswer: тот отдаёт ответ при точном совпадении и
// без обращения к модели, а это выборка кандидатов для подсказки в промт.
//
// Выборка ограничена и упорядочена по последнему обращению, а не по дате создания: кэш растёт
// без ротации, и при канале с длинной историей читать его целиком на горячем пути нельзя. Строка,
// к которой обращались недавно, - и есть та, о которой спросят снова.
async function recentAnswers(channel, limit) {
  const c = await ensureInitialized();
  if (!limit) return [];
  return c.cache
    .find({ channel }, { projection: { text: 1, answer: 1 } })
    .sort({ lastHitAt: -1, createdAt: -1 })
    .limit(limit)
    .toArray();
}

// --- ignore list -----------------------------------------------------------

async function isIgnored(channel, userId) {
  const c = await ensureInitialized();
  const doc = await c.ignored.findOne({ channel, userId: String(userId) });
  return Boolean(doc);
}

// The whole list at once, as "channel|userId" keys. games/aiReply.js keeps it in memory so that
// deciding whether to answer stays a synchronous check - the list is permanent and small, and a
// Mongo round trip per mention would buy nothing.
async function listIgnoredKeys() {
  const c = await ensureInitialized();
  const rows = await c.ignored.find({}, { projection: { channel: 1, userId: 1 } }).toArray();
  return rows.map((r) => r.channel + '|' + r.userId);
}

async function ignoreUser(channel, userId, login, reason) {
  const c = await ensureInitialized();
  await c.ignored.updateOne(
    { channel, userId: String(userId) },
    { $setOnInsert: { channel, userId: String(userId), login, reason: String(reason || ''), createdAt: new Date() } },
    { upsert: true }
  );
}

// --- channel memory --------------------------------------------------------

// What the bot has learnt about a channel and keeps re-reading. Deliberately a collection of short
// separate facts rather than one growing block of text: the model adds and drops them one at a
// time, and an admin curating them needs a row to delete, not a paragraph to re-edit. The
// admin-written cheat sheet in ChannelConfig stays what it was - this sits next to it.
//
// EVERY fact here is sent on EVERY billed call for that channel, so the count is a cost decision,
// not just a tidiness one - which is why the ceiling is a setting (channelMemoryMax) and why the
// rotation below is unconditional.

// Oldest first: that is the order they are numbered in the prompt, and a stable numbering is what
// makes the model's "forget number N" refer to the same fact it just read.
async function listMemory(channel, limit) {
  const c = await ensureInitialized();
  if (!limit) return [];
  return c.memory.find({ channel }).sort({ createdAt: 1 }).limit(limit).toArray();
}

// Returns true when the fact was new. A repeat is not an error - the model re-stating something it
// already knows is normal, and the duplicate is simply dropped by the unique key.
async function rememberFact(channel, fact, meta, max) {
  const c = await ensureInitialized();
  const key = aiTextKey(fact);
  if (!key) return false;
  // Потолок в ноль означает «не запоминать», и отказ должен произойти ЗДЕСЬ. Раньше строка
  // записывалась и тут же вычищалась ротацией, а вызывающий получал true и писал в журнал
  // «запомнил такой-то факт» - журнал наполнялся записями, которых в памяти никогда не было.
  if (!max || max < 1) return false;
  const res = await c.memory.updateOne(
    { channel, key },
    {
      $setOnInsert: {
        channel,
        key,
        fact: String(fact),
        source: 'ai',
        authorLogin: meta.authorLogin || null,
        authorUserId: meta.authorUserId || null,
        sourceMessage: meta.sourceMessage || null,
        createdAt: new Date(),
        // Заводится сразу, чтобы поле было у каждой строки: ротация сортирует по нему, и
        // отсутствующее значение отправило бы только что записанный факт первым на вылет.
        lastUsedAt: new Date(),
      },
    },
    { upsert: true }
  );
  const added = Boolean(res.upsertedCount);

  // Потолок считается ПО СТРОКАМ БОТА, а не по всем. Строки, написанные админом, - отдельный
  // список: они не вытесняются и уходят в запрос всегда. Пока в счёт входили и они, достаточно
  // было написать руками столько фактов, сколько стоит в потолке, чтобы каждый факт бота
  // удалялся ровно в тот момент, когда был записан, - навсегда и молча, с записью «запомнил» в
  // журнале.
  //
  // Вылетает не самый старый, а тот, к которому дольше всего не обращались. Пока в запрос уходила
  // вся память, эти два порядка совпадали - читались все строки сразу. С отбором по словам
  // (shared/memoryRecall.js) хранилище больше того, что уходит в промт, и «самый старый» начал бы
  // выбрасывать как раз тот факт, который спрашивают чаще всего, просто потому что он записан
  // давно.
  if (added) {
    const total = await c.memory.countDocuments({ channel, source: 'ai' });
    if (total > max) {
      const stale = await c.memory
        .find({ channel, source: 'ai' }, { projection: { _id: 1 } })
        .sort({ lastUsedAt: 1, createdAt: 1 })
        .limit(total - max)
        .toArray();
      if (stale.length) await c.memory.deleteMany({ _id: { $in: stale.map((d) => d._id) } });
    }
  }
  return added;
}

// Отмечает, что эти факты сейчас ушли в запрос. Вызывается уже после отправки ответа в чат, вне
// бюджета времени на ответ, и ошибка здесь не должна ронять разбор ответа модели: испорченный
// порядок ротации - это неудачно выбранная строка на вылет, а не потеря ответа зрителю.
async function touchFacts(channel, keys) {
  if (!keys || !keys.length) return;
  try {
    const c = await ensureInitialized();
    await c.memory.updateMany({ channel, key: { $in: keys } }, { $set: { lastUsedAt: new Date() } });
  } catch (err) {
    console.error('[aiStore] touchFacts failed:', err.message);
  }
}

async function forgetFact(channel, key) {
  const c = await ensureInitialized();
  const res = await c.memory.deleteOne({ channel, key: String(key) });
  return Boolean(res.deletedCount);
}

// --- journal / memory / budget --------------------------------------------

async function writeLog(row) {
  const c = await ensureInitialized();
  await c.log.insertOne({ ...row, createdAt: new Date() });
}

// The last N exchanges this viewer had with the bot in this channel, oldest first so the model
// reads them as a conversation. Keyed by person rather than by reply thread on purpose: a viewer
// who asked something yesterday and something else today is still the same person, and threading
// would break the moment they answered without using reply.
async function recentExchanges(channel, userId, limit) {
  const c = await ensureInitialized();
  const rows = await c.log
    .find({ channel, userId: String(userId), answer: { $nin: [null, ''] } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return rows.reverse().map((r) => ({ question: r.question, answer: r.answer }));
}

// Counts only rows that actually reached the API. A filter or cache hit still writes a row (it is
// part of the conversation, and of the memory) but it cost nothing, so it must not eat the budget.
async function countBilledSince(since) {
  const c = await ensureInitialized();
  return c.log.countDocuments({ createdAt: { $gte: since }, billed: true });
}

// --- stream card -----------------------------------------------------------

// Reads live status / category / uptime out of the collections ActivitiTracker already fills.
// Deliberately not read from the tracker object itself: index.js keeps only the LAST channel's
// instance in a single module-level variable, so there is no per-channel handle to ask, and
// refactoring that working feature to add a prompt field would be the wrong trade.
async function streamCard(channelId) {
  const c = await ensureInitialized();
  const id = String(channelId);
  const [session, sample] = await Promise.all([
    c.sessions.findOne({ channelId: id, endedAt: null }),
    c.samples.findOne({ channelId: id }, { sort: { timestamp: -1 } }),
  ]);
  if (!session) return { live: false };
  return {
    live: true,
    startedAt: session.startedAt,
    uptimeMinutes: Math.max(0, Math.round((Date.now() - new Date(session.startedAt).getTime()) / 60000)),
    category: sample ? sample.category : null,
    viewers: sample ? sample.viewerCount : null,
  };
}

module.exports = {
  findFilterAnswer,
  addFilterEntry,
  findCachedAnswer,
  cacheAnswer,
  recentAnswers,
  isIgnored,
  listIgnoredKeys,
  ignoreUser,
  listMemory,
  rememberFact,
  touchFacts,
  forgetFact,
  writeLog,
  recentExchanges,
  countBilledSince,
  streamCard,
};
