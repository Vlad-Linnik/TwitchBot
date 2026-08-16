// Автоответы: разбор сообщения и сопоставление его с темой, заведённой модератором.
//
// ЧТО ЭТО ЗА ФИЧА. Модератор замечает, что чат раз за разом спрашивает одно и то же
// (реальный пример из логов #mistercop - «какой фильтр» ловится 10 раз за месяц на
// 263 889 сообщений), заводит на сайте ТЕМУ: несколько примеров вопроса + один
// универсальный ответ. Бот выводит из примеров ключевые слова, модератор их правит
// руками, и дальше тема живёт в одном из трёх состояний: выключена / тестовая (ответ
// виден только на сайте) / боевая (ответ уходит в чат).
//
// ПОЧЕМУ ЗДЕСЬ НЕТ РАНЖИРОВАНИЯ. Первая версия задумывалась как поиск по FAQ с оценкой
// похожести, порогом и отрывом от второго места. Ручная курация это убила: темы заводит
// человек, их единицы, и вопрос «насколько похоже» сменился на «есть ли в сообщении
// слово, ради которого тему завели». Поэтому правило ровно одно:
//
//     все обязательные стемы найдены  +  сообщение похоже на вопрос  ->  сработало
//
// Баллы (число совпавших необязательных слов) считаются только чтобы выбрать между
// двумя темами, если обе подошли. Порогов нет и быть не должно - непрозрачное число,
// которое модератор не может ни объяснить, ни починить.
//
// ГЛАВНОЕ ТРЕБОВАНИЕ К ЭТОМУ ФАЙЛУ - ОБЪЯСНИМОСТЬ. Каждый ответ несёт в себе, ЧТО
// совпало, ГДЕ (смещения в исходной строке, чтобы сайт подсветил) и ПОЧЕМУ (точно /
// по началу слова / внутри составного / опечатка / раскладка). Если бот промолчал -
// он говорит, какого слова не хватило. Настройка фичи идёт кликами по реальным
// сообщениям на странице контроля, а не подбором чисел, и без этих полей она невозможна.
//
// Модуль чистый: ни Mongo, ни сети, ни состояния. Его гоняет и живой бот на каждом
// сообщении, и скрипт прогона по истории, и (позже) TwitchBot-Web для предпросмотра
// правила при создании темы - репозитории не импортируют друг друга, поэтому туда файл
// уедет ручной копией, как shared/textStats.js. Зависимости специально только на два
// таких же чистых модуля: textStats.js и russianStemmer.js.

const { stem } = require('./russianStemmer.js');
const { STOPWORDS, isCommandMessage } = require('./textStats.js');

// Те же невидимые символы, что вычищает textStats.js (антидубль-набивка Twitch U+034F и
// компания). Здесь они НЕ вырезаются из строки, а пропускаются с сохранением карты
// смещений - иначе подсветка на сайте уехала бы относительно исходного текста.
const INVISIBLE_CHARS = /[­͏​-‏⁠-⁤﻿]/;

// Раскладка: человек начал печатать, не переключив язык. В чате это массовая опечатка,
// и «abkmnh» -> «фильтр» стоит одной таблицы.
const LAYOUT_QWERTY_TO_RU = {
  q: 'й', w: 'ц', e: 'у', r: 'к', t: 'е', y: 'н', u: 'г', i: 'ш', o: 'щ', p: 'з',
  a: 'ф', s: 'ы', d: 'в', f: 'а', g: 'п', h: 'р', j: 'о', k: 'л', l: 'д',
  z: 'я', x: 'ч', c: 'с', v: 'м', b: 'и', n: 'т', m: 'ь',
};

// Вопросительные слова и глаголы просьбы. Хранятся исходными формами, стеммируются один
// раз при загрузке: «какой/какая/какие/каким» дают один стем «как», а «подскажи» и
// «подскажите» - один «подскаж», так что список читается людьми, а сравнение идёт по стемам.
const QUESTION_WORDS = [
  'как', 'какой', 'какая', 'какое', 'какие', 'каким', 'каком', 'какую', 'какого',
  'что', 'чего', 'чем', 'чё', 'чо', 'шо', 'кто', 'кого', 'кому', 'кем',
  'где', 'куда', 'откуда', 'когда', 'почему', 'отчего', 'зачем', 'сколько',
  'который', 'которая', 'чей', 'чья', 'разве', 'неужели',
];

const ASKING_VERBS = [
  'подскажи', 'подскажите', 'подсказать', 'скажи', 'скажите',
  'посоветуй', 'посоветуйте', 'посоветовать', 'объясни', 'объясните',
  'напомни', 'напомните', 'помоги', 'помогите',
  'кинь', 'киньте', 'скинь', 'скиньте', 'дайте',
];

// Второе лицо. В выборке реальных вопросов («используешь», «у тебя», «порекомендуешь»,
// «ты используешь») оно встречается в 4 случаях из 10 - но САМО ПО СЕБЕ вопросом не
// является («ты крутой»), поэтому это только дополнительный сигнал в отчёте, а не
// основание сработать.
const SECOND_PERSON_WORDS = ['ты', 'тебя', 'тебе', 'твой', 'твоя', 'твои', 'твоего', 'твою'];
const SECOND_PERSON_ENDING = /(ешь|ишь|ёшь)$/;

const QUESTION_STEMS = new Set(QUESTION_WORDS.map(stem));
const ASKING_STEMS = new Set(ASKING_VERBS.map(stem));
const SECOND_PERSON_STEMS = new Set(SECOND_PERSON_WORDS.map(stem));

