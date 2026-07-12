// Pure text extraction for the chat-word and @mention stats written by db/chatStats.js.
//
// Deliberately NOT using shared/Normalization.js here: that module folds Cyrillic
// homoglyphs onto Latin letters to defeat banned-word obfuscation, which is exactly
// wrong for word statistics - it would mangle every genuine Russian word into a
// Latin-ish mongrel. Word stats want the text as typed, just cleaned up.
//
// Everything here is a pure function so it can be unit-tested without Mongo, and so
// the one-off backfill script can reuse the identical tokenization the live bot uses
// (if these ever diverge, backfilled history stops matching new writes).

// Twitch's anti-duplicate-message padding (U+034F COMBINING GRAPHEME JOINER) plus the
// usual zero-width/invisible suspects. Real messages in this DB genuinely contain these
// - e.g. "бро  ͏" - and without stripping them the tokenizer emits invisible "words".
const INVISIBLE_CHARS = /[­͏​-‏⁠⁡-⁤﻿]/g;

// Leading/trailing punctuation, quotes, brackets, emoji-ish junk. Unicode property
// escapes keep this working for Cyrillic as well as Latin.
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

// Twitch logins: 3-25 chars, letters/digits/underscore. The leading (^|[^\w]) guard stops
// "email@domain" or "foo@bar" from registering as a mention of @domain / @bar.
const MENTION_PATTERN = /(?:^|[^\w])@([a-zA-Z0-9_]{3,25})/g;

const MIN_WORD_LENGTH = 3;
const MAX_WORD_LENGTH = 30;

// A single message can't contribute more than this many distinct words / mentions to the
// stats. Without a cap, one copypasta wall-of-text turns into a several-hundred-op bulkWrite
// on the chat hot path - the cap bounds the write amplification an abusive message can cause.
const MAX_WORDS_PER_MESSAGE = 30;
const MAX_MENTIONS_PER_MESSAGE = 5;

// Words carrying no signal in a word cloud. Anything shorter than MIN_WORD_LENGTH is already
// dropped by length, which handles most Russian stopwords for free (и, в, не, я, с, а, к, у,
// же, вы, за, бы, по...), so these lists only need the >=3-char ones.
const STOPWORDS = new Set([
  // Russian
  'без', 'более', 'больше', 'будет', 'будто', 'был', 'была', 'были', 'быть', 'вам', 'вас',
  'ваш', 'вдруг', 'ведь', 'весь', 'вот', 'всего', 'всех', 'всю', 'где', 'даже', 'два', 'для',
  'его', 'ему', 'если', 'есть', 'еще', 'ещё', 'зачем', 'здесь', 'или', 'иногда', 'каждый',
  'какой', 'когда', 'конечно', 'который', 'кто', 'куда', 'лишь', 'лучше', 'между', 'меня',
  'мне', 'много', 'может', 'можно', 'мой', 'моя', 'над', 'надо', 'нас', 'наш', 'него', 'нее',
  'неё', 'ней', 'нельзя', 'нет', 'никогда', 'ним', 'них', 'ничего', 'один', 'она', 'они',
  'оно', 'опять', 'очень', 'перед', 'под', 'пока', 'после', 'потом', 'потому', 'почему',
  'почти', 'при', 'про', 'раз', 'разве', 'сам', 'свою', 'себе', 'себя', 'сейчас', 'совсем',
  'так', 'такой', 'там', 'тебя', 'тем', 'теперь', 'тогда', 'того', 'тоже', 'той', 'только',
  'том', 'тот', 'три', 'тут', 'уже', 'хорошо', 'хоть', 'хотя', 'чего', 'чем', 'через', 'что',
  'чтоб', 'чтобы', 'эти', 'этих', 'это', 'этого', 'этой', 'этом', 'этот', 'эту', 'как', 'все',
  'такое', 'такие', 'таким', 'такая', 'тебе', 'нам', 'вами', 'нами', 'кого', 'кому', 'чему',
  'всем', 'всё', 'свой', 'своё', 'свои',
  // Added after inspecting the real top-N on #mistercop: high-frequency fillers that carried
  // no signal in the resulting cloud.
  'было', 'просто', 'вообще', 'типа', 'нужно', 'наверное', 'кажется', 'вроде', 'именно',
  // English
  'the', 'and', 'but', 'for', 'not', 'you', 'your', 'yours', 'are', 'was', 'were', 'been',
  'being', 'have', 'has', 'had', 'having', 'this', 'that', 'these', 'those', 'with', 'from',
  'they', 'them', 'their', 'there', 'then', 'than', 'what', 'when', 'where', 'which', 'who',
  'whom', 'why', 'how', 'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'nor', 'only', 'own', 'same', 'too', 'very', 'can', 'will', 'just', 'dont', 'should',
  'now', 'does', 'did', 'doing', 'would', 'could', 'get', 'got', 'its', 'about', 'into', 'over',
  'after', 'before', 'under', 'again', 'once', 'here', 'out', 'off', 'because', 'while',
  'him', 'his', 'her', 'hers', 'she', 'our', 'ours', 'yeah', 'yes', 'okay', 'like', 'know',
  'think', 'really', 'gonna', 'wanna', 'lol',
]);

// URL-ish tokens. Cheap prefix/shape checks rather than a real URL parse - this runs on
// every word of every chat message.
function looksLikeUrl(token) {
  return (
    token.includes('://') ||
    token.startsWith('www.') ||
    /\.(com|ru|org|net|io|tv|gg|me|xyz|co|dev)$/i.test(token)
  );
}

