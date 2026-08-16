// Автоответы: бот отвечает на вопрос, который чат задаёт снова и снова.
//
// Темы заводит модератор на сайте (/<channel>/auto-answers), бот их только исполняет.
// Сопоставление целиком лежит в shared/autoAnswerMatch.js - здесь только поведение: когда
// промолчать, когда подождать, когда сказать.
//
// ДВА ПРАВИЛА:
//
//   1. ОТВЕТ МГНОВЕННЫЙ. Отложенной отправки здесь нет намеренно. Пауза с отменой «если
//      человек успел ответить сам» выглядит вежливее, но требует держать отложенную отправку
//      на канал и тему, а ответ приходит в чат, который за это время уехал. Обратная проверка
//      («модератор писал в последние N секунд - молчим») не годится тем более: модератор,
//      обсуждающий что-то своё, глушил бы законный ответ. Вместо этого лишние ответы
//      отсекаются раньше - пропуском модераторов и кулдауном на тему.
//   2. КУЛДАУН НА ТЕМУ, а не на канал. На живых логах видно, зачем: один и тот же человек
//      спросил дважды за 43 секунды. Уходит один ответ. Ответ идёт ТРЕДОМ на сообщение
//      спрашивающего, а не в общий чат.
//
// Тестовый режим темы проходит ровно тот же путь и пишет ровно ту же строку в журнал - и
// останавливается перед самой отправкой. Именно поэтому журналу можно верить: он показывает
// не «что бы примерно случилось», а что случилось, с точностью до последнего шага.
const matcher = require('../shared/autoAnswerMatch.js');
const autoAnswersRepo = require('../db/autoAnswersRepo.js');
const { isMod } = require('../shared/isMod.js');
const botInitInfo = require('../botInitInfo.js');

// '#channel:<topicId>' -> timestamp последнего срабатывания (кулдаун)
const lastFired = new Map();

// Разобранные правила тем. Ключ - сам массив тем из кэша репозитория: он ЗАМЕНЯЕТСЯ целиком
// на каждом обновлении (db/autoAnswersRepo.js меняет карту, а не правит по месту), поэтому
// смена его идентичности и есть признак «правило поменялось». WeakMap, чтобы старый разбор
// уходил вместе со старым массивом.
//
// Без этого кэша разбор правила шёл заново на КАЖДОМ сообщении чата: normalizeTopic
// стеммирует каждое слово темы, и на теме из 54 слов это 113 мкс на сообщение против 3 мкс
// с готовой темой - больше, чем стоит вся остальная обработка сообщения вместе взятая.
const parsedTopics = new WeakMap();

function matcherTopics(docs, ownLogins) {
  let parsed = parsedTopics.get(docs);
  if (!parsed) {
    parsed = docs.map((doc) => matcher.normalizeTopic(matcher.toMatcherTopic(doc, { ownLogins })));
    parsedTopics.set(docs, parsed);
  }
  return parsed;
}

function cooldownKey(channel, topic) {
  return `${channel}:${topic._id}`;
}

/**
 * Обработать сообщение. Возвращает 1, если тема подошла (и дальше по конвейеру идти незачем).
 *
 * Возвращает 1 и в тестовом режиме тоже: тема ПОДОШЛА, и шуточный ответ из
 * games/questionToThisBot.js поверх настоящего вопроса - ровно то, чего тест должен избежать.
 */
function handle(client, channel, userState, message) {
  const docs = autoAnswersRepo.getTopics(channel);
  if (!docs.length) return 0;

  const analysis = matcher.analyzeMessage(message);
  if (analysis.isCommand) return 0;

  // Чьи «@упоминания» тема считает своими: сам канал и бот. Всё остальное - разговор
  // зрителей между собой, и тема на него по умолчанию молчит (см. normalizeTopic).
  const ownLogins = [channel, botInitInfo.settings.username].filter(Boolean);
  const best = matcher.selectTopic(analysis, matcherTopics(docs, ownLogins));
  if (!best) return 0;

  const topic = docs[best.index];

  // Модератор и стример - не та аудитория. Автоответ существует для зрителя, который не
  // прочитал готовый ответ на экране; модератор про этот ответ знает, он его и написал.
  // На живых логах #mistercop заметная часть ложных срабатываний оказалась перепиской
  // модераторов со стримером о состоянии фильтра («нужно что-то в фильтре поменять?»), и
  // словами она от настоящих вопросов не отличается - зато отличается тем, КТО спросил.
  //
  // Не записывается даже в журнал: это не «тема сработала и была подавлена», это сообщение,
  // которое фича не рассматривает вовсе, и строка о нём засоряла бы ленту разметки.
  if (topic.skipModerators !== false && isMod(userState)) return 0;
  const record = (sent, skipReason) =>
    autoAnswersRepo.recordHit({
      channel,
      topic,
      userState,
      message,
      match: best.match,
      question: analysis.question,
      sent,
      skipReason,
    });

  if (topic.mode !== 'live') {
    record(false, 'test_mode');
    return 1;
  }

  // Кулдаун ставится в момент СРАБАТЫВАНИЯ, а не отправки: иначе пять человек, спросивших за
  // время паузы, поставили бы пять отложенных ответов, и отмена по «ответил человек» спасла бы
  // только первый. Уже стоящая отложенная отправка считается тем же кулдауном.
  // Отсутствие записи в lastFired - это «ещё ни разу не срабатывала», и проверять его надо
  // явно. Привычное `Date.now() - (lastFired.get(key) || 0)` считает, что тема сработала в
  // 1970-м; в проде разница выходит огромной и ответ уходит как надо, то есть код работает
  // ПО СЛУЧАЙНОСТИ, а не потому что выражает нужное. Достаточно любых часов, отсчитывающих
  // не от эпохи, чтобы первая же тема канала намертво встала на кулдаун.
  const key = cooldownKey(channel, topic);
  const cooldownMs = (topic.cooldownSeconds || 300) * 1000;
  const firedAt = lastFired.get(key);
  const onCooldown = firedAt != null && Date.now() - firedAt < cooldownMs;
  if (onCooldown) {
    record(false, 'cooldown');
    return 1;
  }

  // Кулдаун ставится ДО отправки, а не после: client.say идёт через Helix, и второе сообщение,
  // пришедшее пока запрос в полёте, иначе прошло бы проверку и отправило второй ответ.
  lastFired.set(key, Date.now());

  try {
    client.say(channel, topic.answer, userState['id']);
    record(true, null);
  } catch (err) {
    console.error('[AutoAnswers] не удалось отправить ответ:', err.message);
    record(false, 'error');
  }

  return 1;
}

/** Для тестов и корректного завершения процесса. */
function reset() {
  lastFired.clear();
}

module.exports = { handle, reset };