// Слова, которые никогда не станут ключевыми при автовыводе: они есть почти в любом
// вопросе и поэтому ничего не различают.
const NON_KEYWORD_STEMS = new Set([
  ...[...STOPWORDS].map(stem),
  ...QUESTION_STEMS,
  ...ASKING_STEMS,
  ...SECOND_PERSON_STEMS,
]);

// Общий префикс такой длины считается совпадением. Закрывает дыру самого Snowball:
// «использовать» -> «использова», «используешь» -> «используеш», общий префикс 7.
// Пять - потому что «ставка» -> «ставк» и «ставить» -> «став» дают общий префикс 4 и
// СКЛЕИВАТЬСЯ НЕ ДОЛЖНЫ; порог 4 их бы склеил.
const MIN_PREFIX_MATCH = 5;

// Ключ короче этого внутрь составного слова не ищется: «бан» нашёлся бы в «банан».
const MIN_SUBSTRING_KEY = 5;

// --- вопрос это или нет: доводы за и против ---------------------------------------------
//
// Знак вопроса ставят не всегда, поэтому одного признака мало и булевым правилом не
// обойтись. Считается небольшая целочисленная сумма: у каждого признака есть вес и
// человеческая подпись, все сработавшие признаки едут в ответе, и страница контроля
// показывает не вердикт, а арифметику - «знак вопроса +3, «какой» в начале +2, смайл в
// конце −3 → итого 2 при пороге 2». Это не тот скоринг, от которого я отказался в
// сопоставлении: там число было непрозрачным и несравнимым между сообщениями, здесь
// каждое слагаемое названо и объяснимо.
//
// Все веса и пороги выведены на живых логах #mistercop; примеры - в тестах.
const QUESTION_SCORE_THRESHOLD = 2;
const QUESTION_WORD_MAX_POSITION = 3;   // «что»/«где» дальше третьего слова - обычно союз
const QUESTION_SHORT_TOKENS = 10;       // до этой длины короткая фраза считается вопросом легче
const QUESTION_LONG_TOKENS = 14;        // длиннее и без «?» - это рассказ, а не вопрос

const QUESTION_WEIGHTS = {
  mark: 3,                  // «?»
  askingVerb: 3,            // подскажи / посоветуй / скинь
  questionWordEarly: 2,     // вопросительное слово в начале короткой фразы
  questionWordEarlyLong: 1, // оно же, но фраза длинная - довод слабее
  particleLi: 1,            // «есть ЛИ фильтр»
  secondPerson: 1,          // «у тебя», «используешь»
  jokeTail: -3,             // «))» - это шутка или комментарий, а не вопрос
  laugh: -2,                // хаха / лол / кек
  causal: -2,               // «т.к», «потому что» - объяснение
  imperative: -2,           // «сделай», «делитайте» - указание, а не вопрос
  assertion: -1,            // «же», «ведь», «вроде» - утверждение
  longStatement: -2,        // длинно и без «?»
  exclamation: -1,          // «!» в конце
};

// Повелительное наклонение множественного числа опознаётся по окончанию, единственного -
// списком: у «-и»/«-й» слишком много невиновных однофамильцев («они», «мои», «лучи»).
// Глаголы просьбы («подскажите») тоже повелительные, но они уже в ASKING_VERBS и сюда не
// попадают - проверка идёт после исключения этого списка.
//
// СЛИЧЕНИЕ ИДЁТ ПО ИСХОДНОЙ ФОРМЕ, А НЕ ПО СТЕМУ, и это не мелочь. Стеммер схлопывает
// «сделай», «сделать», «сделано» и «сделал» в один «сдела», так что проверка по стемам
// ловила бы любую форму глагола и подписывала «указание «сделано»» - направление верное,
// подпись враньё. Система, которая обязана объяснять свои решения, врать в подписи не
// может, поэтому здесь сверяются написания.
//
// «-йте»/«-ьте» почти всегда повелительные, «-ите» двусмысленно («в элите», «на свите»),
// поэтому у него порог длины выше.
const IMPERATIVE_PLURAL_ENDING = /(йте|ьте)$/;
const IMPERATIVE_PLURAL_ITE = /ите$/;
const IMPERATIVE_SINGULAR = new Set([
  'сделай', 'делай', 'поставь', 'включи', 'выключи', 'посмотри', 'глянь', 'попробуй',
  'качай', 'бери', 'возьми', 'смотри', 'жми', 'нажми', 'пиши', 'удали', 'добавь',
  'купи', 'играй', 'иди', 'давай', 'проверь', 'открой', 'закрой', 'выбери', 'забудь',
]);

const ASSERTION_WORDS = ['же', 'ведь', 'вроде', 'походу', 'кстати', 'имхо', 'короче', 'типа'];
const ASSERTION_STEMS = new Set(ASSERTION_WORDS.map(stem));

const LAUGH_PATTERN = /^(а?ха+х?[аох]*|лол|кек|кекв|ржу|лмао|xd+)$/;
const JOKE_TAIL_PATTERN = /\)\)/;
const CAUSAL_PATTERN = /(^|\s)(т\.?\s?к\.?|т\.?\s?е\.?|потому\s+что|так\s+как|поэтому|значит)(\s|$|,)/i;

// Минимальная длина слова-кандидата при автовыводе ключевых слов. «ссф» ровно на границе
// и проходит - это настоящий термин канала, а не шум.
const MIN_KEYWORD_LENGTH = 3;

const DEFAULT_MATCHING = {
  loosePrefix: true, // общий префикс >= MIN_PREFIX_MATCH
  substring: true,   // ключ внутри составного слова: «лутфильтр» ~ «фильтр»
  typos: true,       // Дамерау-Левенштейн
  layout: true,      // забытая раскладка
};

