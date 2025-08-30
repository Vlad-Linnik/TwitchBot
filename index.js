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

  
  msgHandle.mcopGaGaGa(client, channel, userState, message);
  // log msg
  ChatStats.addMessage(userState["user-id"], userState["username"], message, channel);
  // top users 
  if (message.toLocaleLowerCase().match(/^!topchatters/)) {
    msgHandle.topChatters(client, channel, userState, message);
    return;}
  // top users 
  if (message.toLocaleLowerCase().match(/^!topsmiles/)) {
    msgHandle.topSmiles(client, channel, userState, message);
    return;}
  // get count of words occurrences
  if (message.toLocaleLowerCase().match(/^!countword/)) {
    msgHandle.countWord(client, channel, userState, message);
    return;}
  // get count of user messages
  if (message.toLocaleLowerCase().match(/^!countmsg/)) {
    msgHandle.countUserMsg(client, channel, userState, message);
  return;}
  // add remove word to white list
  if(message.toLocaleLowerCase().match(/^!addword|^!remword/)) {
    msgHandle.addRemWordToWhiteList(client, channel, userState, message);
    return;
  }


  // direct msg to this bot
  if (message.match(/chatwizardbot/)) {
    if (msgHandle.directMsgCheck(client, channel, userState, message)) {
      return;
    }
  }
  // ! commands
  if (message.match(/!/)) {
    if (msgHandle.execCommands(client, channel, userState, message)) {
      return;
    }
  }
  // spam protection
  msgHandle.spam_protection(client, channel, userState, message);

  //radom things
  msgHandle.randomEventsAndThings(client, channel, userState, message);
});

client.connect();
