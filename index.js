const botInitInfo = require("./botInitInfo.js");
const tmi = require("tmi.js");
const msgHandle = require("./msgHandle.js");
const ChatStats = require('./msgHandlerDependencies/chatStats.js');
const axios = require('axios');

const CLIENT_ID = botInitInfo['Client_Id'];
const CLIENT_SECRET = botInitInfo['client_secret'];
const BOT_ID = botInitInfo['bot_id']; 

let appAccessToken = '';
const channelIdsCache = {};

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


async function getAppAccessToken() {
    try {
        const params = new URLSearchParams();
        params.append('client_id', process.env.CLIENT_ID);
        params.append('client_secret', process.env.CLIENT_SECRET);
        params.append('grant_type', 'client_credentials');

        const response = await axios.post('https://id.twitch.tv/oauth2/token', params);
        
        appAccessToken = response.data.access_token;
        console.log('App Access Token receved!');
        console.log(response);
    } catch (error) {
        console.error('Error App token:', error.response?.data || error.message);
    }
}

// overload client.say with new Helix API
client.say = async (channel, message) => {
    const normalizedChannel = channel.toLowerCase().replace('#', '');
    const broadcasterId = channelIdsCache[normalizedChannel];

    if (!broadcasterId) {
        console.error(`[API] Error msg send to ${channel}: ID is not exist.`);
        return;
    }

    try {
        await axios.post('https://api.twitch.tv/helix/chat/messages', 
            {
                broadcaster_id: broadcasterId,
                sender_id: BOT_ID,
                message: message
            },
            {
                headers: {
                    'Authorization': `Bearer ${botInitInfo['password']}`,
                    'Client-Id': CLIENT_ID,
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
  if (userState["room-id"]) {
      channelIdsCache[normalizedChannel] = userState["room-id"];
  }

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
    await getAppAccessToken()
    client.connect();
}

start();