function clean(message) {
  return String(message || '').replace(INVISIBLE_CHARS, '');
}

/**
 * True for command invocations ("!countmsg vlad", "#counter"), which msgHandle.js routes on
 * the same two prefixes. These are logged to `messages` like any other line, but they are not
 * conversation: without this guard a command's arguments become "words" ("!countmsg vlad" would
 * put "vlad" in the word cloud) and its targets become "mentions" ("!ban @someone" is a
 * moderation action, not somebody being talked to).
 */
function isCommandMessage(message) {
  return /^\s*[!#]/.test(clean(message));
}

/**
 * Distinct, stat-worthy words in a message, lowercased.
 *
 * Each word counts at most once per message regardless of repetition - matching the
 * semantics addMessage() already uses for the whitelisted-emote counters, so the two
 * collections stay comparable.
 *
 * @param {string} message
 * @param {(word: string) => boolean} [isEmote] - predicate identifying tracked emotes.
 *   Emotes are excluded here because they're already counted in `words`/`WordLifetimeStats`;
 *   keeping them out means the Word Cloud and the Emote Cloud show genuinely different
 *   things instead of the emote cloud's contents drowning the word cloud.
 * @returns {string[]}
 */
function extractWords(message, isEmote = () => false) {
  const cleaned = clean(message);
  if (!cleaned || isCommandMessage(cleaned)) return [];

  const words = new Set();

  for (const rawToken of cleaned.trim().split(/\s+/)) {
    if (words.size >= MAX_WORDS_PER_MESSAGE) break;
    if (!rawToken) continue;

    // Commands and mentions are their own thing, tracked (or ignored) elsewhere.
    if (rawToken.startsWith('!') || rawToken.startsWith('#') || rawToken.startsWith('@')) continue;
    if (looksLikeUrl(rawToken)) continue;

    // Emote check on the RAW token first: the whitelist stores emotes exactly as Twitch/7TV
    // render them, and Twitch only recognises an emote as its own whitespace-delimited token.
    if (isEmote(rawToken)) continue;

    const token = rawToken.replace(EDGE_PUNCTUATION, '').toLowerCase();

    // ...and AGAIN on the cleaned token. Checking only the raw one leaks: "alarm," and "Jokerge!"
    // don't match the whitelist verbatim, so they'd survive the check above, then get stripped to
    // "alarm"/"jokerge" here and be counted as WORDS. Measured on the real corpus, that put 113
    // distinct emotes into the word index. It never reached the top 100 (0.02% of word mass), but
    // it is still an emote masquerading as a word, which is exactly what this function exists to
    // prevent. Callers pass a case-insensitive predicate, so this catches both forms.
    if (isEmote(token)) continue;

    if (token.length < MIN_WORD_LENGTH || token.length > MAX_WORD_LENGTH) continue;
    if (!/\p{L}/u.test(token)) continue; // must contain at least one letter - drops "123", "---"
    if (STOPWORDS.has(token)) continue;

    words.add(token);
  }

  return [...words];
}

/**
 * Distinct @-mentioned logins in a message, lowercased.
 *
 * Returns the login as typed, NOT a resolved userId: the text only ever carries a name, and
 * names change. Callers resolve login -> user at read time via UserIdentities.nicknames, which
 * is exactly what that collection's nickname history is for.
 *
 * @param {string} message
 * @param {string[]} [excludeLogins] - logins never counted (the sender, so self-@ is a no-op).
 * @returns {string[]}
 */
function extractMentions(message, excludeLogins = []) {
  const cleaned = clean(message);
  if (!cleaned || !cleaned.includes('@') || isCommandMessage(cleaned)) return [];

  const excluded = new Set(excludeLogins.filter(Boolean).map((login) => login.toLowerCase()));
  const mentions = new Set();

  for (const match of cleaned.matchAll(MENTION_PATTERN)) {
    if (mentions.size >= MAX_MENTIONS_PER_MESSAGE) break;
    const login = match[1].toLowerCase();
    if (excluded.has(login)) continue;
    mentions.add(login);
  }

  return [...mentions];
}

/**
 * The per-day bucket key for the daily stat rows.
 *
 * Noon rather than midnight, matching the existing `words` collection's convention
 * (chatStats.addMessage's `today.setHours(12, 0, 0, 0)`) - keeping one bucketing rule across
 * both daily collections means a query helper written for one works on the other. Reads MUST
 * go through this same function rather than rolling their own midnight boundary.
 */
function dayBucket(date = new Date()) {
  const bucket = new Date(date);
  bucket.setHours(12, 0, 0, 0);
  return bucket;
}

// The all-time row for a {channel, word} / {channel, mentionedLogin} pair lives in the same
// collection as its daily rows, distinguished by this sentinel date - the pattern
// ModUpTimeStats already uses (chatStats.updateModUpTime's `allTimeDate = new Date(0)`).
// It keeps "top N all time" an O(limit) index scan instead of a $group over every day, and any
// real date range query naturally excludes it (epoch < any range start).
const LIFETIME_BUCKET = new Date(0);

module.exports = {
  extractWords,
  extractMentions,
  isCommandMessage,
  dayBucket,
  LIFETIME_BUCKET,
  STOPWORDS,
  MAX_WORDS_PER_MESSAGE,
  MAX_MENTIONS_PER_MESSAGE,
};
