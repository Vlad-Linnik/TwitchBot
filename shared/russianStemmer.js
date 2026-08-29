// Snowball ("Porter2") stemmer for Russian, ported by hand - no dependency.
//
// Why a stemmer at all: the auto-answer feature matches a moderator-authored keyword
// against whatever a viewer actually typed, and Russian is inflected. Real examples from
// #mistercop's own logs, all of which must collapse onto one key:
//
//   "какой фильтр"  "какой фильтрА"  "какие фильтрЫ"  "фильтрОМ"  "фильтрОВ"  ->  фильтр
//   "юзаТЬ"         "юзаЕШЬ"         "юзаЮ"                                   ->  юза
//
// Without this, a rule authored as "фильтр" silently misses half the questions it exists
// for, and the moderator has no way to tell why.
//
// Why hand-ported rather than `npm i natural` / `snowball`: this repo's dependency list is
// four packages (axios, dotenv, mongodb, tmi.js), the algorithm is a fixed published spec
// that has not changed in twenty years, and the port is a pure function that can be unit
// tested offline. Pulling a stemming library in would also make the copy of this file that
// TwitchBot-Web eventually needs (same hand-copy convention as shared/textStats.js, since
// the repos may not import each other) drag a dependency across with it.
//
// Reference: https://snowballstem.org/algorithms/russian/stemmer.html
//
// FIDELITY NOTE, and it is load-bearing: Snowball's `among` picks the LONGEST matching
// ending and then runs that ending's condition. If the condition fails, the whole group
// fails - it does NOT fall back to a shorter ending in the same group. tryAmong() below
// reproduces that exactly. Getting this wrong makes the stemmer quietly over-stem, which
// shows up as an auto-answer rule matching things it shouldn't, a long way from here.

