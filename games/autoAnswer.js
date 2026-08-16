// Автоответы: бот отвечает на вопрос, который чат задаёт снова и снова.
//
// Темы заводит модератор на сайте (/<channel>/auto-answers), бот их только исполняет.
// Сопоставление целиком лежит в shared/autoAnswerMatch.js - здесь только поведение: когда
// промолчать, когда подождать, когда сказать.
//
// ТРИ ПРАВИЛА, И ВСЕ ТРИ ИЗ ОДНОГО СООБРАЖЕНИЯ: бота никто не звал.
// Люди спрашивают стримера или чат, а не бота - к боту такой человек не обратится, потому что
// он и про готовый ответ на экране не прочитал. Значит бот влезает в чужой разговор, и вести
// себя должен соответственно:
//
//   1. ПАУЗА ПЕРЕД ОТВЕТОМ. Ответ уходит не сразу, а через ANSWER_DELAY_MS, и отменяется, если
//      за это время написал стример или модератор. Ответил человек - бота как будто и не было.
//      Не заметили - бот подстраховал.
//   2. КУЛДАУН НА ТЕМУ, а не на канал. На живых логах видно, зачем: один и тот же человек
//      спросил дважды за 43 секунды. Уходит один ответ.
//   3. ОТВЕТ ТРЕДОМ на сообщение спрашивающего, а не в общий чат.
//
// Тестовый режим темы проходит ровно тот же путь и пишет ровно ту же строку в журнал - и
// останавливается перед самой отправкой. Именно поэтому журналу можно верить: он показывает
// не «что бы примерно случилось», а что случилось, с точностью до последнего шага.
const matcher = require('../shared/autoAnswerMatch.js');
const autoAnswersRepo = require('../db/autoAnswersRepo.js');
const { isMod } = require('../shared/isMod.js');

// Достаточно, чтобы стример успел ответить сам, и не настолько долго, чтобы ответ пришёл в
// уже уехавший чат.
const ANSWER_DELAY_MS = 12000;

// '#channel' -> timestamp последнего сообщения от модератора/стримера
const lastHumanAnswer = new Map();
// '#channel:<topicId>' -> timestamp последнего срабатывания (кулдаун)
const lastFired = new Map();
// '#channel:<topicId>' -> отложенная отправка
const pending = new Map();

/**
 * Отметить сообщение от человека, который может ответить сам.
 *
 * Зовётся из index.js для КАЖДОГО сообщения, включая команды: модератор, ответивший командой
 * `!фильтр`, ответил ничуть не меньше, чем модератор, ответивший текстом.
 */
function noteMessage(channel, userState) {
  if (isMod(userState)) lastHumanAnswer.set(channel, Date.now());
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
  //
  // Отсутствие записи в lastFired - это «ещё ни разу не срабатывала», и проверять его надо
  // явно. Привычное `Date.now() - (lastFired.get(key) || 0)` считает, что тема сработала в
  // 1970-м; в проде разница выходит огромной и ответ уходит как надо, то есть код работает
  // ПО СЛУЧАЙНОСТИ, а не потому что выражает нужное. Достаточно любых часов, отсчитывающих
  // не от эпохи, чтобы первая же тема канала намертво встала на кулдаун.
  const key = cooldownKey(channel, topic);
  const cooldownMs = (topic.cooldownSeconds || 300) * 1000;
  const firedAt = lastFired.get(key);
  const onCooldown = firedAt != null && Date.now() - firedAt < cooldownMs;
  if (pending.has(key) || onCooldown) {
    record(false, 'cooldown');
    return 1;
  }
  lastFired.set(key, Date.now());

  const askedAt = Date.now();
  const timer = setTimeout(() => {
    pending.delete(key);
    try {
      // Ответил ли человек, пока бот выжидал.
      const human = lastHumanAnswer.get(channel) || 0;
      if (human > askedAt) {
        record(false, 'human_answered');
        return;
      }
      client.say(channel, topic.answer, userState['id']);
      record(true, null);
    } catch (err) {
      console.error('[AutoAnswers] не удалось отправить ответ:', err.message);
      record(false, 'error');
    }
  }, ANSWER_DELAY_MS);
  if (timer.unref) timer.unref();
  pending.set(key, timer);

  return 1;
}

/** Для тестов и корректного завершения процесса. */
function reset() {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
  lastFired.clear();
  lastHumanAnswer.clear();
}

module.exports = { handle, noteMessage, reset, ANSWER_DELAY_MS };
