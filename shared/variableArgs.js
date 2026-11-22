// Arguments of a custom command ("!обнять вася" -> #argument1 = "вася") and the cleaning they
// get before they reach chat.
//
// Why cleaning is needed here and nowhere else in command text: the bot is a moderator, so its
// messages pass neither AutoMod nor the channel's link ban. #argumentN / #args are the first way
// to make the bot repeat a viewer's text verbatim, i.e. to launder a link or a banned word
// through it. The template itself is written by a moderator, who answers for it, so only the
// values that came from the viewer are cleaned:
//   1. invisible characters removed (textStats.clean);
//   2. links removed, with the same two patterns games/aiReply.js's sanitizeReply uses;
//   3. a value containing a word from the channel's banned list becomes empty - checked both on
//      the lowercased text (what isInsult does) and through a homoglyph fold (foldForBanCheck),
//      because an argument is exactly where "obfuscated on purpose" text arrives;
//   4. length capped: one argument MAX_ARG_LENGTH, #args MAX_ARGS_LENGTH.
// "@" stays: "!обнять @вася" is the point of the feature, and a mass ping is impossible because
// every argument is one token and #args is capped. A leading "!", "/" or "." that a value would
// put at the very start of the message is stripped where the message is assembled
// (commands/CustomCommands.js), since only there is it known what ends up first.
const { clean } = require("./textStats.js");

const MAX_ARGS = 9;
const MAX_ARG_LENGTH = 50;
const MAX_ARGS_LENGTH = 200;

const LINK_RE = /https?:\/\/\S+/gi;
const DOMAIN_RE = /\b[\w-]+\.(?:com|net|org|ru|ua|tv|io|me|gg|xyz|dev|app)\b\S*/gi;

// Everything after "!trigger", split on whitespace. `tail` is that text with runs of whitespace
// folded to one space.
function parseArgs(afterTrigger) {
  const tail = String(afterTrigger ?? "").trim().replace(/\s+/g, " ");
  const list = tail ? tail.split(" ").slice(0, MAX_ARGS) : [];
  return { list, tail };
}

// Obfuscation fold for the banned-word check: Latin lookalikes become the Cyrillic letters they
// imitate ("xуй" -> "хуй", "ЧМ0" -> "чмо"), accents go ("ё" -> "е", "й" -> "и"), and everything that
// is not a letter or digit is dropped INSIDE a word ("х.у.й", "х_у_й"), while the gap between words
// stays a single space.
//
// It folds toward Cyrillic, not the other way, on purpose. Normalization.normalizeText maps
// Cyrillic to Latin and DROPS every letter with no Latin twin (ч, ш, г, и, б, ...), so a banned
// word shrinks to a fragment that ordinary text contains: "чмо" -> "mo" matched "Москве", "хуй" ->
// "xy" matched any "ху", "шизик" -> "3k". Here every Cyrillic letter survives, so a word can only
// match itself. Keeping word gaps does the same job for short words across a boundary ("мало
// хорошего" is not "лох"); letters spaced out one by one are the price - the bannedRegex check on
// the raw text is unchanged and still catches the word written plainly.
const LATIN_LOOKALIKES = {
  a: "а", b: "в", c: "с", e: "е", h: "н", k: "к", m: "м", o: "о", p: "р", t: "т", x: "х", y: "у",
  "0": "о", "3": "з",
};

function foldForBanCheck(text) {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[a-z0-9]/g, (ch) => LATIN_LOOKALIKES[ch] || ch)
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean)
    .join(" ");
}

function containsBannedWord(text, bannedWords, bannedRegex) {
  const lower = text.toLowerCase();
  if (bannedRegex && bannedRegex.test(lower)) return true;
  const folded = foldForBanCheck(text);
  if (!folded) return false;
  for (const word of bannedWords || []) {
    const w = foldForBanCheck(word);
    if (w && folded.includes(w)) return true;
  }
  return false;
}

function truncate(text, max) {
  const chars = Array.from(text);
  return chars.length <= max ? text : chars.slice(0, max).join("").trim();
}

// -> cleaned string, "" when nothing usable is left.
function sanitizeArg(value, { bannedWords = [], bannedRegex = null, maxLength = MAX_ARG_LENGTH } = {}) {
  let out = clean(String(value ?? ""));
  out = out.replace(LINK_RE, " ").replace(DOMAIN_RE, " ");
  out = out.replace(/\s+/g, " ").trim();
  if (!out) return "";
  if (containsBannedWord(out, bannedWords, bannedRegex)) return "";
  return truncate(out, maxLength);
}

// Pieces from variableTemplate.renderPieces -> the message to send, or "" for nothing to send.
//   - An empty value between two spaces leaves one space, not two ("обнимает  " for a missing
//     #argument1 would otherwise keep its double gap).
//   - If the message would START with "!", "/" or "." and that character came from a viewer's
//     value, it is removed: otherwise the reply runs another bot's command, or a Twitch slash
//     command, under a moderator's name. The same character written by the template's author is
//     left alone - that is their decision.
//   - Cut to maxLength code points (Helix rejects anything over 500).
function assembleMessage(pieces, maxLength) {
  const parts = pieces.map((p) => ({ ...p }));
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].value || parts[i].text !== "") continue;
    const prev = parts.slice(0, i).reverse().find((p) => p.text !== "");
    const next = parts.slice(i + 1).find((p) => p.text !== "");
    if (prev && next && /\s$/.test(prev.text) && /^\s/.test(next.text)) next.text = next.text.replace(/^\s+/, "");
  }
  for (let guard = 0; guard < parts.length + 1; guard++) {
    const first = parts.find((p) => p.text.trim() !== "");
    if (!first || !first.untrusted) break;
    const stripped = first.text.replace(/^\s*[!/.]+\s*/, "");
    if (stripped === first.text) break;
    first.text = stripped;
  }
  const text = parts.map((p) => p.text).join("").trim();
  return truncate(text, maxLength);
}

module.exports = { parseArgs, sanitizeArg, containsBannedWord, foldForBanCheck, assembleMessage, MAX_ARGS, MAX_ARG_LENGTH, MAX_ARGS_LENGTH };
