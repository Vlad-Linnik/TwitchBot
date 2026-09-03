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

// ---------------------------------------------------------------------------------------
// Twitch's `gifs` tag - T2/T3 subscriber GIFs, launched 2026-09-01 (GIPHY partnership).
//
// Shape is the `emotes` tag's: comma-separated `<start>-<end>|<gifID>|<gifURL>`. The message
// text at that span is the GIPHY title in square brackets, e.g.
//
//   gifs=0-33|joSNxeswxuc74Juo8X|https://media4.giphy.com/... :[Y A Y Yes GIF by Djemilah Birnie]
//
// which is ordinary text to a tokenizer. Left alone, every GIF sent puts "gif" plus the GIF
// author's name into the word cloud ("gif" is exactly MIN_WORD_LENGTH and not a stopword, so it
// passes), and on an active channel it climbs the cloud fast. A blanket stopword is the wrong
// fix - it would also silence someone genuinely typing about gifs, and would not touch the
// author's name. THE TAG IS THE ONLY THING separating a real GIF from a viewer who typed those
// brackets by hand, which is why it has to be carried as far as the tokenizer.
// ---------------------------------------------------------------------------------------

/**
 * Parse the raw `gifs` tag into `{start, end, id, url}` rows. Unparseable entries are dropped
 * rather than guessed at - a bad row must not silently shift the spans of the good ones.
 *
 * @param {string} [tag] - userState.gifs, straight off tmi.js (verified: tmi.js 1.8.5 passes
 *   this unknown tag through to userState untouched).
 * @returns {{start: number, end: number, id: string, url: string}[]}
 */
function parseGifTag(tag) {
  if (!tag || typeof tag !== 'string') return [];

  const out = [];
  for (const entry of tag.split(',')) {
    if (!entry) continue;
    // The URL carries query params with their own '|'-free but ':'-heavy syntax, so split on the
    // first two separators only and let the rest of the string be the URL verbatim.
    const first = entry.indexOf('|');
    if (first < 0) continue;
    const second = entry.indexOf('|', first + 1);
    if (second < 0) continue;

    const range = entry.slice(0, first);
    const id = entry.slice(first + 1, second);
    const url = entry.slice(second + 1);

    const dash = range.indexOf('-');
    if (dash < 0) continue;
    const start = Number(range.slice(0, dash));
    const end = Number(range.slice(dash + 1));
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) continue;
    if (!id) continue;

    out.push({ start, end, id, url });
  }
  return out;
}

/**
 * The message with its GIF spans blanked out, for STAT purposes only. The text stored in
 * `messages` stays exactly as sent - this is what feeds the word/mention/emote counters.
 *
 * Spans become spaces rather than being deleted, so "text[GIF Title]more" cannot fuse two
 * neighbouring tokens into one invented word.
 *
 * @param {string} message
 * @param {{start: number, end: number}[]} [gifs] - from parseGifTag(), or the `gifs` field
 *   stored on the message document.
 * @returns {string}
 */
function stripGifSpans(message, gifs) {
  const text = String(message ?? '');
  if (!Array.isArray(gifs) || gifs.length === 0) return text;

  // Positions index CODE POINTS, not UTF-16 units, so an astral character anywhere before the
  // span (an emoji in a GIF title, or in the text next to it) would shift every later index if
  // this used plain string slicing.
  const chars = Array.from(text);
  const cut = new Array(chars.length).fill(false);

  for (const gif of gifs) {
    const start = Number(gif?.start);
    const end = Number(gif?.end);
    // A span that does not fit the message means our idea of the positions disagrees with
    // Twitch's. Drop the whole message from the stats rather than cut at a guessed offset: the
    // cost is a few genuine words, the alternative is the pollution this function exists to stop.
    if (!Number.isInteger(start) || !Number.isInteger(end)) return '';
    if (start < 0 || end < start || end >= chars.length) return '';
    for (let i = start; i <= end; i++) cut[i] = true;
  }

  return chars.map((ch, i) => (cut[i] ? ' ' : ch)).join('');
}

// ---------------------------------------------------------------------------------------
// Twitch's `emotes` tag - the ONLY way to know a Twitch emote that is not the channel's own.
//
// A viewer subscribed to some other channel can type that channel's sub emotes anywhere on
// Twitch, and the same holds for bits and follower emotes. None of those are in this channel's
// whitelist (nothing fetches another broadcaster's set, and there is no endpoint that would
// answer "which foreign emotes might show up here"), so until this existed they were counted as
// ordinary WORDS: on #mistercop `otirahi` had accumulated 1079 messages, `floimxdx` 686 and
// `totori8meh` 511, and they surfaced as words in the "Выше - ниже" game.
//
// Shape is the `gifs` tag's, one level deeper - `<id>:<start>-<end>,<start>-<end>/<id>:...`:
//
//   emotes=25:0-4,12-16/1902:6-10 :Kappa Keepo Kappa
//
// The tag carries the id and the positions but NOT the name; the name is the message text at
// that span, which is why this needs the message as well as the tag.
// ---------------------------------------------------------------------------------------

/**
 * Parse the raw `emotes` tag into `{id, name, start, end}` rows, one per DISTINCT emote (the
 * stat indexes count a token once per message, so the repeats carry no information).
 *
 * A span is accepted only when it covers a whole whitespace-delimited token of `message`.
 * Twitch renders an emote only as such a token, so anything else means our idea of the
 * positions disagrees with Twitch's - and the cost of trusting a shifted span is a garbage
 * name written into the emote registry forever. Dropping it costs one uncounted emote.
 *
 * @param {string} [tag] - userState['emotes-raw'], the tag verbatim (tmi.js parses `emotes`
 *   itself into an object and keeps the original string under this key).
 * @param {string} [message] - the message the tag came with, VERBATIM: the positions index it.
 * @returns {{id: string, name: string, start: number, end: number}[]}
 */
function parseEmotesTag(tag, message) {
  if (!tag || typeof tag !== 'string') return [];

  // Positions index CODE POINTS, not UTF-16 units - same as the `gifs` tag, and the reason an
  // emoji earlier in the line would otherwise shift every span after it.
  const chars = Array.from(String(message ?? ''));
  if (chars.length === 0) return [];

  const out = [];
  const seen = new Set();

  for (const entry of tag.split('/')) {
    const colon = entry.indexOf(':');
    if (colon <= 0) continue;
    const id = entry.slice(0, colon);
    if (!id) continue;

    for (const range of entry.slice(colon + 1).split(',')) {
      const dash = range.indexOf('-');
      if (dash < 0) continue;
      const start = Number(range.slice(0, dash));
      const end = Number(range.slice(dash + 1));
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      if (start < 0 || end < start || end >= chars.length) continue;
      // Whole-token check, both edges.
      if (start > 0 && !/\s/.test(chars[start - 1])) continue;
      if (end + 1 < chars.length && !/\s/.test(chars[end + 1])) continue;

      const name = chars.slice(start, end + 1).join('');
      if (!name || /\s/.test(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ id, name, start, end });
    }
  }

  return out;
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
  clean,
  parseGifTag,
  stripGifSpans,
  parseEmotesTag,
  extractWords,
  extractMentions,
  isCommandMessage,
  dayBucket,
  LIFETIME_BUCKET,
  STOPWORDS,
  MAX_WORDS_PER_MESSAGE,
  MAX_MENTIONS_PER_MESSAGE,
};
