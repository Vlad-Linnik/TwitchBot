// Запасной запрос и автоматическая смена модели для ИИ-ответов.
//
// ЗАЧЕМ. Сбой модели - это почти всегда не наша ошибка, а перегрузка у поставщика, и она
// проходит сама. Замер 2026-11-20, по четыре одинаковых запроса подряд с одной машины:
//   gemini-3.5-flash-lite  503 через 8 с, затем 1.1 с, 6.5 с, 1.2 с;
//   gemini-3.6-flash       13-24 с на каждый ответ, то есть всегда дольше 10-секундного таймаута;
//   gemini-3.8-flash       два зависания по 30 с и два 503.
// Отсюда две вещи. Повтор сразу после сбоя обычно проходит, особенно на самой быстрой модели, - это
// запасной запрос. А модель, которая падает раз за разом, лучше на время не спрашивать первой
// вовсе, а не тратить на неё таймаут каждого ответа, - это переключение.
//
// ЧТО ПОВТОРЯЕТСЯ. Только то, что проходит само: таймаут, обрыв сети (ответа нет вовсе), 408,
// 429, 5xx и 529 (перегрузка Anthropic). Ошибка запроса (400), ключа (401/403) или имени модели
// (404) от повтора не исчезнет - она возвращается сразу и попадает в журнал как есть, иначе
// неверная настройка пряталась бы за запасной моделью и её никто бы не заметил.
//
// ПОПЫТОК НЕ БОЛЬШЕ ДВУХ, и каждая со своим таймаутом из панели. Ответ, который пришёл позже, чем
// две такие попытки, в чат уже не уходит (aiReply.js считает окно опоздания через attemptsFor).
const aiProvider = require('./aiProvider.js');
const errorRingBuffer = require('../shared/errorRingBuffer.js');

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

// Сколько сбоев подряд за окно переключают модель и на сколько. Два, а не один: одиночный 503
// случается и у здоровой модели, и его закрывает запасной запрос. Десять минут - столько же,
// сколько держится открытым инцидент без новых сбоев (shared/healthTracker.js): по истечении
// основная модель снова спрашивается первой, и одна неудача тут же возвращает переключение.
const SWITCH_AFTER_FAILURES = 2;
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const SWITCH_FOR_MS = 10 * 60 * 1000;

// model -> { failures: number[], switchedUntil: number }
const modelState = new Map();

function stateOf(model) {
  if (!modelState.has(model)) modelState.set(model, { failures: [], switchedUntil: 0 });
  return modelState.get(model);
}

function isRetryable(err) {
  const status = err && (err.response ? err.response.status : err.status);
  if (status) return RETRYABLE_STATUS.has(Number(status));
  // Ответа нет вовсе: таймаут, обрыв, DNS. У axios это ECONNABORTED/ETIMEDOUT/ECONNRESET, у SDK
  // Anthropic - APIConnectionError без status. И то и другое лечится повтором.
  return true;
}

// Пустое значение - запасной модели нет (её выключили в панели). Модель без ключа запасной тоже не
// годится: вызов заведомо упадёт, а время на него уйдёт настоящее.
function fallbackFor(cfg) {
  const fb = String(cfg.fallbackModel || '').trim();
  if (!fb || !aiProvider.hasKey(fb)) return null;
  return fb;
}

// Порядок попыток. Когда запасная совпадает с основной, это просто повтор той же модели - на
// flash-lite он и есть самое быстрое лекарство от 503.
function plan(cfg, now = Date.now()) {
  const primary = cfg.model;
  const fallback = fallbackFor(cfg);
  if (!fallback) return [primary];
  if (fallback !== primary && stateOf(primary).switchedUntil > now) return [fallback, primary];
  return [primary, fallback];
}

function attemptsFor(cfg) {
  return plan(cfg).length;
}

function switchedTo(cfg, now = Date.now()) {
  const order = plan(cfg, now);
  return order[0] !== cfg.model ? order[0] : null;
}

function noteFailure(model, fallback, now) {
  const st = stateOf(model);
  st.failures = st.failures.filter((ts) => now - ts < FAILURE_WINDOW_MS);
  st.failures.push(now);
  if (!fallback || fallback === model) return;
  if (st.failures.length >= SWITCH_AFTER_FAILURES && st.switchedUntil <= now) {
    st.switchedUntil = now + SWITCH_FOR_MS;
    const message =
      `AI-ответы: ${model} не ответила ${st.failures.length} раз за ${FAILURE_WINDOW_MS / 60000} мин,` +
      ` следующие ${SWITCH_FOR_MS / 60000} мин первой спрашивается ${fallback}.`;
    errorRingBuffer.record('info', message);
    console.log('[aiReply] ' + message);
  } else if (st.switchedUntil > now) {
    // Проба после переключения не удалась - переключение продлевается без новой строки в панели.
    st.switchedUntil = now + SWITCH_FOR_MS;
  }
}

function noteSuccess(model) {
  const st = stateOf(model);
  st.failures = [];
  st.switchedUntil = 0;
}

// Тот же контракт, что у aiProvider.ask, плюс:
//   model         - модель, которая ответила на самом деле (её цену и пишем в журнал);
//   fallbackFrom  - основная модель, если ответила не она, иначе null;
//   attempts      - [{ model, ms, error }] по каждой попытке, включая удачную (error: null).
// При полной неудаче бросает ошибку последней попытки с тем же attempts на ней.
async function ask(cfg, params, describeError) {
  const order = plan(cfg);
  const fallback = fallbackFor(cfg);
  const attempts = [];
  let lastErr = null;

  for (let i = 0; i < order.length; i++) {
    const model = order[i];
    const started = Date.now();
    try {
      const res = await aiProvider.ask({ ...params, model, timeoutMs: cfg.requestTimeoutMs });
      attempts.push({ model, ms: Date.now() - started, error: null });
      noteSuccess(model);
      return { ...res, model, fallbackFrom: model !== cfg.model ? cfg.model : null, attempts };
    } catch (err) {
      attempts.push({ model, ms: Date.now() - started, error: describeError(err) });
      lastErr = err;
      if (!isRetryable(err)) break;
      noteFailure(model, fallback, Date.now());
    }
  }

  lastErr.attempts = attempts;
  throw lastErr;
}

module.exports = {
  ask,
  plan,
  attemptsFor,
  switchedTo,
  isRetryable,
  SWITCH_AFTER_FAILURES,
  SWITCH_FOR_MS,
  // для проверки без сети
  _reset: () => modelState.clear(),
};
