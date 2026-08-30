// Один вызов модели, два поставщика: Anthropic и Google.
//
// ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Здесь только сам запрос и разбор ответа. Правила, промт, память,
// очистка ответа, журнал и все решения о том, отвечать ли вообще, остаются в games/aiReply.js.
// Модуль появился, когда к платной модели добавилась бесплатная: разница между поставщиками -
// это форма запроса и формат счёта, а не поведение фичи. Развилка по поставщику прямо в месте
// вызова означала бы вторую копию разбора ответа, то есть второе место, где могут разойтись
// вердикт, кэшируемость и записи в память.
//
// КОНТРАКТ - НЕ «ЧАТ», А ИНСТРУМЕНТ. Вызов всегда принудительно вызывает инструмент answer и
// возвращает его поля: обычного текста фиче недостаточно, потому что тем же вызовом приезжают
// вердикт, метка кэшируемости и записи в память. Оба поставщика это умеют, но называют по-разному
// (tools + tool_choice против functionDeclarations + functionCallingConfig), поэтому схема
// инструмента описана один раз - в games/aiReply.js, в форме Anthropic, - а перевод её во вторую
// форму лежит здесь.
//
// СЧЁТ ПРИВЕДЁН К ФОРМЕ ANTHROPIC, потому что в ней уже написаны и колонки журнала, и формула
// цены. Разница не косметическая: у Anthropic `input_tokens` - это НЕКЭШИРОВАННЫЙ ОСТАТОК, а у
// Google `promptTokenCount` включает кэш целиком. Сложить их одинаково значит посчитать кэш дважды.
const axios = require('axios');

// Цены поставщиков, USD за миллион токенов, проверены 2026-08-30. Заполняют только колонку расхода
// в журнале: устаревшее число врёт о счёте, но никогда не меняет поведение. Модель, которой здесь
// нет, пишет пустую цену, а не приблизительную.
//
// У Gemini указана цена ПЛАТНОГО тарифа. На бесплатном тарифе Google запрос не стоит ничего и
// упирается не в деньги, а в лимит запросов, так что колонка расхода читается там как «сколько бы
// это стоило» - верхняя граница, а не счёт. Сами лимиты здесь не записаны намеренно: это
// показания, они живут в консоли AI Studio и меняются без нашего участия. Плата за бесплатный
// тариф другая: Google учится на том, что мы шлём, а шлём мы сообщения зрителей и память о них.
const PRICING = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
};

// Кэш тарифицируется от ВХОДНОЙ цены модели: чтение вдесятеро дешевле (у Anthropic по прайсу, у
// Google $0.03 против $0.30 - тот же множитель), запись на четверть дороже. Запись есть только у
// Anthropic: там пятиминутный ephemeral ставим мы сами, а у Google кэш неявный - ставить его
// нечем и платить за постановку не за что, поэтому cacheWriteTokens оттуда не приходит вовсе.
//
// Замер на gemini-3.5-flash-lite (2026-08-30): три одинаковых запроса подряд, ~2.2k входных
// токенов - неявный кэш не включился ни разу, cacheReadTokens ноль во всех трёх. То есть правила
// там оплачиваются целиком каждым вызовом, а не читаются из кэша, как на стороне Anthropic;
// колонка кэша на этом поставщике показывает ноль честно, а не по ошибке.
//
// Без этих двух множителей колонка расхода занижала счёт, и молча: весь префикс с правилами и
// схемой инструмента приезжает отдельными полями, а не в `input_tokens`. На проде занижение
// составило около четверти ($0.45 в журнале против $0.56 на самом деле за 201 вызов), и оно тем
// больше, чем длиннее правила, - то есть ровно там, где по журналу и хотелось бы видеть цену правки.
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;

const GOOGLE_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

// Сколько токенов сверх самого ответа оставляем Gemini на размышление. У flash-lite размышление
// не выключается совсем (уровни minimal и low), а в maxOutputTokens оно входит вместе с ответом.
// Потолок впритык к ответу возвращает не ошибку, а обычный 200 с finishReason MAX_TOKENS и пустым
// содержимым - тот самый молчаливый отказ, ради которого потолок ответа и без того завышен.
// Длину ответа этот запас не трогает: её держит очистка после модели, а не бюджет токенов.
const THINKING_HEADROOM_TOKENS = 1600;

const KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
};

// Поставщик определяется по имени модели, а не по таблице цен выше. Разница в том, что делает
// незнакомая модель: по таблице она молча оказалась бы «без ключа» и фича перестала бы отвечать
// вообще, а по префиксу она уйдёт своему поставщику и вернётся ошибкой API - видимой строкой в
// журнале. Заодно новая модель того же поставщика начинает работать без выкладки бота: цены для
// неё не будет, и расход запишется пустым, а не приблизительным.
function providerOf(model) {
  return String(model || '').startsWith('gemini') ? 'google' : 'anthropic';
}

// Ключи у поставщиков разные и лежат в разных переменных .env. Проверка синхронная, потому что её
// зовёт синхронная же проверка пригодности сообщения в aiReply.tryAnswer: без ключа сообщение
// должно уйти скриптовым фразам, а не в заведомо неудачный вызов.
function hasKey(model) {
  return Boolean(process.env[KEY_ENV[providerOf(model)]]);
}

