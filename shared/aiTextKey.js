// The lookup key for both AI-reply lookaside tables: the global filter and the per-channel answer
// cache. Matching is exact on this key, so this function IS the entire fuzziness budget - "how
// similar is similar enough" is decided here and nowhere else.
//
// Deliberately minimal: case, surrounding space, repeated space. In particular it does NOT use
// shared/Normalization.js's homoglyph folding, which exists to defeat deliberate banned-word
// obfuscation and is far too aggressive here - it would collapse genuinely different questions
// onto one another, and the cost of that mistake is the bot answering a real question with a
// canned line meant for something else.
//
// Hand-kept in sync with TwitchBot-Web/lib/aiTextKey.js.
const MAX_KEY_LENGTH = 300;

function aiTextKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_KEY_LENGTH);
}

module.exports = { aiTextKey, MAX_KEY_LENGTH };
