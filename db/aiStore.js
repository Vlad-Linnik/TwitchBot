// Bot-side Mongo access for the AI mention replies: the two lookaside tables checked before any
// API call, the per-call journal, and the channel memory (one store: facts about the channel
// and about its viewers live in the same list).
//
// AiFilter - ПО КАНАЛАМ, а не общий на всех, как было раньше. Заготовку в него пишет сама модель
// (вердикт filter), и пока таблица была общей, придуманный ею ответ начинал выдаваться во всех
// каналах сразу и навсегда - без чьего-либо просмотра. Общей она была ради экономии: «привет»
// значит одно и то же везде, и заново учить каждый канал казалось расточительным. Замер это не
// подтвердил - за месяцы работы в таблице накопилось девять строк, то есть «переучивание» стоит
// девять вызовов на канал. Утечка чужого ответа в чужой чат стоит дороже.
//
// This repo owns the document shapes for AiFilter / AiAnswerCache / AiReplyLog /
// AiChannelMemory - the site reads and curates them (TwitchBot-Web's db/ai*Repo.js)
// but the bot is what writes them at runtime. Channel keys carry the leading '#', the same convention as every
// other chat-stat collection in this database.
const { connect } = require('./db.js');
const { aiTextKey } = require('../shared/aiTextKey.js');
const { factPriority, rankFacts } = require('../shared/memoryRecall.js');

let cols = null;

async function ensureInitialized() {
  if (cols) return cols;
  const db = await connect();
  cols = {
    filter: db.collection('AiFilter'),
    cache: db.collection('AiAnswerCache'),
    log: db.collection('AiReplyLog'),
    memory: db.collection('AiChannelMemory'),
    config: db.collection('AiConfig'),
    sessions: db.collection('StreamSessions'),
    samples: db.collection('StreamViewerSamples'),
  };
  // Indexes are created by whichever side touches the collection first; both sides declare the
  // same ones, and createIndex is idempotent.
  await Promise.all([
    cols.filter.createIndex({ channel: 1, text: 1 }, { unique: true }),
    cols.cache.createIndex({ channel: 1, text: 1 }, { unique: true }),
    // Для выборки «о чём этого канала уже спрашивали» - см. recentAnswers ниже.
    cols.cache.createIndex({ channel: 1, lastHitAt: -1, createdAt: -1 }),
    cols.log.createIndex({ channel: 1, userId: 1, createdAt: -1 }),
    // Под recentReplies: индекс выше начинается с channel, но userId стоит между ним и временем,
    // поэтому порядок по createdAt из него не берётся - выборка «последние ответы канала» без
    // этого сортировала бы в памяти.
    cols.log.createIndex({ channel: 1, createdAt: -1 }),
    cols.log.createIndex({ createdAt: -1 }),
    cols.memory.createIndex({ channel: 1, key: 1 }, { unique: true }),
    cols.memory.createIndex({ channel: 1, createdAt: 1 }),
  ]);
  return cols;
}

// --- lookaside tables ------------------------------------------------------

async function findFilterAnswer(channel, text) {
  const c = await ensureInitialized();
  const key = aiTextKey(text);
  if (!key) return null;
  // ОТВЕЧАЮТ ТОЛЬКО СОГЛАСОВАННЫЕ СТРОКИ. Заготовка уходит в чат вечно, всем и без модели, а
  // заводит её один разговор с одним человеком - и на живых данных так завелись «запомни, ты
  // сосал» → «Хорошо, запомнил, что ты сосал ahahah» и «привет, как дела?» → «Привет, лучший
  // друг!», которая зовёт лучшим другом любого незнакомца. Та же стадия, что у наказаний и у
  // античита: строка пишется сразу, отвечать начинает после человека.
  //
  // Строки, заведённые до появления флага, отвечать перестают - и это правильный исход, а не
  // потеря: за всё время таблица собрала единицы попаданий, а согласовать её целиком - одно
  // нажатие в панели.
  const doc = await c.filter.findOneAndUpdate(
    { channel, text: key, approved: true },
    { $inc: { hits: 1 }, $set: { lastHitAt: new Date() } },
    { returnDocument: 'after' }
  );
  // mongodb@6 returns the document itself on a hit and null on a miss; older drivers wrapped it
  // in { value }. Same unwrap idiom the rest of both repos use.
  const found = doc && doc.value !== undefined ? doc.value : doc;
  return found ? found.answer : null;
}

