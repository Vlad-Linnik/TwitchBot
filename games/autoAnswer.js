// Автоответы: бот отвечает на вопрос, который чат задаёт снова и снова.
//
// Темы заводит модератор на сайте (/<channel>/auto-answers), бот их только исполняет.
// Сопоставление целиком лежит в shared/autoAnswerMatch.js - здесь только поведение: когда
// промолчать, когда подождать, когда сказать.
//
// ДВА ПРАВИЛА:
//
//   1. ОТВЕТ МГНОВЕННЫЙ. Раньше здесь была пауза в 12 секунд с отменой, если за это время
//      успевал ответить стример или модератор - на том основании, что бота никто не звал и
//      влезать в чужой разговор ему следует осторожно. Владелец решил иначе: отвечать сразу.
//      Отмена по «ответил человек» ушла вместе с паузой, потому что была ею и реализована -
//      отменять стало нечего. Обратная проверка («модератор писал в последние N секунд -
//      молчим») сюда не годится: модератор, обсуждающий что-то своё, глушил бы законный ответ.
//   2. КУЛДАУН НА ТЕМУ, а не на канал. На живых логах видно, зачем: один и тот же человек
//      спросил дважды за 43 секунды. Уходит один ответ. Ответ идёт ТРЕДОМ на сообщение
//      спрашивающего, а не в общий чат.
//
// Тестовый режим темы проходит ровно тот же путь и пишет ровно ту же строку в журнал - и
// останавливается перед самой отправкой. Именно поэтому журналу можно верить: он показывает
// не «что бы примерно случилось», а что случилось, с точностью до последнего шага.
const matcher = require('../shared/autoAnswerMatch.js');
const autoAnswersRepo = require('../db/autoAnswersRepo.js');

// '#channel:<topicId>' -> timestamp последнего срабатывания (кулдаун)
const lastFired = new Map();

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

  const best = matcher.selectTopic(analysis, docs.map(matcher.toMatcherTopic));
  if (!best) return 0;

  const topic = docs[best.index];
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
