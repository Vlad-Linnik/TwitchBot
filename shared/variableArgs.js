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
//      the lowercased text (what isInsult does) and through Normalization.js's homoglyph folding,
//      because an argument is exactly where "obfuscated on purpose" text arrives;
//   4. length capped: one argument MAX_ARG_LENGTH, #args MAX_ARGS_LENGTH.
// "@" stays: "!обнять @вася" is the point of the feature, and a mass ping is impossible because
// every argument is one token and #args is capped. A leading "!", "/" or "." that a value would
// put at the very start of the message is stripped where the message is assembled
// (commands/CustomCommands.js), since only there is it known what ends up first.
const { clean } = require("./textStats.js");
const Normalization = require("./Normalization.js");

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

function containsBannedWord(text, bannedWords, bannedRegex) {
  const lower = text.toLowerCase();
  if (bannedRegex && bannedRegex.test(lower)) return true;
  const folded = Normalization.normalizeText(text);
  if (!folded) return false;
  for (const word of bannedWords || []) {
    const w = Normalization.normalizeText(String(word));
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

module.exports = { parseArgs, sanitizeArg, containsBannedWord, assembleMessage, MAX_ARGS, MAX_ARG_LENGTH, MAX_ARGS_LENGTH };