const VOWELS = new Set(['а', 'е', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я']);

// Endings are grouped exactly as the spec groups them. `aya: true` means the spec's
// "preceded by а or я" precondition applies to that ending.
const PERFECTIVE_GERUND = [
  { s: 'вшись', aya: true }, { s: 'вши', aya: true }, { s: 'в', aya: true },
  { s: 'ившись' }, { s: 'ывшись' }, { s: 'ивши' }, { s: 'ывши' }, { s: 'ив' }, { s: 'ыв' },
];

const ADJECTIVE = [
  'ими', 'ыми', 'его', 'ого', 'ему', 'ому',
  'ее', 'ие', 'ые', 'ое', 'ей', 'ий', 'ый', 'ой', 'ем', 'им', 'ым', 'ом',
  'их', 'ых', 'ую', 'юю', 'ая', 'яя', 'ою', 'ею',
].map((s) => ({ s }));

const PARTICIPLE = [
  { s: 'ющ', aya: true }, { s: 'ем', aya: true }, { s: 'нн', aya: true },
  { s: 'вш', aya: true }, { s: 'щ', aya: true },
  { s: 'ивш' }, { s: 'ывш' }, { s: 'ующ' },
];

const REFLEXIVE = [{ s: 'ся' }, { s: 'сь' }];

const VERB = [
  { s: 'ете', aya: true }, { s: 'йте', aya: true }, { s: 'ешь', aya: true },
  { s: 'нно', aya: true }, { s: 'ла', aya: true }, { s: 'на', aya: true },
  { s: 'ли', aya: true }, { s: 'ем', aya: true }, { s: 'ло', aya: true },
  { s: 'но', aya: true }, { s: 'ет', aya: true }, { s: 'ют', aya: true },
  { s: 'ны', aya: true }, { s: 'ть', aya: true }, { s: 'й', aya: true },
  { s: 'л', aya: true }, { s: 'н', aya: true },
  { s: 'ейте' }, { s: 'уйте' }, { s: 'ила' }, { s: 'ыла' }, { s: 'ена' },
  { s: 'ите' }, { s: 'или' }, { s: 'ыли' }, { s: 'ило' }, { s: 'ыло' }, { s: 'ено' },
  { s: 'ует' }, { s: 'уют' }, { s: 'ены' }, { s: 'ить' }, { s: 'ыть' }, { s: 'ишь' },
  { s: 'ей' }, { s: 'уй' }, { s: 'ил' }, { s: 'ыл' }, { s: 'им' }, { s: 'ым' },
  { s: 'ен' }, { s: 'ят' }, { s: 'ит' }, { s: 'ыт' }, { s: 'ую' }, { s: 'ю' },
];

const NOUN = [
  'иями', 'ями', 'ами', 'иях', 'иям', 'ием', 'ией',
  'ев', 'ов', 'ие', 'ье', 'еи', 'ии', 'ей', 'ой', 'ий', 'ям', 'ем', 'ам', 'ом',
  'ах', 'ях', 'ию', 'ью', 'ия', 'ья',
  'а', 'е', 'и', 'й', 'о', 'у', 'ы', 'ь', 'ю', 'я',
].map((s) => ({ s }));

const SUPERLATIVE = [{ s: 'ейше' }, { s: 'ейш' }];
const DERIVATIONAL = [{ s: 'ость' }, { s: 'ост' }];

/**
 * Region boundaries as the spec defines them.
 *
 * RV - position after the first vowel (most endings must start at or after this).
 * R1 - position after the first non-vowel that follows a vowel.
 * R2 - the same rule applied again inside R1 (only DERIVATIONAL uses it).
 */
function regions(word) {
  let rv = word.length;
  for (let i = 0; i < word.length; i += 1) {
    if (VOWELS.has(word[i])) { rv = i + 1; break; }
  }

  let r1 = word.length;
  for (let i = 1; i < word.length; i += 1) {
    if (!VOWELS.has(word[i]) && VOWELS.has(word[i - 1])) { r1 = i + 1; break; }
  }

  let r2 = word.length;
  for (let i = r1 + 1; i < word.length; i += 1) {
    if (!VOWELS.has(word[i]) && VOWELS.has(word[i - 1])) { r2 = i + 1; break; }
  }

  return { rv, r1, r2 };
}

/**
 * Snowball's `among`: longest matching ending wins; if that ending's condition fails, the
 * whole group fails rather than retrying a shorter one. See the fidelity note at the top.
 *
 * @returns {string|null} the word with the ending removed, or null if nothing applied.
 */
function tryAmong(word, regionStart, endings) {
  let best = null;
  for (const entry of endings) {
    const start = word.length - entry.s.length;
    if (start < regionStart) continue;
    if (!word.endsWith(entry.s)) continue;
    if (best === null || entry.s.length > best.s.length) best = entry;
  }
  if (!best) return null;

  const start = word.length - best.s.length;
  if (best.aya) {
    const prev = word[start - 1];
    if (prev !== 'а' && prev !== 'я') return null; // condition failed -> group fails
  }
  return word.slice(0, start);
}

/**
 * Stem a single Russian word.
 *
 * Non-Cyrillic input is returned lowercased and otherwise untouched: this bot's chat is
 * bilingual and there is no honest way to stem "ssf" or "poe" with a Russian algorithm.
 * Latin tokens still match each other exactly, which is all they need to do.
 *
 * @param {string} input
 * @returns {string}
 */
function stem(input) {
  let word = String(input || '').toLowerCase().replace(/ё/g, 'е');
  if (!word) return '';
  if (!/^[а-я]+$/.test(word)) return word;

  const { rv, r2 } = regions(word);

  // --- Step 1 -------------------------------------------------------------------------
  // Perfective gerund; failing that, an optional reflexive ending followed by the first
  // of adjectival / verb / noun that applies.
  let next = tryAmong(word, rv, PERFECTIVE_GERUND);
  if (next !== null) {
    word = next;
  } else {
    const reflexive = tryAmong(word, rv, REFLEXIVE);
    if (reflexive !== null) word = reflexive;

    // "Adjectival" = an adjective ending, optionally preceded by a participle ending.
    const adjective = tryAmong(word, rv, ADJECTIVE);
    if (adjective !== null) {
      word = adjective;
      const participle = tryAmong(word, rv, PARTICIPLE);
      if (participle !== null) word = participle;
    } else {
      const verb = tryAmong(word, rv, VERB);
      if (verb !== null) {
        word = verb;
      } else {
        const noun = tryAmong(word, rv, NOUN);
        if (noun !== null) word = noun;
      }
    }
  }

  // --- Step 2: a trailing и goes -------------------------------------------------------
  const { rv: rv2 } = regions(word);
  if (word.endsWith('и') && word.length - 1 >= rv2) word = word.slice(0, -1);

  // --- Step 3: derivational suffix, but only inside R2 ---------------------------------
  // R2 is computed on the ORIGINAL word per the spec, so reuse the value from the top.
  const derivational = tryAmong(word, Math.min(r2, word.length), DERIVATIONAL);
  if (derivational !== null) word = derivational;

  // --- Step 4: undouble н, superlative, soft sign --------------------------------------
  const { rv: rv4 } = regions(word);
  const superlative = tryAmong(word, rv4, SUPERLATIVE);
  if (superlative !== null) {
    word = superlative;
    if (word.endsWith('нн')) word = word.slice(0, -1);
  } else if (word.endsWith('нн')) {
    word = word.slice(0, -1);
  } else if (word.endsWith('ь') && word.length - 1 >= rv4) {
    word = word.slice(0, -1);
  }

  return word;
}

module.exports = { stem, regions };