async function addFilterEntry(channel, text, answer) {
  const c = await ensureInitialized();
  const key = aiTextKey(text);
  if (!key) return;
  await c.filter.updateOne(
    { channel, text: key },
    {
      $set: { answer: String(answer || '') },
      // approved только при вставке: согласование - решение человека, и переписанный моделью ответ
      // не должен его ни ставить, ни снимать. Снимать тоже нельзя - иначе один вызов модели гасил
      // бы строку, которую человек уже разобрал и одобрил.
      $setOnInsert: {
        channel,
        text: key,
        source: 'ai',
        approved: false,
        hits: 0,
        lastHitAt: null,
        createdAt: new Date(),
      },
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

// Возвращает true, если ответ теперь лежит в кэше - новой строкой или поверх прежней. Это то, что
// показывает журнал в панели: вопрос не «завели ли строку», а «будет ли следующий такой вопрос
// бесплатным». Ротацию при этом взводит только вставка: перезапись ничего не добавила.
//
// РОТАЦИЯ ПОЯВИЛАСЬ ВМЕСТЕ С ЗАПИСЬЮ С ПЕРВОГО ОБРАЩЕНИЯ. Пока кэш пополнялся только со второго,
// он рос медленно и потолок был не нужен; теперь сюда попадает всё, что модель назвала вечным, и
// без потолка страница кэша в панели превратилась бы в свалку - именно то возражение, ради
// которого когда-то и появилось условие «со второго раза» (см. games/aiReply.js).
//
// Вылетает не самый старый, а тот, к которому дольше всего не обращались: строка, которую
// спрашивают раз в месяц, полезнее записанной вчера и ни разу не пригодившейся. У только что
// вставленной строки обращений ещё нет, поэтому в сравнении участвует createdAt - иначе она
// вылетала бы первой же ротацией, не дожив до своего первого попадания.
async function cacheAnswer(channel, text, answer, max) {
  const c = await ensureInitialized();
  const key = aiTextKey(text);
  if (!key) return false;
  const res = await c.cache.updateOne(
    { channel, text: key },
    {
      $set: { answer: String(answer || '') },
      $setOnInsert: { channel, text: key, hits: 0, lastHitAt: null, createdAt: new Date() },
    },
    { upsert: true }
  );
  const added = Boolean(res.upsertedCount);

  if (added && max > 0) {
    const total = await c.cache.countDocuments({ channel });
    if (total > max) {
      const rows = await c.cache
        .find({ channel }, { projection: { _id: 1, lastHitAt: 1, createdAt: 1 } })
        .toArray();
      rows.sort(
        (a, b) =>
          (a.lastHitAt || a.createdAt || 0).valueOf() - (b.lastHitAt || b.createdAt || 0).valueOf()
      );
      const stale = rows.slice(0, total - max);
      if (stale.length) await c.cache.deleteMany({ _id: { $in: stale.map((d) => d._id) } });
    }
  }
  return added || Boolean(res.matchedCount);
}

// Вопросы этого канала, на которые ответ уже был, - для поиска похожего в
// shared/memoryRecall.js. Не замена findCachedAnswer: тот отдаёт ответ при точном совпадении и
// без обращения к модели, а это выборка кандидатов для подсказки в промт.
//
// Выборка ограничена и упорядочена по последнему обращению, а не по дате создания: потолок кэша
// выше того, что имеет смысл читать на горячем пути, и строка, к которой обращались недавно, - и
// есть та, о которой спросят снова. Тот же порядок, по которому ротация выбирает, что вытеснить.
async function recentAnswers(channel, limit) {
  const c = await ensureInitialized();
  if (!limit) return [];
  return c.cache
    .find({ channel }, { projection: { text: 1, answer: 1 } })
    .sort({ lastHitAt: -1, createdAt: -1 })
    .limit(limit)
    .toArray();
}

// Заготовка устарела: стереть её или переписать. Возвращает число тронутых строк.
//
// ПРАВЯТСЯ ВСЕ СТРОКИ КАНАЛА С ЭТИМ ОТВЕТОМ, а не одна показанная модели. Путь cacheSimilar
// заводит на один и тот же ответ новый ключ при каждой новой формулировке вопроса, поэтому у
// прижившегося ответа строк обычно несколько; удалив одну, мы оставили бы близнецов, которые
// отвечают тем же самым и мгновенно - то есть починка была бы незаметной и неполной.
//
// Совпадение по тексту ответа, а не по ключу вопроса, потому что устаревает именно утверждение:
// «стрим в 19:00» неверно во всех формулировках сразу. Ценой этого два разных вопроса с
// одинаковым коротким ответом («да», «не знаю») чинятся вместе - строка стоит один вызов модели
// и заводится заново при следующем вопросе, так что цена ошибки здесь ровно один вызов.
//
// `hits` и `lastHitAt` при замене не сбрасываются: они про то, как часто СПРАШИВАЮТ, а спрашивать
// стали не реже оттого, что ответ переписали. По ним же работает вытеснение.
async function fixCachedAnswer(channel, staleAnswer, replacement) {
  const c = await ensureInitialized();
  const answer = String(staleAnswer || '');
  if (!answer) return 0;
  const text = String(replacement || '');
  if (text) {
    // fixedAt - единственный след того, что строку переписала модель, а не записал первый ответ на
    // этот вопрос: страница кэша в панели показывает текст, и без отметки исправленная строка
    // неотличима от исходной.
    const res = await c.cache.updateMany({ channel, answer }, { $set: { answer: text, fixedAt: new Date() } });
    return res.modifiedCount || 0;
  }
  const res = await c.cache.deleteMany({ channel, answer });
  return res.deletedCount || 0;
}

// --- кто на дне шкалы ------------------------------------------------------

// --- channel memory --------------------------------------------------------

// What the bot has learnt about a channel and keeps re-reading. Deliberately a collection of short
// separate facts rather than one growing block of text: the model adds and drops them one at a
// time, and an admin curating them needs a row to delete, not a paragraph to re-edit. The
// admin-written cheat sheet in ChannelConfig stays what it was - this sits next to it.
//
// EVERY fact here is sent on EVERY billed call for that channel, so the count is a cost decision,
// not just a tidiness one - which is why the ceiling is a setting (memoryMax) and why the
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
        // Чей это факт. Учить бота может кто угодно, но слово стримера весит больше слова
        // случайного зрителя - см. factPriority в shared/memoryRecall.js.
        authorRole: meta.authorRole || 'viewer',
        sourceMessage: meta.sourceMessage || null,
        // Слова, по которым этот факт надо находить, помимо его собственных - их придумывает та же
        // модель в том же вызове (shared/memoryRecall.js:factStems). Пишутся только при вставке,
        // как и сам текст: повтор того же факта - это тот же факт, а не повод переписать его
        // поисковые слова. Строки, записанные до появления поля, приезжают без него, и отбор
        // работает по одному тексту, как работал раньше.
        keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
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
      // Вылетают сначала факты от менее авторитетных авторов, и уже внутри одного веса - те, к
      // которым дольше всего не обращались. Сортировать этим в Mongo нельзя (вес - не поле, а
      // правило), поэтому строки читаются и упорядочиваются здесь; их сотни, не миллионы.
      const rows = await c.memory
        .find({ channel, source: 'ai' }, { projection: { _id: 1, authorRole: 1, source: 1, lastUsedAt: 1, createdAt: 1 } })
        .toArray();
      rows.sort((a, b) => {
        const pa = factPriority(a);
        const pb = factPriority(b);
        if (pa !== pb) return pa - pb;
        const ta = (a.lastUsedAt || a.createdAt || 0).valueOf();
        const tb = (b.lastUsedAt || b.createdAt || 0).valueOf();
        return ta - tb;
      });
      const stale = rows.slice(0, total - max);
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

// --- viewer memory ---------------------------------------------------------

// Что бот знает про конкретных людей в чате. Отдельная коллекция, а не признак у строки в памяти
// канала, потому что у этих фактов есть адресат: факт про канал нужен в каждом запросе по каналу,
// факт про Васю - ровно тогда, когда говорит Вася или когда про него спросили. Одна таблица на
// двоих означала бы либо возить память обо всех зрителях в каждом запросе, либо завести в ней поле
// «про кого», то есть ту же коллекцию, только без индекса под неё.
//
// Ключ - {channel, userId, key}, а не логин: ники на Twitch меняются, id нет, а строка живёт долго.
// Логин лежит рядом и переписывается при каждой записи - в промте и в админке человек узнаётся по
// нику, и показать устаревший хуже, чем не показать никакого.
//
// ПИШЕТСЯ ВСЕГДА В СВОЙ КАНАЛ, ЧИТАТЬСЯ МОЖЕТ ПО НЕСКОЛЬКИМ. Канал в ключе остаётся, даже когда
// про человека: автор, роль и исходное сообщение - свидетельство
// местное, страница курирования в панели тоже на канал, а один и тот же факт, сказанный в двух
// чатах, - это два независимых свидетельства, а не одно. Дубль строки дешевле склейки, у которой
// не было бы ни одного автора.
//
// ПРО КОГО МОЖНО ЗАПИСАТЬ. Про любого, кто есть в текущем разговоре, а не только про самого
// говорящего: рассказывают в чате чаще про соседа, чем про себя. Плата за это - подставные факты,
// и именно поэтому у строки всегда сохранены автор (authorLogin/authorUserId/authorRole) и само
// сообщение: адресат и источник тут разные люди, и без источника разобрать спорную строку в
// админке невозможно. Вес автора (factPriority) здесь значит больше, чем в памяти канала, - там
// строки почти всегда про то же, что и говорящий, а тут слово стримера про зрителя и слово
// случайного зрителя про него же лежат рядом.

// Кладёт в AiConfig текст встроенных правил, чтобы панель могла его показать и вернуть.
//
// ЕДИНСТВЕННОЕ ПОЛЕ, КОТОРОЕ БОТ ПИШЕТ В ЭТОТ ДОКУМЕНТ - остальное туда пишет сайт. Так сделано
// потому, что текст живёт в коде бота: держать его вторую копию в репозитории сайта (репозитории
// не импортируют друг друга) значило бы синхронизировать вручную две страницы прозы, а такая
// копия расходится молча и обнаруживается только тем, что кнопка «вернуть встроенные» вставляет
// не то, что на самом деле уходит в запрос. Пишущий один - тот, кому текст принадлежит.
//
// Сайт это поле только читает и никогда не сохраняет обратно из формы.
// --- отношение к зрителю ---------------------------------------------------

async function publishBuiltinPrompt(text) {
  try {
    const c = await ensureInitialized();
    await c.config.updateOne(
      { _id: 'global' },
      { $set: { builtinSystemPrompt: String(text || '') } },
      { upsert: true }
    );
  } catch (err) {
    // Не критично: панель просто не покажет встроенный текст, а бот продолжит на нём работать.
    console.error('[aiStore] publishBuiltinPrompt failed:', err.message);
  }
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
    // Отзыв смайликом сюда не попадает. Это не реплика в разговоре, а зеркало: пять таких строк
    // вытеснили бы из промта настоящие вопросы этого зрителя и заняли бы место во входных
    // токенах - то есть путь, заведённый ради экономии, начал бы её же и проедать.
    .find({ channel, userId: String(userId), source: { $ne: 'emote' }, answer: { $nin: [null, ''] } })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return rows.reverse().map((r) => ({ question: r.question, answer: r.answer }));
}

// Последние ответы бота в ЭТОМ КАНАЛЕ, кому бы они ни были адресованы. Не разговор и не память:
// нужны они ради одного - чтобы модель видела, чем сама недавно начинала, и начала иначе. Что с
// ними делать дальше, решает games/aiReply.js, здесь только выборка.
//
// Берутся только ушедшие в чат: ответ, которого никто не видел, повторить не страшно.
// Смайликовые отзвуки исключены - это не ответ, а эхо, и зачина у них нет.
//
// Ответы из кэша и фильтра попадают сюда наравне с ответами модели, и это намеренно: в чате они
// выглядят такими же репликами бота, а повторяться бот не должен ни за собой, ни за заготовкой.
async function recentReplies(channel, limit) {
  const c = await ensureInitialized();
  if (!limit) return [];
  const rows = await c.log
    .find(
      { channel, sent: true, source: { $ne: 'emote' }, answer: { $nin: [null, ''] } },
      { projection: { answer: 1 } }
    )
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return rows.map((r) => String(r.answer));
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
  fixCachedAnswer,
  recentAnswers,
  publishBuiltinPrompt,
  listMemory,
  rememberFact,
  touchFacts,
  forgetFact,
  writeLog,
  recentExchanges,
  recentReplies,
  countBilledSince,
  streamCard,
};
