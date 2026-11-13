// Command-text templates: "#name" and "#name(params)" inside a custom command's reply.
//
// HAND-SYNCED: TwitchBot/shared/variableTemplate.js and TwitchBot-Web/lib/variableTemplate.js are
// the same file, byte for byte. The bot renders with it, the site validates with it; a drift means
// the panel accepts a text the bot reads differently. Pure functions only - no channel data, no
// resolvers (those live in the bot), no descriptions (those live in the site's locales).
//
// Grammar:
//   variable := "#" NAME [ "(" PARAMS ")" ]
//   NAME     := [a-zа-яё0-9_]+, compared case-insensitively
//
// - A name is a WHOLE token. "#смерти2" is the unknown name "смерти2", i.e. plain text, not
//   "#смерти" followed by "2". Text glued straight after a variable needs empty parentheses to
//   close the name: "#смерти()раз". The text is cut into tokens once, left to right, which is
//   what keeps "#a" from being replaced inside "#ab" - the search-and-replace this replaced did
//   exactly that.
// - An unknown name is text. Links ("...#gid=0") and hashtags ("#ворб") reach chat untouched,
//   which is what they did before any of this existed.
// - Substitution is single-pass: a value is never parsed again, so a viewer typing "#rand(1-9)"
//   as an argument gets those characters back, not a number.
// - Escaping: a run of N backslashes directly before "#" becomes floor(N/2) backslashes, and an
//   odd N makes that "#" literal. So "\#имя" is the text "#имя", "\\#имя" is "\" and then the
//   variable. A backslash anywhere else is left alone - links and emoticons that contain one keep
//   it. A backslash rather than "##" because two hashes in a row occur in links, while a backslash
//   in chat text practically never does.
// - Bad parameters on a KNOWN name ("#rand(abc)") render as the original text: chat never gets an
//   error instead of an answer. The site refuses to save such a text (validateTemplate).
(function (root) {
  "use strict";

  const NAME_CHAR = /[a-zA-Zа-яА-ЯёЁ0-9_]/;

  // A channel's own variable names, as !addvar and the panel accept them. Narrower than NAME_CHAR
  // on purpose: lowercase only (the chat matcher for "#name + 1" does not lowercase the message,
  // so an uppercase name could never be updated from chat) and no "_". "ё" sits outside the а-я
  // range and is listed on its own.
  const USER_NAME_CHARS = "a-zа-яё0-9";
  const USER_NAME_PATTERN = new RegExp(`^[${USER_NAME_CHARS}]+$`);
  const MAX_NAME_LENGTH = 30;

  // Twitch's hard cap on one chat message, in code points.
  const MAX_MESSAGE_LENGTH = 500;
  // Same ceiling as a numeric variable's value.
  const MAX_RANGE_BOUND = 1_000_000_000;
  const DEFAULT_RANGE = { min: 1, max: 100 };
  const MAX_FALLBACK_LENGTH = 100;
  const MAX_PICK_OPTIONS = 50;

  // Names and parameter grammar only. `params`:
  //   none     - no parameters ("#channel", "#channel()")
  //   fallback - optional text used when the value is empty: "#argument1(всех)"
  //   range    - "#rand", "#rand(1-6)", "#rand(-10..10)"
  //   pick     - "#pick(камень|ножницы|бумага)", a list is required
  // `perCaller`: the value comes from whoever triggered the command, so a timer's auto-send, which
  // has nobody, gets the empty value (or the fallback).
  const BUILTINS = {
    username: { params: "fallback", perCaller: true },
    touser: { params: "fallback", perCaller: true },
    args: { params: "fallback", perCaller: true },
    rand: { params: "range" },
    pick: { params: "pick" },
    channel: { params: "none" },
    game: { params: "fallback" },
    time: { params: "none" },
    date: { params: "none" },
  };
  for (let i = 1; i <= 9; i++) BUILTINS[`argument${i}`] = { params: "fallback", perCaller: true };

  function isBuiltin(name) {
    return Object.prototype.hasOwnProperty.call(BUILTINS, String(name).toLowerCase());
  }

  function normalizeName(value) {
    return (value || "").toString().trim().replace(/^#+/, "").toLowerCase();
  }

  // -> [{type: "text", value, start, end}, {type: "var", name, params, raw, start, end}]
  // `params` is null without parentheses, "" for "()", the inner text otherwise. `start`/`end`
  // are offsets into the ORIGINAL text, so an editor can map tokens back onto what was typed.
  function tokenize(text) {
    const src = String(text ?? "");
    const tokens = [];
    let buf = "";
    let bufStart = 0;
    const flush = (at) => {
      if (buf) tokens.push({ type: "text", value: buf, start: bufStart, end: at });
      buf = "";
      bufStart = at;
    };

    let i = 0;
    while (i < src.length) {
      const ch = src[i];

      if (ch === "\\") {
        let j = i;
        while (src[j] === "\\") j++;
        const run = j - i;
        if (src[j] !== "#") {
          buf += src.slice(i, j);
          i = j;
          continue;
        }
        buf += "\\".repeat(Math.floor(run / 2));
        if (run % 2 === 1) {
          buf += "#";
          i = j + 1;
          // The name after an escaped "#" is ordinary text; consume it here so it cannot be
          // re-read as anything else.
          while (i < src.length && NAME_CHAR.test(src[i])) buf += src[i++];
          continue;
        }
        i = j; // even run: the "#" below is a real one
        continue;
      }

      if (ch === "#") {
        let j = i + 1;
        while (j < src.length && NAME_CHAR.test(src[j])) j++;
        if (j === i + 1) {
          buf += "#";
          i++;
          continue;
        }
        let params = null;
        let end = j;
        if (src[j] === "(") {
          const close = src.indexOf(")", j + 1);
          if (close !== -1) {
            params = src.slice(j + 1, close);
            end = close + 1;
          }
        }
        flush(i);
        tokens.push({ type: "var", name: src.slice(i + 1, j).toLowerCase(), params, raw: src.slice(i, end), start: i, end });
        i = end;
        bufStart = end;
        continue;
      }

      buf += ch;
      i++;
    }
    flush(src.length);
    return tokens;
  }

  // "1-100", "1..100", "1–100", "-10..10", "-10-10" (the first minus is a sign). Both bounds
  // inclusive, swapped when given backwards. No parameters at all means 1..100.
  function parseRange(params) {
    if (params === null || params === undefined || String(params).trim() === "") return { ...DEFAULT_RANGE };
    const m = String(params).match(/^\s*(-?\d+)\s*(?:\.\.|–|-)\s*(-?\d+)\s*$/);
    if (!m) return null;
    let min = Number(m[1]);
    let max = Number(m[2]);
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) return null;
    if (Math.abs(min) > MAX_RANGE_BOUND || Math.abs(max) > MAX_RANGE_BOUND) return null;
    if (min > max) [min, max] = [max, min];
    return { min, max };
  }

  // "a|b|c" -> ["a", "b", "c"]. Blank options are dropped ("a||b" is two options); a list that is
  // empty after that is invalid.
  function parsePick(params) {
    if (params === null || params === undefined) return null;
    const options = String(params).split("|").map((s) => s.trim()).filter(Boolean);
    if (options.length === 0 || options.length > MAX_PICK_OPTIONS) return null;
    return options;
  }

  // What a name means in a given channel. A channel's own variable wins over a built-in of the
  // same name: the only way such a pair can arise is a built-in added later, and if the built-in
  // won, the text of a command that already works would change without anyone touching it.
  // -> {kind: "user" | "builtin" | "unknown", ok, reason}
  function checkVariable(name, params, userNames) {
    const key = String(name).toLowerCase();
    const own = userNames instanceof Set ? userNames.has(key) : Array.isArray(userNames) && userNames.includes(key);
    if (own) {
      const ok = params === null || params === "";
      return { kind: "user", ok, reason: ok ? null : "user_params" };
    }
    const spec = BUILTINS[key];
    if (!spec || !Object.prototype.hasOwnProperty.call(BUILTINS, key)) return { kind: "unknown", ok: true, reason: null };
    switch (spec.params) {
      case "none": {
        const ok = params === null || params === "";
        return { kind: "builtin", ok, reason: ok ? null : "no_params" };
      }
      case "fallback": {
        const ok = params === null || params.length <= MAX_FALLBACK_LENGTH;
        return { kind: "builtin", ok, reason: ok ? null : "fallback_too_long" };
      }
      case "range": {
        const ok = parseRange(params) !== null;
        return { kind: "builtin", ok, reason: ok ? null : "range" };
      }
      case "pick": {
        const ok = parsePick(params) !== null;
        return { kind: "builtin", ok, reason: ok ? null : "pick" };
      }
      default:
        return { kind: "builtin", ok: false, reason: "unknown_grammar" };
    }
  }

  // Every known name with parameters it cannot take. Unknown names are not problems.
  // -> [{name, raw, reason, start, end}]
  function validateTemplate(text, userNames) {
    const problems = [];
    for (const tok of tokenize(text)) {
      if (tok.type !== "var") continue;
      const check = checkVariable(tok.name, tok.params, userNames);
      if (!check.ok) problems.push({ name: tok.name, raw: tok.raw, reason: check.reason, start: tok.start, end: tok.end });
    }
    return problems;
  }

  // Joins tokens back into text. `resolve(name, params, token)` returns undefined for "not a
  // variable" (the token's original text is kept), a string, or {text, untrusted: true} for a
  // value that came from a viewer. -> [{text, value: bool, untrusted: bool}]
  function renderPieces(tokens, resolve) {
    return tokens.map((tok) => {
      if (tok.type === "text") return { text: tok.value, value: false, untrusted: false };
      const out = resolve(tok.name, tok.params, tok);
      if (out === undefined || out === null) return { text: tok.raw, value: false, untrusted: false };
      if (typeof out === "object") return { text: String(out.text ?? ""), value: true, untrusted: !!out.untrusted };
      return { text: String(out), value: true, untrusted: false };
    });
  }

  function render(tokens, resolve) {
    return renderPieces(tokens, resolve).map((p) => p.text).join("");
  }

  function truncateCodePoints(text, max) {
    const chars = Array.from(String(text ?? ""));
    return chars.length <= max ? chars.join("") : chars.slice(0, max).join("");
  }

  const api = {
    BUILTINS,
    USER_NAME_CHARS,
    USER_NAME_PATTERN,
    MAX_NAME_LENGTH,
    MAX_MESSAGE_LENGTH,
    MAX_RANGE_BOUND,
    MAX_FALLBACK_LENGTH,
    isBuiltin,
    normalizeName,
    tokenize,
    parseRange,
    parsePick,
    checkVariable,
    validateTemplate,
    renderPieces,
    render,
    truncateCodePoints,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VariableTemplate = api;
})(typeof window !== "undefined" ? window : this);