/** Порог опечаток от длины ключа: у коротких слов любая правка меняет смысл. */
function typoBudget(length) {
  if (length <= 4) return 0;
  if (length <= 7) return 1;
  return 2;
}

/** Дамерау-Левенштейн (OSA): правки + перестановка соседних букв. */
function editDistance(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;

  let prev2 = [];
  let prev = [];
  let cur = [];
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // дальше только хуже - выходим
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

/** «abkmnh» -> «фильтр». Возвращает null, если конвертировать нечего. */
function layoutToCyrillic(token) {
  if (!/^[a-z]+$/.test(token)) return null;
  let out = '';
  for (const ch of token) {
    const mapped = LAYOUT_QWERTY_TO_RU[ch];
    if (!mapped) return null;
    out += mapped;
  }
  return out;
}

/**
 * Разбор строки на токены с сохранением смещений В ИСХОДНОЙ строке.
 *
 * Невидимые символы выкидываются из текста, по которому идёт разбор, но карта смещений
 * ведёт обратно в оригинал - «фи<U+034F>льтр» останется одним словом, а подсветка на
 * сайте всё равно накроет ровно те символы, что видит человек.
 */
function tokenize(text) {
  const source = String(text || '');
  let cleaned = '';
  const offsets = []; // offsets[i] - позиция cleaned[i] в исходной строке

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (INVISIBLE_CHARS.test(ch)) continue;
    cleaned += ch;
    offsets.push(i);
  }

  const tokens = [];
  for (const m of cleaned.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = m[0];
    const startCleaned = m.index;
    const norm = raw.toLowerCase().replace(/ё/g, 'е');
    const variants = [stem(norm)];

    const layout = layoutToCyrillic(norm);
    if (layout) {
      const layoutStem = stem(layout);
      if (!variants.includes(layoutStem)) variants.push(layoutStem);
    }

    tokens.push({
      raw,
      norm,
      stem: variants[0],
      variants,
      isLayoutVariant: variants.length > 1,
      // «@mistercop» - это адресат, а не тема. Сопоставление такой токен по-прежнему видит
      // (мало ли ключ темы совпал с чьим-то ником), но в кандидаты на ключевое слово он не
      // идёт: иначе из живых примеров канала в «желательные» уезжает ник стримера.
      isMention: startCleaned > 0 && cleaned[startCleaned - 1] === '@',
      start: offsets[startCleaned],
      end: offsets[startCleaned + raw.length - 1] + 1,
    });
  }

  return tokens;
}

/**
 * Похоже ли сообщение на вопрос.
 *
 * Гейт нужен потому, что обязательное слово само по себе о намерении не говорит:
 * «спасибо за фильтр» и «фильтр огонь» содержат ключ темы, но отвечать на них нельзя.
 * Второе лицо в основание не входит - см. комментарий к SECOND_PERSON_WORDS.
 */
function detectQuestion(text, tokens) {
  const signals = [];
  const add = (weight, label) => { if (weight) signals.push({ label, weight }); };

  const hasMark = /[?？]/.test(text);
  if (hasMark) add(QUESTION_WEIGHTS.mark, 'знак вопроса');

  // --- доводы за ------------------------------------------------------------------------
  const asking = tokens.find((t) => t.variants.some((v) => ASKING_STEMS.has(v)));
  if (asking) add(QUESTION_WEIGHTS.askingVerb, `просьба «${asking.raw}»`);

  // Вопросительное слово дальше третьего места почти всегда союз, а не вопрос: на живых
  // логах именно так проскочили «СДелай в доп фильтрах ЧТО продавать можно» и «делитайте
  // папку ГДЕ хранится лут фильтр». Целевые вопросы не страдают - во всех десяти реальных
  // знак вопроса есть, а он весит больше.
  const questionIndex = tokens.findIndex((t) => t.variants.some((v) => QUESTION_STEMS.has(v)));
  if (questionIndex !== -1) {
    const word = tokens[questionIndex].raw;
    if (questionIndex >= QUESTION_WORD_MAX_POSITION) {
      signals.push({ label: `«${word}» похоже на союз, а не на вопрос`, weight: 0 });
    } else if (tokens.length <= QUESTION_SHORT_TOKENS) {
      add(QUESTION_WEIGHTS.questionWordEarly, `вопросительное слово «${word}» в начале`);
    } else {
      add(QUESTION_WEIGHTS.questionWordEarlyLong, `вопросительное слово «${word}», но фраза длинная`);
    }
  }

  if (tokens.some((t) => t.norm === 'ли')) add(QUESTION_WEIGHTS.particleLi, 'частица «ли»');

  const secondPerson = tokens.find(
    (t) => t.variants.some((v) => SECOND_PERSON_STEMS.has(v)) || SECOND_PERSON_ENDING.test(t.norm),
  );
  if (secondPerson) add(QUESTION_WEIGHTS.secondPerson, `обращение на «ты» («${secondPerson.raw}»)`);

  // --- доводы против --------------------------------------------------------------------
  if (JOKE_TAIL_PATTERN.test(text)) add(QUESTION_WEIGHTS.jokeTail, 'смайл «))» - это комментарий');

  const laugh = tokens.find((t) => LAUGH_PATTERN.test(t.norm));
  if (laugh) add(QUESTION_WEIGHTS.laugh, `смех «${laugh.raw}»`);

  const causal = text.match(CAUSAL_PATTERN);
  if (causal) add(QUESTION_WEIGHTS.causal, `объяснение «${causal[2].trim()}»`);

  const imperative = tokens.find((t) => {
    if (t.variants.some((v) => ASKING_STEMS.has(v))) return false; // «подскажите» - это просьба
    if (IMPERATIVE_SINGULAR.has(t.norm)) return true;
    if (t.norm.length >= 5 && IMPERATIVE_PLURAL_ENDING.test(t.norm)) return true;
    return t.norm.length >= 6 && IMPERATIVE_PLURAL_ITE.test(t.norm);
  });
  if (imperative) add(QUESTION_WEIGHTS.imperative, `указание «${imperative.raw}»`);

  const assertion = tokens.find((t) => t.variants.some((v) => ASSERTION_STEMS.has(v)));
  if (assertion) add(QUESTION_WEIGHTS.assertion, `утвердительное «${assertion.raw}»`);

  if (!hasMark && tokens.length > QUESTION_LONG_TOKENS) {
    add(QUESTION_WEIGHTS.longStatement, 'длинная фраза без знака вопроса');
  }
  if (!hasMark && /!\s*$/.test(text)) add(QUESTION_WEIGHTS.exclamation, 'восклицание');

  const score = signals.reduce((sum, s) => sum + s.weight, 0);

  return {
    isQuestion: score >= QUESTION_SCORE_THRESHOLD,
    score,
    threshold: QUESTION_SCORE_THRESHOLD,
    hasSecondPerson: Boolean(secondPerson),
    signals,
  };
}

