const botInitInfo = require("./botInitInfo.js");
const tmi = require("tmi.js");
const msgHandle = require("./msgHandle.js");
const ChatStats = require('./msgHandlerDependencies/chatStats.js');
const axios = require('axios');
const TokenManager = require('./TokenManager.js');
const EventManager = require('./events.js');
const ActivityTracker = require('./ActivitiTracker.js');


// bot settings
const opts = {
  options: {
    debug: false,
  },
  identity: {
    username: botInitInfo.settings["username"],
    password: botInitInfo.settings["password"],
  },
  channels: Object.keys(botInitInfo.channels),
};

// create bot instance
const client = new tmi.client(opts);

// overload client.say with new Helix API
client.say = async (channel, message) => {
    const normalizedChannel = channel.toLowerCase().replace('#', '');
    const broadcasterId = botInitInfo.channels[normalizedChannel].id;

    if (!broadcasterId) {
        console.error(`[API] Error msg send to ${channel}: ID is not exist.`);
        return;
    }

    try {
        await axios.post('https://api.twitch.tv/helix/chat/messages', 
            {
                broadcaster_id: broadcasterId,
                sender_id: botInitInfo.settings["bot_id"],
                message: message
            },
            {
                headers: {
                    'Authorization': `Bearer ${botInitInfo.settings["appAccessToken"]}`,
                    'Client-Id': botInitInfo.settings["Client_Id"],
                    'Content-Type': 'application/json'
                }
            }
        );
        if (opts.options.debug) console.log(`[API] msg sendet to #${normalizedChannel}`);
    } catch (error) {    
        console.error('[API] Error msg:', error.response?.data || error.message);
    }
};


// main
client.on("chat", async (channel, userState, message, self) => {
  const normalizedChannel = channel.toLowerCase().replace('#', '');

  // Don't listen to my own messages..
  if (self) return;
  if (userState["username"].toLocaleLowerCase() == 'moobot') return;
  
  // log msg
  if (!["moobot", "mistercopus_bot"].includes((userState["username"]).toLocaleLowerCase()))
    ChatStats.addMessage(userState["user-id"], userState["username"], message, channel);
  
  // spam protection
  if (await msgHandle.spam_protection(client, channel, userState, message)) {
    return;
  }

  // direct msg to this bot
  if (message.match(/chatwizardbot/)) {
    if (msgHandle.directMsgCheck(client, channel, userState, message)) {
      return;
    }
  }
  // ! commands
  if (message.match(/^!|^#/)) {
    if (msgHandle.execCommands(client, channel, userState, message)) {
      return;
    }
  }

  //radom things
  msgHandle.randomEventsAndThings(client, channel, userState, message);
});

// startup
async function start() {
  await TokenManager.start(client);
  client.opts.identity.password = botInitInfo.settings["password"];
  for(let channel of Object.keys(botInitInfo.channels) ) {
    TwitchEvent = new EventManager(`${botInitInfo.channels[channel].id}`);
    TwitchEvent.connect();
    ModsActivitiTracker = new ActivityTracker(botInitInfo.channels[channel].id);
    ModsActivitiTracker.start();
  }
  client.connect();
}

start();