function costUsd(model, usage) {
  const price = PRICING[model];
  if (!price || !usage || usage.inputTokens == null) return null;
  return (
    (usage.inputTokens * price.input +
      (usage.outputTokens || 0) * price.output +
      (usage.cacheReadTokens || 0) * price.input * CACHE_READ_RATE +
      (usage.cacheWriteTokens || 0) * price.input * CACHE_WRITE_RATE) /
    1e6
  );
}

// --- Anthropic ----------------------------------------------------------------------------------

// Клиент строится при первом обращении: ключ необязателен, и выкладка без него должна падать в
// скриптовые ответы, а не отказываться стартовать.
let anthropic = null;
function anthropicClient() {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Никаких повторов на стороне SDK: у всего ответа жёсткий бюджет в несколько секунд, и
      // повтор потратит его на ответ, который уже поздно отправлять.
      maxRetries: 0,
    });
  }
  return anthropic;
}

async function askAnthropic({ model, system, user, tool, maxTokens, timeoutMs }) {
  const res = await anthropicClient().messages.create(
    {
      model,
      max_tokens: maxTokens,
      // Правила и характер одинаковы для всех каналов и всех сообщений, поэтому они и есть
      // устойчивый префикс кэша; всё переменное лежит ниже, в реплике пользователя. Хватило ли
      // префикса, чтобы кэш вообще включился, видно в колонке cacheReadTokens журнала - короткий
      // промт молча не кэшируется.
      system: [
        {
          type: 'text',
          text: system,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [tool],
      tool_choice: { type: 'tool', name: tool.name },
      messages: [{ role: 'user', content: user }],
    },
    // Таймаут запросом, а не клиентом: клиент один на процесс, и зашитый в него таймаут означал бы,
    // что правка настройки в панели доезжает до бота только перезапуском - в отличие от всех
    // остальных настроек этой фичи.
    { timeout: timeoutMs }
  );

  const content = res.content || [];
  const call = content.find((b) => b.type === 'tool_use');
  const usage = res.usage || {};
  return {
    fields: call && call.input ? call.input : null,
    text: content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' '),
    usage: {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cacheReadTokens: usage.cache_read_input_tokens ?? null,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
    },
  };
}

// --- Google -------------------------------------------------------------------------------------

// Google принимает лишь подмножество OpenAPI: `strict` и `additionalProperties` ему неизвестны, а
// неизвестное поле схемы - это ошибка запроса, а не предупреждение. Тип пишется заглавными.
// Перевод живёт здесь, чтобы схема инструмента оставалась одна на обоих поставщиков.
function toGoogleSchema(node) {
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'additionalProperties' || key === 'strict') continue;
    if (key === 'type') out.type = String(value).toUpperCase();
    else if (key === 'items') out.items = toGoogleSchema(value);
    else if (key === 'properties') {
      out.properties = {};
      for (const [name, sub] of Object.entries(value)) out.properties[name] = toGoogleSchema(sub);
    } else out[key] = value;
  }
  return out;
}

async function askGoogle({ model, system, user, tool, maxTokens, timeoutMs }) {
  const res = await axios.post(
    GOOGLE_ENDPOINT + '/' + encodeURIComponent(model) + ':generateContent',
    {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: tool.name,
              description: tool.description,
              parameters: toGoogleSchema(tool.input_schema),
            },
          ],
        },
      ],
      // ANY плюс явный список имён - это и есть «вызови именно answer», аналог tool_choice. Без
      // него модель вправе ответить обычным текстом, а текста здесь мало: см. контракт в шапке.
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [tool.name] } },
      generationConfig: {
        maxOutputTokens: maxTokens + THINKING_HEADROOM_TOKENS,
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
    },
    {
      timeout: timeoutMs,
      // Ключ заголовком, а не параметром ?key=, как в примерах документации: адрес запроса попадает
      // и в текст ошибки axios, и в любой лог рядом с ней, а ключу там не место.
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
    }
  );

  const data = res.data || {};
  const candidate = (data.candidates || [])[0] || {};
  const parts = (candidate.content && candidate.content.parts) || [];
  const call = parts.find((p) => p.functionCall && p.functionCall.name === tool.name);

  const usage = data.usageMetadata || {};
  const cached = usage.cachedContentTokenCount || 0;
  return {
    fields: call && call.functionCall.args ? call.functionCall.args : null,
    // Размышление приезжает такими же текстовыми частями, только с пометкой thought. В запасной
    // текст оно не годится: это черновик рассуждения, а не ответ зрителю.
    text: parts
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join(' '),
    usage: {
      // Кэш вычитается, чтобы не быть посчитанным дважды - см. шапку файла.
      inputTokens: usage.promptTokenCount != null ? usage.promptTokenCount - cached : null,
      // Размышление тарифицируется как выход и приезжает отдельным полем. Не сложив их, колонка
      // расхода занижала бы счёт ровно тем же способом, каким когда-то занижала его на кэше.
      outputTokens: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
      cacheReadTokens: cached,
      cacheWriteTokens: null,
    },
  };
}

// Единственный способ обратиться к модели. Возвращает {fields, text, usage}: fields - поля
// инструмента answer (или null, если модель их не отдала: обрыв по потолку токенов и отказ
// выглядят именно так), text - запасной текстовый ответ, usage - счёт в форме Anthropic.
async function ask(params) {
  return providerOf(params.model) === 'google' ? askGoogle(params) : askAnthropic(params);
}

module.exports = { ask, hasKey, costUsd, providerOf, PRICING };