/**
 * Полный разбор сообщения. Делается один раз и переиспользуется для всех тем канала -
 * на горячем пути бота темы перебираются по уже готовым токенам.
 */
function analyzeMessage(text) {
  const source = String(text || '');
  const tokens = tokenize(source);
  return {
    text: source,
    tokens,
    isCommand: isCommandMessage(source),
    question: detectQuestion(source, tokens),
  };
}

/** Длина общего префикса двух строк. */
function commonPrefixLength(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

/**
 * Найти в сообщении токен под ключевое слово.
 *
 * Способы проверяются в порядке убывания надёжности и первый сработавший выигрывает,
 * чтобы в отчёте оказалась самая сильная причина, а не случайная.
 */
function findToken(keyStem, tokens, matching) {
  const budget = matching.typos ? typoBudget(keyStem.length) : 0;

  const passes = [
    // 1. Точное совпадение стемов (сюда же попадает раскладка - она уже в variants).
    (t) => {
      const idx = t.variants.indexOf(keyStem);
      if (idx === -1) return null;
      return idx > 0 && matching.layout ? 'раскладка' : (idx === 0 ? 'точно' : null);
    },
    // 2. Общий префикс - лечит недостемминг Snowball, и ТОЛЬКО его.
    //
    // Обязательное условие - хвосты РАСХОДЯТСЯ («использова» / «используеш»): это подпись
    // одного и того же слова, которое стеммер дожал по-разному. Если же один стем целиком
    // является началом другого, это словообразование («фильтр» -> «фильтрован»), совсем
    // другое слово, и решаться оно должно правилом ниже, а не этим. Без этой проверки
    // прогон по логам #mistercop подставлял под тему про лут-фильтр «фильтрацию трафика»
    // и «не фильтрованного» (про пиво).
    (t) => {
      if (!matching.loosePrefix) return null;
      if (keyStem.length < MIN_PREFIX_MATCH) return null;
      return t.variants.some((v) => {
        if (v.length < MIN_PREFIX_MATCH) return false;
        const common = commonPrefixLength(v, keyStem);
        if (common < MIN_PREFIX_MATCH) return false;
        return common < v.length && common < keyStem.length;
      }) ? 'по началу слова' : null;
    },
    // 3. Ключ как ХВОСТ составного слова: «лутфильтр» - это фильтр, «фильтрация» - нет.
    //
    // В русских составных главное слово идёт последним, поэтому ключ засчитывается только
    // если он завершает токен. Проверено на живых логах: так проходит «лутфильтр»,
    // «лутфильтре», «лутфильтром» и отсекается «фильтрблейд», «фильтрация», «фильтрованный».
    (t) => {
      if (!matching.substring) return null;
      if (keyStem.length < MIN_SUBSTRING_KEY) return null;
      return t.variants.some((v) => v.length > keyStem.length && v.endsWith(keyStem))
        ? 'внутри слова' : null;
    },
    // 4. Опечатка.
    (t) => {
      if (budget === 0) return null;
      return t.variants.some((v) => editDistance(v, keyStem, budget) <= budget)
        ? 'опечатка' : null;
    },
  ];

  for (const check of passes) {
    for (const token of tokens) {
      const how = check(token);
      if (how) return { token, how };
    }
  }
  return null;
}

/** Нормализация темы: значения по умолчанию в одном месте. */
function normalizeTopic(topic) {
  return {
    id: topic.id || topic._id || null,
    title: topic.title || '',
    requiredStems: (topic.requiredStems || []).map((s) => stem(String(s))).filter(Boolean),
    optionalStems: (topic.optionalStems || []).map((s) => stem(String(s))).filter(Boolean),
    excludeStems: (topic.excludeStems || []).map((s) => stem(String(s))).filter(Boolean),
    // Второй ярус доводов «против»: встроенные веса можно перевесить, но иногда модератор
    // просто ЗНАЕТ, что с этим словом в его чате вопросов не задают. Такое слово - запрет,
    // а не вес: оно снимает вопросительную форму независимо от суммы.
    notQuestionStems: (topic.notQuestionStems || []).map((s) => stem(String(s))).filter(Boolean),
    requireQuestion: topic.requireQuestion !== false,
    matching: { ...DEFAULT_MATCHING, ...(topic.matching || {}) },
  };
}

/**
 * Перевести документ темы из Mongo в форму, которую понимает matchTopic().
 *
 * В базе лежат ЧЕЛОВЕЧЕСКИЕ слова («фильтр», «использовать») - ровно те, что модератор видит
 * на чипах и правит руками. Стеммирует их normalizeTopic() при каждом сопоставлении, поэтому
 * хранить обрезки стеммера не нужно и вредно: «использова» на чипе выглядит как опечатка, а
 * при смене версии стеммера сохранённый обрезок протухнет, тогда как слово - нет.
 *
 * Живёт здесь, а не в каждом репозитории отдельно, потому что форма документа общая: сайт её
 * пишет, бот читает, и разъехавшийся переходник означал бы, что бот исполняет не то правило,
 * которое настроили на сайте.
 */
function toMatcherTopic(doc) {
  if (!doc) return null;
  return {
    id: doc._id ? String(doc._id) : (doc.id || null),
    title: doc.title || '',
    requiredStems: doc.requiredWords || [],
    optionalStems: doc.optionalWords || [],
    excludeStems: doc.excludeWords || [],
    notQuestionStems: doc.notQuestionWords || [],
    requireQuestion: doc.requireQuestion !== false,
    matching: doc.matching || undefined,
  };
}

/**
 * Сопоставить разобранное сообщение с одной темой.
 *
 * Всегда возвращает объяснение - и когда совпало, и когда нет. `reason` для несовпадения
 * это то, что страница контроля показывает модератору, когда он спрашивает «почему бот
 * промолчал на вот это».
 */
function matchTopic(analysis, rawTopic) {
  const topic = normalizeTopic(rawTopic);
  const { tokens } = analysis;

  const base = {
    topicId: topic.id,
    matched: false,
    matchedRequired: [],
    matchedOptional: [],
    missingRequired: [],
    blockedBy: null,
    spans: [],
    score: 0,
  };

  if (analysis.isCommand) {
    return { ...base, reason: 'сообщение - вызов команды' };
  }
  if (!topic.requiredStems.length) {
    return { ...base, reason: 'у темы нет обязательных слов' };
  }
  if (topic.requireQuestion) {
    // Личный запрет модератора идёт первым: он сильнее любой суммы весов.
    for (const veto of topic.notQuestionStems) {
      const hit = findToken(veto, tokens, topic.matching);
      if (hit) {
        return { ...base, reason: `слово «${hit.token.raw}» помечено как «это не вопрос»` };
      }
    }
    if (!analysis.question.isQuestion) {
      const against = analysis.question.signals.filter((s) => s.weight < 0).map((s) => s.label);
      return {
        ...base,
        reason: 'не похоже на вопрос' +
          ` (${analysis.question.score} из ${analysis.question.threshold}` +
          `${against.length ? '; против: ' + against.join(', ') : ''})`,
      };
    }
  }

  // Стоп-слова темы проверяются ДО обязательных: если модератор нажал «не то» и слово
  // попало в исключения, тема обязана молчать независимо от всего остального.
  for (const ex of topic.excludeStems) {
    const hit = findToken(ex, tokens, topic.matching);
    if (hit) {
      return {
        ...base,
        reason: `исключающее слово «${hit.token.raw}»`,
        blockedBy: { stem: ex, token: hit.token.raw, how: hit.how },
      };
    }
  }

  const spans = [];
  const matchedRequired = [];
  const missingRequired = [];

  for (const key of topic.requiredStems) {
    const hit = findToken(key, tokens, topic.matching);
    if (!hit) {
      missingRequired.push(key);
      continue;
    }
    matchedRequired.push({ stem: key, token: hit.token.raw, how: hit.how });
    spans.push({ start: hit.token.start, end: hit.token.end, stem: key, how: hit.how, required: true });
  }

  if (missingRequired.length) {
    return {
      ...base,
      matchedRequired,
      missingRequired,
      reason: `нет обязательного слова: ${missingRequired.join(', ')}`,
    };
  }

  const matchedOptional = [];
  for (const key of topic.optionalStems) {
    const hit = findToken(key, tokens, topic.matching);
    if (!hit) continue;
    matchedOptional.push({ stem: key, token: hit.token.raw, how: hit.how });
    spans.push({ start: hit.token.start, end: hit.token.end, stem: key, how: hit.how, required: false });
  }

  spans.sort((a, b) => a.start - b.start);

  return {
    topicId: topic.id,
    matched: true,
    matchedRequired,
    matchedOptional,
    missingRequired: [],
    blockedBy: null,
    spans,
    score: matchedOptional.length,
    reason: null,
  };
}

/**
 * Выбрать тему из нескольких подошедших.
 *
 * Специфичность важнее баллов: тема с двумя обязательными словами описывает более узкий
 * случай, чем тема с одним, и должна выигрывать, даже если у второй совпало больше
 * необязательных. При полном равенстве побеждает та, что раньше в списке - порядок должен
 * быть устойчивым, иначе бот отвечает по-разному на одно и то же сообщение.
 */
function selectTopic(analysis, topics) {
  let best = null;
  for (let i = 0; i < topics.length; i += 1) {
    const match = matchTopic(analysis, topics[i]);
    if (!match.matched) continue;
    const candidate = { topic: topics[i], match, index: i };
    if (
      !best ||
      match.matchedRequired.length > best.match.matchedRequired.length ||
      (match.matchedRequired.length === best.match.matchedRequired.length &&
        match.score > best.match.score)
    ) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Свести к одному ключу словоформы, которые стеммер не смог схлопнуть сам.
 *
 * Snowball оставляет «использовать» -> «использова», а «используешь» -> «используеш»:
 * формально это разные стемы, для человека - одно слово. При сопоставлении их мирит
 * правило общего префикса, но при ВЫВОДЕ ключевых слов они бы дали два чипа вместо
 * одного - а если бы такое слово оказалось общим для всех примеров, пересечение вышло бы
 * пустым, и правило молча получилось бы неправильным. Поэтому группировка идёт до
 * подсчёта пересечения и по тому же порогу, что и сопоставление.
 *
 * Каноном становится самый короткий стем группы: он сильнее обрезан, а значит при
 * сопоставлении по префиксу поймает и всех остальных членов группы.
 *
 * ДВА СПОСОБА СКЛЕЙКИ, И ВТОРОЙ ЗДЕСЬ РОВНО ПОТОМУ, ЧТО ОН ЕСТЬ В СОПОСТАВЛЕНИИ.
 * Первый - общий префикс (недостемминг Snowball). Второй - составное слово: «лутфильтр» это
 * «фильтр», и findToken() это знает («ключ как хвост слова»). Пока вывод ключевых слов этого
 * не знал, две половины фичи противоречили друг другу на живых данных: из пяти настоящих
 * примеров канала четыре говорили «лутфильтр», один - «фильтр», пересечение выходило ПУСТЫМ, и
 * страница честно отвечала «у примеров нет ни одного общего слова» - хотя тема у них общая, и
 * бот, получив ключ «фильтр» вручную, поймал бы все пять.
 *
 * Канон - КОРОТКИЙ стем: при сопоставлении ключ «фильтр» находит токен «лутфильтр», а обратно
 * не работает - ключ «лутфильтр» не найдёт «фильтр». Так что из пары всегда выбирается тот,
 * который ловит обоих.
 */
function groupStems(stems) {
  const canonical = new Map();
  const ordered = [...stems].sort((a, b) => a.length - b.length || a.localeCompare(b));

  for (const s of ordered) {
    let target = null;
    for (const existing of new Set(canonical.values())) {
      const undersstemmed =
        s.length >= MIN_PREFIX_MATCH &&
        existing.length >= MIN_PREFIX_MATCH &&
        commonPrefixLength(existing, s) >= MIN_PREFIX_MATCH;
      // Порог длины сам защищает короткие слова: «бан» (3) никогда не станет каноном для
      // чего-то, что на него заканчивается.
      const compound = existing.length >= MIN_SUBSTRING_KEY && s.endsWith(existing);
      if (undersstemmed || compound) { target = existing; break; }
    }
    canonical.set(s, target || s);
  }
  return canonical;
}

/**
 * Вывести ключевые слова из примеров вопроса.
 *
 * Обязательные - пересечение по всем примерам. На реальных четырёх формулировках про
 * фильтр пересечение равно ровно {фильтр}, и это заслуга самого короткого примера
 * («у тебя какой фильтр?»): он и задаёт, насколько узким выйдет правило. Отсюда подсказка
 * в интерфейсе - добавлять в примеры самый короткий реальный вариант из логов.
 *
 * Необязательные - всё остальное, отсортированное по числу примеров, где слово встретилось,
 * а при равенстве по редкости слова В ЭТОМ КАНАЛЕ: `wordFrequency` это карта
 * «стем -> сколько раз слово встречалось в чате», которую даёт коллекция ChatWordStats.
 * Редкое слово различает лучше частого, а что редко в одном канале - обычно в другом.
 *
 * @param {string[]} examples
 * @param {{wordFrequency?: Map<string, number>}} [opts]
 */
function deriveKeywords(examples, opts = {}) {
  const wordFrequency = opts.wordFrequency || new Map();
  const isEmote = opts.isEmote || (() => false);
  const texts = (examples || []).map((e) => String(e || '').trim()).filter(Boolean);

  if (!texts.length) {
    return { required: [], optional: [], warning: 'нет ни одного примера' };
  }

  // Проход 1: сырые стемы каждого примера плюс то, как слово было написано - подпись
  // чипа должна быть человеческой («фильтр»), а не обрезком стеммера.
  const rawPerExample = [];
  const rawSurfaces = new Map(); // сырой стем -> Map(написание -> сколько раз)

  for (const text of texts) {
    const { tokens } = analyzeMessage(text);
    const stems = new Set();
    for (const token of tokens) {
      const s = token.stem;
      if (!s || s.length < MIN_KEYWORD_LENGTH) continue;
      if (token.isMention) continue;          // «@mistercop» - адресат, а не тема
      if (isEmote(token.norm)) continue;      // эмоут - не слово темы
      if (!/\p{L}/u.test(s)) continue;       // «2026» ключевым словом не станет
      if (NON_KEYWORD_STEMS.has(s)) continue; // вопросительные слова и стоп-слова
      stems.add(s);
      if (!rawSurfaces.has(s)) rawSurfaces.set(s, new Map());
      const counts = rawSurfaces.get(s);
      counts.set(token.norm, (counts.get(token.norm) || 0) + 1);
    }
    rawPerExample.push(stems);
  }

  // Проход 2: схлопнуть словоформы и пересчитать всё уже на канонических ключах.
  const canonical = groupStems(rawSurfaces.keys());
  const perExample = rawPerExample.map(
    (stems) => new Set([...stems].map((s) => canonical.get(s))),
  );

  const surfaces = new Map();
  const channelCounts = new Map();
  for (const [raw, counts] of rawSurfaces) {
    const key = canonical.get(raw);
    if (!surfaces.has(key)) surfaces.set(key, new Map());
    const target = surfaces.get(key);
    for (const [word, n] of counts) target.set(word, (target.get(word) || 0) + n);

    const seen = wordFrequency.get(raw);
    if (seen != null) channelCounts.set(key, (channelCounts.get(key) || 0) + seen);
  }

  const docFreq = new Map();
  for (const stems of perExample) {
    for (const s of stems) docFreq.set(s, (docFreq.get(s) || 0) + 1);
  }

  /**
   * Как назвать ключ на чипе.
   *
   * ПОДПИСЬ ОБЯЗАНА СТЕММИРОВАТЬСЯ ОБРАТНО В КАНОН, и это не косметика: на чипе лежит
   * человеческое слово, и именно оно сохраняется в базу как ключ. Если просто взять самое
   * частое написание в группе, то из живых примеров канала (четыре «лутфильтр» против одного
   * «фильтр») ключом станет «лутфильтр» - а он, в отличие от «фильтр», не находит «фильтр».
   * Правило перестало бы ловить собственный пример, причём молча.
   */
  const label = (s) => {
    const counts = surfaces.get(s) || new Map();
    let bestWord = null;
    let bestCount = -1;
    let fallbackWord = s;
    let fallbackCount = -1;
    for (const [word, count] of counts) {
      if (count > fallbackCount) { fallbackWord = word; fallbackCount = count; }
      if (stem(word) !== s) continue;
      if (count > bestCount) { bestWord = word; bestCount = count; }
    }
    return bestWord || fallbackWord;
  };

  const entry = (s) => ({
    stem: s,
    label: label(s),
    inExamples: docFreq.get(s) || 0,
    channelCount: channelCounts.has(s) ? channelCounts.get(s) : null,
  });

  const required = [];
  const optional = [];
  for (const [s, count] of docFreq) {
    (count === texts.length ? required : optional).push(entry(s));
  }

  // Обязательные - по редкости: если пересечение вышло шире одного слова, самое редкое
  // слово почти всегда и есть тема, а частое - фон.
  const rarityFirst = (a, b) => {
    const ca = a.channelCount ?? Number.POSITIVE_INFINITY;
    const cb = b.channelCount ?? Number.POSITIVE_INFINITY;
    if (ca !== cb) return ca - cb;
    return b.label.length - a.label.length;
  };
  required.sort(rarityFirst);
  optional.sort((a, b) => (b.inExamples - a.inExamples) || rarityFirst(a, b));

  let warning = null;
  if (!required.length) {
    warning = 'у примеров нет ни одного общего слова - задайте ключевые слова вручную';
  } else if (required.length > 2) {
    warning = 'общих слов много: правило получится узким, добавьте более короткий пример';
  }
  if (texts.length === 1) {
    warning = warning || 'по одному примеру ключевые слова не вывести надёжно - добавьте ещё';
  }

  return { required, optional, warning };
}

/**
 * Вывести ИСКЛЮЧАЮЩИЕ слова из помеченных ложных срабатываний. Зеркало deriveKeywords().
 *
 * Кандидат - слово, которое есть в помеченных сообщениях и которого нет НИ В ОДНОМ настоящем
 * примере: если слово встречается и там и там, исключение по нему убьёт правило вместе с
 * мусором. Уже заданные ключевые слова темы исключаются из кандидатов по той же причине.
 *
 * Отбор - ЖАДНОЕ ПОКРЫТИЕ, а не «топ-N по частоте». Разница принципиальная: частотный список
 * выдаёт пять синонимов одной и той же мысли и не трогает остальные пять сообщений, тогда как
 * покрытие на каждом шаге берёт слово, закрывающее больше всего ещё не закрытых. На живых
 * данных #mistercop ложные срабатывания оказались почти сплошь про ИЗМЕНЕНИЕ фильтра
 * («а ты фильтр обновлял?», «тебе поменять фильтр?», «хочу заменить звук»), и покрытие
 * находит эти глаголы, а не случайные «привет» и «господа».
 *
 * При равном покрытии берётся слово, которое РЕЖЕ встречается в чате канала: у частого слова
 * больше побочного урона по настоящим вопросам, которых в размеченной выборке ещё нет.
 *
 * Каждое слово возвращается вместе с числом закрытых им сообщений, а те, что закрыть не
 * удалось, возвращаются отдельно - для них исключающего слова просто нет, и модератор должен
 * увидеть это, а не думать, что список полон.
 *
 * @param {string[]} examples - настоящие примеры вопроса (их правило ловить обязано)
 * @param {string[]} antiExamples - помеченные ложные срабатывания
 * @param {{wordFrequency?: Map<string, number>, keywords?: string[], limit?: number}} [opts]
 */
function deriveExclusions(examples, antiExamples, opts = {}) {
  const wordFrequency = opts.wordFrequency || new Map();
  const isEmote = opts.isEmote || (() => false);
  const limit = opts.limit || 8;

  const positives = (examples || []).map((t) => String(t || '').trim()).filter(Boolean);
  const negatives = (antiExamples || []).map((t) => String(t || '').trim()).filter(Boolean);
  if (!negatives.length) return { exclusions: [], uncovered: [], warning: 'нет помеченных сообщений' };

  // Канон строится по ОБОИМ наборам сразу, иначе «лутфильтр» из помеченных и «фильтр» из
  // примеров окажутся разными словами и защита «не трогать слова примеров» не сработает.
  const rawSurfaces = new Map();
  const collect = (text) => {
    const stems = new Map();
    for (const token of analyzeMessage(text).tokens) {
      const s = token.stem;
      if (!s || s.length < MIN_KEYWORD_LENGTH) continue;
      if (token.isMention) continue;
      // Эмоуты в исключающие слова не годятся: «eeeh» или «Susge» заблокировали бы тему на
      // любом сообщении с этим эмоутом независимо от смысла. На живой выборке они вдобавок
      // съедали половину мест в списке, оставляя настоящие сообщения незакрытыми.
      if (isEmote(token.norm)) continue;
      if (!/\p{L}/u.test(s)) continue;
      if (NON_KEYWORD_STEMS.has(s)) continue;
      stems.set(s, token.norm);
      if (!rawSurfaces.has(s)) rawSurfaces.set(s, new Map());
      const counts = rawSurfaces.get(s);
      counts.set(token.norm, (counts.get(token.norm) || 0) + 1);
    }
    return stems;
  };

  const positiveRaw = positives.map(collect);
  const negativeRaw = negatives.map(collect);
  const canonical = groupStems(rawSurfaces.keys());
  const canon = (s) => canonical.get(s) || s;

  const banned = new Set();
  for (const stems of positiveRaw) for (const s of stems.keys()) banned.add(canon(s));
  for (const word of opts.keywords || []) banned.add(canon(stem(String(word))));

  const negativeSets = negativeRaw.map((stems) => {
    const out = new Set();
    for (const s of stems.keys()) {
      const key = canon(s);
      if (!banned.has(key)) out.add(key);
    }
    return out;
  });

  const label = (s) => {
    let best = null;
    let bestCount = -1;
    for (const [raw, target] of canonical) {
      if (target !== s) continue;
      for (const [word, count] of rawSurfaces.get(raw) || []) {
        if (stem(word) !== s) continue;
        if (count > bestCount) { best = word; bestCount = count; }
      }
    }
    return best || s;
  };

  const rarity = (s) => wordFrequency.get(s) ?? Number.POSITIVE_INFINITY;

  const exclusions = [];
  const uncoveredIdx = new Set(negativeSets.map((_, i) => i));

  while (exclusions.length < limit && uncoveredIdx.size) {
    const coverage = new Map();
    for (const i of uncoveredIdx) {
      for (const s of negativeSets[i]) coverage.set(s, (coverage.get(s) || 0) + 1);
    }
    if (!coverage.size) break;

    let pick = null;
    for (const [s, count] of coverage) {
      if (
        !pick ||
        count > pick.count ||
        (count === pick.count && rarity(s) < rarity(pick.stem)) ||
        (count === pick.count && rarity(s) === rarity(pick.stem) && s < pick.stem)
      ) {
        pick = { stem: s, count };
      }
    }

    exclusions.push({
      stem: pick.stem,
      label: label(pick.stem),
      covers: pick.count,
      channelCount: wordFrequency.has(pick.stem) ? wordFrequency.get(pick.stem) : null,
    });
    for (const i of [...uncoveredIdx]) {
      if (negativeSets[i].has(pick.stem)) uncoveredIdx.delete(i);
    }
  }

  const uncovered = [...uncoveredIdx].map((i) => ({
    text: negatives[i],
    // Пустое множество означает, что в сообщении вообще нет слов, которых не было бы в
    // примерах - исключающего слова для него не существует, правило придётся сужать иначе.
    reason: negativeSets[i].size ? 'не хватило места в списке' : 'все его слова есть в примерах',
  }));

  return {
    exclusions,
    uncovered,
    warning: uncovered.length
      ? `${uncovered.length} из ${negatives.length} закрыть не удалось`
      : null,
  };
}

/**
 * Проверить правило по примерам и антипримерам.
 *
 * Это то, что стоит за кнопкой «не то» на странице контроля: модератор помечает ложное
 * срабатывание, оно уходит в антипримеры, и правило ОБЯЗАНО на нём молчать. Если всё ещё
 * срабатывает - здесь возвращается конфликт и подсказка, каким словом его закрыть:
 * берутся слова, которые есть в антипримере и которых нет ни в одном настоящем примере.
 */
function checkRule({ topic, examples = [], antiExamples = [] }) {
  const missed = [];
  const positiveStems = new Set();

  for (const text of examples) {
    const analysis = analyzeMessage(text);
    for (const t of analysis.tokens) positiveStems.add(t.stem);
    const match = matchTopic(analysis, topic);
    if (!match.matched) missed.push({ text, reason: match.reason });
  }

  const conflicts = [];
  for (const text of antiExamples) {
    const analysis = analyzeMessage(text);
    const match = matchTopic(analysis, topic);
    if (!match.matched) continue;

    const suggestedExclude = analysis.tokens
      .filter((t) => t.stem.length >= MIN_KEYWORD_LENGTH)
      .filter((t) => !NON_KEYWORD_STEMS.has(t.stem))
      .filter((t) => !positiveStems.has(t.stem))
      .filter((t) => !match.spans.some((s) => s.start === t.start))
      .map((t) => ({ stem: t.stem, label: t.norm }));

    conflicts.push({ text, match, suggestedExclude });
  }

  return {
    ok: missed.length === 0 && conflicts.length === 0,
    missed,      // примеры, которые правило НЕ ловит - слишком узко
    conflicts,   // антипримеры, которые правило ловит - слишком широко
  };
}

module.exports = {
  analyzeMessage,
  matchTopic,
  selectTopic,
  toMatcherTopic,
  deriveKeywords,
  deriveExclusions,
  checkRule,
  normalizeTopic,
  // экспортируется для тестов и для предпросмотра на сайте
  tokenize,
  detectQuestion,
  layoutToCyrillic,
  editDistance,
  typoBudget,
  DEFAULT_MATCHING,
  QUESTION_WEIGHTS,
  QUESTION_SCORE_THRESHOLD,
  QUESTION_STEMS,
  ASKING_STEMS,
  NON_KEYWORD_STEMS,
  MIN_PREFIX_MATCH,
  MIN_SUBSTRING_KEY,
};
