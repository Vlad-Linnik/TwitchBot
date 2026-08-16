// Чтение тем автоответов и запись журнала срабатываний.
//
// ВЛАДЕНИЕ. `AutoAnswers` пишет САЙТ (TwitchBot-Web/db/autoAnswersRepo.js), бот только читает -
// то же направление, что у ChannelConfig, и обратное custom_commands/counters. Чат-команды для
// создания темы нет и не должно быть: тема это редакторское решение («чат раз за разом
// спрашивает X, вот один ответ»), а не действие в чате. `AutoAnswerHits` наоборот: пишет
// только бот, сайт читает и правит у строки единственное своё поле `review`.
//
// КЭШ И ГОРЯЧИЙ ПУТЬ. getTopics() СИНХРОННАЯ и всегда возвращает мгновенно - её зовут на каждое
// сообщение чата, и round-trip в Mongo там недопустим (та же причина, по которой
// config/channelSettings.js держит свой TTL-кэш). Пока первая загрузка не прошла, кэш пуст, что
// означает «тем нет» - фича просто молчит, а не роняет обработку сообщений.
//
// Пустой кэш - безопасное состояние по построению: молчание это дефолт всей фичи.
const { connect } = require('./db.js');

// Столько же, сколько у CustomCommands.refreshFromDatabase - правка на сайте доезжает до
// живого бота за те же ~10 секунд, что и правка кастомной команды.
const REFRESH_INTERVAL_MS = 10000;

let topicsCollection = null;
let hitsCollection = null;
let refreshTimer = null;

// '#channel' -> массив документов тем (только mode 'test'/'live' - выключенные не грузим вовсе)
const cache = new Map();

async function ensureInitialized() {
  if (topicsCollection && hitsCollection) return;
  const db = await connect();
  topicsCollection = db.collection('AutoAnswers');
  hitsCollection = db.collection('AutoAnswerHits');
}

/**
 * Перечитать темы всех каналов, где бот сидит.
 *
 * Один запрос на все каналы, а не по запросу на канал: тем во всём проекте единицы, и
 * $in по списку логинов дешевле, чем N round-trip'ов каждые 10 секунд.
 */
async function refresh(channels) {
  await ensureInitialized();
  const logins = channels.map((c) => (c.startsWith('#') ? c : `#${c}`).toLowerCase());
  if (!logins.length) return;

  const docs = await topicsCollection
    .find({ channel: { $in: logins }, mode: { $in: ['test', 'live'] } })
    .toArray();

  const next = new Map();
  for (const login of logins) next.set(login, []);
  for (const doc of docs) {
    const list = next.get(doc.channel);
    if (list) list.push(doc);
  }

  // Меняем карту целиком, а не правим по месту: обработчик сообщений читает её без всякой
  // синхронизации, и он должен видеть либо старый полный набор, либо новый полный набор,
  // но никогда наполовину заполненный.
  cache.clear();
  for (const [key, value] of next) cache.set(key, value);
}

/** Запустить периодическое обновление. Зовётся один раз из index.js. */
function startRefreshLoop(channels) {
  if (refreshTimer) return;
  const tick = () => {
    refresh(channels).catch((err) =>
      console.error('[AutoAnswers] не удалось обновить темы:', err.message)
    );
  };
  tick();
  refreshTimer = setInterval(tick, REFRESH_INTERVAL_MS);
  if (refreshTimer.unref) refreshTimer.unref();
}

function stopRefreshLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/** СИНХРОННО: темы канала из кэша. Пустой массив, если ничего не загружено. */
function getTopics(channel) {
  return cache.get(String(channel).toLowerCase()) || [];
}

/**
 * Записать срабатывание.
 *
 * Fire-and-forget, как все счётчики в db/chatStats.js: журнал не должен ни задерживать ответ
 * в чат, ни валить обработку сообщения, если Mongo моргнула.
 *
 * `topicTitle` денормализован намеренно - тему могут удалить, а её история остаётся интересной,
 * и лента, наполовину состоящая из «удалённая тема», для оценки поведения фичи бесполезна.
 */
function recordHit({ channel, topic, userState, message, match, question, sent, skipReason }) {
  ensureInitialized()
    .then(() =>
      hitsCollection.insertOne({
        channel: String(channel).toLowerCase(),
        topicId: topic._id,
        topicTitle: topic.title,
        userId: userState['user-id'] || null,
        userName: userState['display-name'] || userState.username || null,
        message,
        spans: match.spans,
        matchedRequired: match.matchedRequired,
        matchedOptional: match.matchedOptional,
        questionScore: question ? question.score : null,
        questionSignals: question ? question.signals : [],
        mode: topic.mode,
        sent: Boolean(sent),
        skipReason: skipReason || null,
        review: null,
        createdAt: new Date(),
      })
    )
    .catch((err) => console.error('[AutoAnswers] не удалось записать срабатывание:', err.message));
}

module.exports = {
  startRefreshLoop,
  stopRefreshLoop,
  refresh,
  getTopics,
  recordHit,
  REFRESH_INTERVAL_MS,
};
