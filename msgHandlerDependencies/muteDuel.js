// Import required modules and dependencies
const { isTimerReady } = require("./timer.js");
const { isMod } = require("./isMod.js");
const TwitchBanAPI = require("../TwitchBanAPI.js");
const botInitInfo = require("../botInitInfo.js");

// Utility function to roll a dice with x sides
function throwDiceDX(x) {
  return Math.floor(Math.random() * x) + 1;
}

// Constants for mute duel mechanics
const MUTE_DUEL_DELAY = 50_000; // 3 minutes
const MAX_TIMEOUT = 1_209_600; // Maximum timeout value in seconds
const MINIMUM_DUEL_TIMEOUT = 300; // Minimum timeout value in seconds

// Initialize mute duel information for each channel
const muteDuelInfo = new Map();

function initializeMuteDuelInfo() {
  return {
    usr1Id: null,
    usr2Id: null,
    usr1_mod: null,
    usr2_mod: null,
    user1: null,
    user2: null,
    timeStart: 0,
    timeout: 0,
  };
}

for (const channel of botInitInfo.channels) {
  const channelName = `#${channel}`;


  // Initialize mute duel information for the channel
  muteDuelInfo.set(channelName, initializeMuteDuelInfo());
}

// Utility function to convert seconds into human-readable time
function timeChanger(timeSeconds) {
  const timeUnits = ["секунд", "минут", "часов", "дней", "недель"];
  const timeDivisors = [60, 60, 24, 7];

  for (let i = 0; i < timeDivisors.length; i++) {
    if (timeSeconds > timeDivisors[i]) {
      timeSeconds /= timeDivisors[i];
    } else {
      return [timeSeconds.toFixed(2), timeUnits[i]];
    }
  }
  return [timeSeconds.toFixed(2), timeUnits[4]];
}

// Function to handle mute duel challenges
function muteDuel(client, channel, userState, message) {
  function duelDelayCheck(channel, userState) {
    const muteInfo = muteDuelInfo.get(channel);
    if (!isTimerReady(muteInfo.timeStart, MUTE_DUEL_DELAY)) {
      const remainingTime =
        (MUTE_DUEL_DELAY - (Date.now() - muteInfo.timeStart)) / 1000;
      const timePrefix = timeChanger(remainingTime);
      client.say(channel, `@${userState.username} Я еще не готов, КД: ${Math.floor(timePrefix[0])} ${timePrefix[1]}`);
      return 1;
    }
    return 0;
  }

  let match = message.toLowerCase().match(/!muteduel/);
  let name = null;
  let timeout = MINIMUM_DUEL_TIMEOUT;
  if (match) {
    if (duelDelayCheck(channel, userState)) return 1;
    if (!client.isMod(channel, `#${botInitInfo.username}`)) return 1;
    if (message.toLowerCase().match(/(@\w+)/)) {
      name = message
        .toLowerCase()
        .match(/(@\w+)/)[1]
        .slice(1);
    }
    //skip this names
    if (["chatwizardbot"].includes(name)) {
      return 1;
    }
    if (message.toLowerCase().match(/ ([0-9]+)/)) {
      timeout = message.toLowerCase().match(/ ([0-9]+)/)[1];
    }

    // Validate and constrain timeout values
    timeout = Math.max(MINIMUM_DUEL_TIMEOUT, timeout);
    timeout = Math.min(MAX_TIMEOUT, timeout);

    muteDuelInfo.get(channel).usr1Id = userState["user-id"];
    muteDuelInfo.get(channel).user1 = userState.username; // Challenger
    muteDuelInfo.get(channel).user2 = name; // Target
    muteDuelInfo.get(channel).timeout = timeout;
    muteDuelInfo.get(channel).usr1_mod = isMod(userState);
    muteDuelInfo.get(channel).timeStart = Date.now();

    if (name == null) {
      client.say(
        channel,
        `@${userState.username} вызывает чат на дуель ${timeout}s мута, !muteaccept - принять.`
      );
      return 1;
    }
    client.say(
      channel,
      `@${name} vs. @${userState.username} дуэль на ${timeout}s мута !muteaccept - принять.`
    );
    return 1;
  }
  return 0;
}

// Function to handle mute duel acceptance
function muteDuelAccept(client, channel, userState, message) {
  const muteInfo = muteDuelInfo.get(channel);
  if (
    isTimerReady(muteInfo.timeStart, MUTE_DUEL_DELAY) ||
    muteInfo["user1"] == null
  )
    return 0;

  if (/!muteaccept/.test(message.toLowerCase())) {
    if (muteInfo.user2 == null) {
      muteInfo.user2 = userState.username.toLowerCase();
    }
    if (userState.username.toLowerCase() === muteInfo.user2) {
      muteInfo.usr2Id = userState["user-id"];
      muteInfo.usr2_mod = isMod(userState);

      const user1Dice = throwDiceDX(6);
      const user2Dice = throwDiceDX(6);

      let resultMessage;
      let lostUser = null;
      let lostId = null;
      let winner = null;
      if (muteInfo.usr1_mod && muteInfo.usr2_mod) {
        // Moderator vs. Moderator: Always a draw
        resultMessage = `@${muteInfo.user1} выкинул : ${user1Dice} и @${muteInfo.user2} выкинул : ${user1Dice} - ничья!`;
      } else if (muteInfo.usr1_mod || muteInfo.usr2_mod) {
        // Moderator vs. Non-Moderator: Moderator always wins or draw
        if (user1Dice == 6) {
          resultMessage = `@${muteInfo.user1} выкинул : ${user1Dice} и @${muteInfo.user2} выкинул : ${user1Dice} - ничья!`;
        } else {
          if (muteInfo.usr1_mod) {
            lostUser = muteInfo.user2;
            lostId = muteInfo.usr2Id;
            winner = muteInfo.user1;
          } else {
            lostUser = muteInfo.user1;
            lostId = muteInfo.usr1Id;
            winner = muteInfo.user2;
          }
          resultMessage = `@${winner} выкинул ${
            user1Dice + throwDiceDX(6 - user1Dice)
          }, @${lostUser} выкинул ${user1Dice} - выиграл ${winner} !`;
        }
      } else {
        // Regular Duel: Fair dice rolls
        if (user1Dice > user2Dice) {
          resultMessage = `@${muteInfo.user1} выкинул ${user1Dice}, @${muteInfo.user2} выкинул ${user2Dice} победа за ${muteInfo.user1}`;
          winner = muteInfo.user1;
          lostUser = muteInfo.user2;
          lostId = muteInfo.usr2Id;
        } else if (user1Dice < user2Dice) {
          resultMessage = `@${muteInfo.user1} выкинул ${user1Dice}, @${muteInfo.user2} выкинул ${user2Dice} победа за ${muteInfo.user2}`;
          winner = muteInfo.user2;
          lostUser = muteInfo.user1;
          lostId = muteInfo.usr1Id;
        } else {
          resultMessage = `@${muteInfo.user1} и @${muteInfo.user2} выкинул ${user2Dice} - ничья!`;
        }
      }

      // timeout lost user
      if (lostUser) {
        TwitchBanAPI.timeout(
          lostId,
          muteInfo["timeout"],
          userState["room-id"],
          "duel"
        );
      }
      client.say(channel, resultMessage);
      // update mute info
      muteInfo["user1"] = null;
      return 1;
    }
  }
  return 0;
}


module.exports={
  muteDuel:muteDuel,
  muteDuelAccept:muteDuelAccept
}