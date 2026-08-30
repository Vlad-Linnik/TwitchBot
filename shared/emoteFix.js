// Правка смайликов в готовом ответе модели: регистр и пробелы вокруг.
//
// ЧТО ВООБЩЕ РИСУЕТСЯ КАРТИНКОЙ. И Twitch, и 7TV разбирают сообщение по пробелам и сравнивают
// каждый токен с набором канала ЦЕЛИКОМ и С УЧЁТОМ РЕГИСТРА. Поэтому «KEKW,» - это слово с
// запятой, «kekw» - просто слово, а «Привет))» - одно слово из шести букв и двух скобок; ни в
// одном из трёх случаев картинки не будет. Список смайликов канала модель не видит и пишет их
// по памяти о твиче вообще, так что все три ошибки на выходе встречаются.
//
// ОТКУДА ПРАВИЛЬНОЕ НАПИСАНИЕ. Из whiteList (db/chatStats.js), то есть из набора, который канал
// отслеживает СЕЙЧАС, а не из союза трёх наборов, которым отвечают на вопрос «это вообще
// смайлик?»: WordLifetimeStats и EmoteExclusions помнят и то, что каналом больше не
// отслеживается. Для статистики это правильно, но вернуть в чат можно только то, что
// нарисуется сегодня. Набор уже лежит в памяти процесса, запроса в базу здесь нет.
//
// ГДЕ ИСКАТЬ СМАЙЛИК ВНУТРИ ТОКЕНА. Только на границах: там, где меняется род знаков («так»
// упирается в «<3»), и там, где стоит прилипший знак препинания («POGGERS,», «Спасибо,))»).
// Середина слова границей не считается, поэтому «POGGERSXYZ» так и останется словом. Обе
// породы границ обязательны, и ни одной не хватает поодиночке: у «:3», «o.O» и «<3» знак
// препинания стоит ВНУТРИ смайлика, так что разбор по одной смене рода знаков развалил бы их.
//
// ЧЕГО МОДУЛЬ НЕ ДЕЛАЕТ. Не добавляет смайликов, которых в ответе не было, и не трогает токен,
// в котором смайлик не опознан целиком. Любая неуверенность разрешается в пользу «оставить как
// есть»: неопознанный смайлик уйдёт в чат текстом, то есть ровно так же, как ушёл бы и без
// этого модуля, а разрезанный по ошибке текст читается как поломка.
//
// ЦЕНА ПРАВКИ РЕГИСТРА. В наборах каналов лежат обычные слова («бро», «mods», «heart», «Run»),
// поэтому «run» в английской фразе станет смайликом Run. Это не побочный эффект правки: слово,
// совпавшее со смайликом канала, и так рисуется картинкой у всех, кто его пишет, - правка лишь
// распространяет то же поведение на другой регистр.

// Знаки, которые прилипают к смайлику и ничего рядом с картинкой не значат. Скобок здесь нет
// намеренно: «))», «(((» и «)))» сами бывают смайликами, и обрезка съела бы их целиком.
const TRIM_CHARS = /[.,!?;:…]/;
const LEADING_TRIM = /^[.,!?;:…]+/;
const ONLY_TRIM = /^[.,!?;:…]+$/;

// Смайликов длиннее не бывает (самое длинное в наборах - около двадцати знаков), а поиск внутри
// токена перебирает концы: потолок держит его дешёвым на любой строке.
const MAX_EMOTE_LEN = 40;
// Длиннее этого слово уже не разбирается на слипшиеся смайлики - там их и не бывает.
const MAX_GLUED_WORD = 60;
// Разрезать слипшиеся смайлики можно только на кусках такой длины и больше. Двухбуквенные
// смайлики в наборах есть («oh», «:3»), но искать их внутри слов - верный способ разорвать
// надвое обычное слово.
const MIN_GLUED_PART = 3;
const MAX_GLUED_PARTS = 6;

// Латиница с цифрами, любые другие буквы (в наборах есть «бро»), всё остальное. Порядок веток
// важен: \p{L} покрывает и латиницу тоже, поэтому вторая ветка явно исключает то, что забрала
// первая - иначе «Приветbro» осталось бы одним куском.
const PIECES = /[A-Za-z0-9_]+|(?:(?![A-Za-z0-9_])[\p{L}\p{N}])+|[^\s\p{L}\p{N}]+/gu;

