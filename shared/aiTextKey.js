// The key of a row in the AI channel memory (db/aiStore.js) - the same key the site computes for a
// hand-written fact, so the bot's wording and an admin's of one fact land on one row instead of two.
//
// Deliberately minimal: case, surrounding space, repeated space. In particular it does NOT use
// shared/Normalization.js's homoglyph folding, which exists to defeat deliberate banned-word
// obfuscation and is far too aggressive here - it would merge genuinely different facts.
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
