// "@user !command" - redirects a command's plain-text reply to the mentioned user instead of
// whoever actually typed the message. Originally implemented only inside CustomCommands.js's
// exex_custom_command (see that file's own comment for the full rationale: Twitch's native
// reply-threading only targets a specific message id, and there's no recent message FROM the
// mentioned user to thread onto, so the redirect is a plain @mention prefix on the reply text
// instead) - pulled out here so every built-in "just replies with information" command in
// msgHandle.js (weather, topchatters, etc.) can support the same thing without each
// reimplementing the parse+reply pair.
//
// Only recognized when what follows the mention is actually a command (`!...`), so an ordinary
// "@user hey" chat line is left alone - mentionTarget stays null and rest === message.
function parseMentionRedirect(message) {
  const match = message.match(/^@(\w+)\s+(!.+)$/s);
  return match ? { mentionTarget: match[1], rest: match[2] } : { mentionTarget: null, rest: message };
}

// client.say wrapper for the reply half: a redirect has no message id to thread onto (the
// mentioned user didn't type anything), so it's a plain @mention prefix; otherwise whatever this
// call would normally have done. replyToId is the caller's own choice (usually userState["id"]
// for reply-threading, or null/undefined for the handlers that historically post a bare line) -
// passed through explicitly rather than assumed, so wiring this in doesn't silently change a
// handler's non-mention behavior.
function sayMaybeMention(client, channel, mentionTarget, replyToId, text) {
  return mentionTarget
    ? client.say(channel, `@${mentionTarget} ${text}`)
    : client.say(channel, text, replyToId);
}

module.exports = { parseMentionRedirect, sayMaybeMention };