// Места внутри токена, где смайлик вправе начаться и кончиться.
function boundaries(token) {
  const starts = new Set([0]);
  const ends = new Set([token.length]);
  let at = 0;
  for (const chunk of token.match(PIECES) || []) {
    starts.add(at);
    ends.add(at);
    at += chunk.length;
  }
  starts.add(at);
  ends.add(at);
  for (let i = 0; i < token.length; i++) {
    if (!TRIM_CHARS.test(token[i])) continue;
    ends.add(i);
    starts.add(i + 1);
  }
  return { starts, ends };
}

// Смайлики внутри токена, слева направо; на каждом месте берётся самый длинный. Длинный вперёд
// коротких - иначе «o.O» распадётся на «o» плюс мусор, а «))))» на две пары скобок.
function scanEmotes(token, canonical) {
  const { starts, ends } = boundaries(token);
  const found = [];
  let at = 0;
  while (at < token.length) {
    if (!starts.has(at)) {
      at++;
      continue;
    }
    let hit = null;
    for (let end = Math.min(token.length, at + MAX_EMOTE_LEN); end > at; end--) {
      if (!ends.has(end)) continue;
      const emote = canonical(token.slice(at, end));
      if (emote) {
        hit = { start: at, end, emote };
        break;
      }
    }
    if (!hit) {
      at++;
      continue;
    }
    found.push(hit);
    at = hit.end;
  }
  return found;
}

// Слово целиком разбирается на два и более смайликов - «KappaKEKW». Границ внутри такого слова
// нет вовсе, поэтому оно достаётся отдельному разбору, и разбор принимается, только когда
// смайлики покрывают слово ПОЛНОСТЬЮ: остаток текста означал бы, что совпадение случайное.
//
// РЕГИСТР ЗДЕСЬ СВЕРЯЕТСЯ ТОЧНО, в отличие от всего остального в этом файле. Две починки сразу -
// и разрезать, и поправить регистр - на одном и том же слове дают ложные срабатывания: на живой
// выборке чата «BopBop» (смайлик чужого набора, у канала его нет) разваливался на «BOP BOP» по
// глобальному «BOP». Слово, написанное не тем регистром, останется словом; слипшиеся
// смайлики, написанные верно, разъедутся.
function splitGlued(word, canonical) {
  if (word.length < MIN_GLUED_PART * 2 || word.length > MAX_GLUED_WORD) return null;
  const best = new Array(word.length + 1).fill(null);
  best[0] = [];
  for (let i = MIN_GLUED_PART; i <= word.length; i++) {
    for (let j = 0; j <= i - MIN_GLUED_PART; j++) {
      if (!best[j] || i - j > MAX_EMOTE_LEN) continue;
      const part = word.slice(j, i);
      const emote = canonical(part);
      if (emote === part) {
        best[i] = best[j].concat(emote);
        break;
      }
    }
  }
  const parts = best[word.length];
  return parts && parts.length >= 2 && parts.length <= MAX_GLUED_PARTS ? parts : null;
}

// Один токен -> один или несколько токенов, разделённых пробелом.
function fixToken(token, canonical) {
  const direct = canonical(token);
  if (direct) return [direct];

  const found = scanEmotes(token, canonical);
  if (!found.length) return splitGlued(token, canonical) || [token];

  const out = [];
  let cursor = 0;
  for (const hit of found) {
    let before = token.slice(cursor, hit.start);
    // Знак, прилипший к смайлику справа, уходит вместе с ним: «KEKW,привет» -> «KEKW привет».
    if (cursor > 0) before = before.replace(LEADING_TRIM, '');
    // Знак, прилипший слева, остаётся при тексте: «привет!KEKW» -> «привет! KEKW». Но если слева
    // одна пунктуация без единой буквы, она исчезает - приткнуть её некуда, а отдельным токеном
    // она читается как опечатка.
    if (before && !ONLY_TRIM.test(before)) out.push(before);
    out.push(hit.emote);
    cursor = hit.end;
  }
  const tail = token.slice(cursor).replace(LEADING_TRIM, '');
  if (tail) out.push(tail);
  return out;
}

// text -> тот же текст, но каждый опознанный смайлик написан как в наборе канала и стоит
// отдельным токеном. `canonical(word)` возвращает правильное написание смайлика или null.
//
// Пробелы схлопываются - ответ модели и так проходит через ту же нормализацию в sanitizeReply.
function fixEmotes(text, canonical) {
  const source = String(text ?? '');
  if (!source || typeof canonical !== 'function') return source;
  const lookup = (word) => {
    const found = canonical(word);
    return typeof found === 'string' && found ? found : null;
  };
  const out = [];
  for (const token of source.split(/\s+/)) {
    if (token) out.push(...fixToken(token, lookup));
  }
  return out.join(' ');
}

module.exports = { fixEmotes, MIN_GLUED_PART, MAX_EMOTE_LEN };
