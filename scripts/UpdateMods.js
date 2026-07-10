const axios = require('axios');
const botInitInfo = require("./botInitInfo.js");
const ChatStats = require('./msgHandlerDependencies/chatStats.js');

async function updateChannelModerators(moderatorsString, channelId) {
  try {
    const moderatorLogins = moderatorsString
      .split(',')
      .map(login => login.trim())
      .filter(login => login.length > 0);
    console.log(moderatorLogins);
    if (moderatorLogins.length === 0) {
      console.log(`[Twitch] ModsList is empty, channelID: ${channelId}`);
      return;
    }

    const chunkSize = 100;
    let ModList = [];
    for (let i = 0; i < moderatorLogins.length; i += chunkSize) {
      const chunk = moderatorLogins.slice(i, i + chunkSize);
      const queryParams = chunk.map(login => `login=${encodeURIComponent(login)}`).join('&');
      
      const response = await axios.get(`https://api.twitch.tv/helix/users?${queryParams}`, {
        headers: {
          'Client-ID': `${botInitInfo.settings['Client_Id']}`,
          'Authorization': `Bearer ${Apptoken}`
        }
      });

      if (response.data && response.data.data) {
        const usersData = response.data.data.map(user => user.id);
        
        ModList = ModList.concat(usersData);
      }
    }

    console.log(`[Twitch] Added ${ModList.length} users from Twitch API.`);

    await ChatStats.updateModeratorList(channelId, ModList);

  } catch (error) {
    console.error(`[Twitch API Error] ChannelID ${channelId}:`, 
      error.response ? error.response.data : error.message
    );
    throw error;
  }
}

updateChannelModerators();