// "Is this message talking to us?" - the single gate in front of everything that answers a
// mention (msgHandle's directMsgCheck and, through it, games/aiReply.js).
//
// Two ways in. The first is the historical one: the bot's name appears in the text. The second is
// a Twitch reply to one of the bot's own messages, which carries no name at all - without it a
// conversation dies after the first answer, because the viewer's follow-up looks like ordinary
// chat.
//
// Reply detection reads the raw IRCv3 tag. tmi.js passes tags through unchanged rather than
// renaming them, which is why the rest of this codebase reads userState["user-id"] and
// userState["room-id"] the same way.
const botInitInfo = require('../botInitInfo.js');

function botName() {
  return String(botInitInfo.settings['username'] || '').toLowerCase();
}

// The bare name anywhere in the text. Deliberately looser than the "@name" the reply handlers
// themselves require - it is what decides whether the message is worth looking at at all.
function mentionsBotName(message) {
  const name = botName();
  return Boolean(name) && String(message || '').toLowerCase().includes(name);
}

function mentionsBotHandle(message) {
  const name = botName();
  return Boolean(name) && String(message || '').toLowerCase().includes('@' + name);
}

function isReplyToBot(userState) {
  const botId = String(botInitInfo.settings['bot_id'] || '');
  if (!botId) return false;
  return String(userState['reply-parent-user-id'] || '') === botId;
}

function isAddressedToBot(userState, message) {
  return mentionsBotHandle(message) || isReplyToBot(userState);
}

module.exports = { mentionsBotName, mentionsBotHandle, isReplyToBot, isAddressedToBot };
