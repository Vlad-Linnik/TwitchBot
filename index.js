const botInitInfo = require("./botInitInfo.js");
const tmi = require("tmi.js");
const msgHandle = require("./msgHandle.js");
const ChatStats = require('./msgHandlerDependencies/chatStats.js');

// bot settings
const opts = {
  options: {
    debug: true,
  },
  identity: {
    username: botInitInfo["username"],
    password: botInitInfo["password"],
  },
  channels: botInitInfo["channels"],
};
// create bot instance
const client = new tmi.client(opts);
// main
client.on("chat", async (channel, userState, message, self) => {
  // Don't listen to my own messages..
  if (self) return;
  // log msg
  if (!["moobot", "mistercopus_bot"].includes((userState["username"]).toLocaleLowerCase()))
    ChatStats.addMessage(userState["user-id"], userState["username"], message, channel);
  // spam protection
  if (message.match(/^-_-/)) {
    msgHandle.spam_protection(client, channel, userState, message);
    return; // stop processing if spam detected
  }

  // direct msg to this bot
  if (message.match(/chatwizardbot/)) {
    if (msgHandle.directMsgCheck(client, channel, userState, message)) {
      return;
    }
  }
  // ! commands
  if (message.match(/^!/)) {
    if (msgHandle.execCommands(client, channel, userState, message)) {
      return;
    }
  }

  //radom things
  msgHandle.randomEventsAndThings(client, channel, userState, message);

});

client.connect();
