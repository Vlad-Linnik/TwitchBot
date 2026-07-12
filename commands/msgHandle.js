const { isInsult } = require("../games/isInsult.js");
const { isMod } = require("../shared/isMod.js");
const { replyIfBotLacksMod } = require("../shared/botPermission.js");
const {
  mcopDuelExecute,
} = require("../games/duelFromMrCopusBot.js");
const {
  randomEventsAndThings,
} = require("../games/randomEvents.js");
const { question } = require("../games/questionToThisBot.js");
const {
  getDota2RandomItem,
} = require("../games/randomEvents.js");
const { isTimerReady } = require("../shared/timer.js");
const ChatStats = require('../db/chatStats.js');
const botInitInfo = require("../botInitInfo.js");
const {muteDuelAccept, muteDuel, timeChanger} = require("../games/muteDuel.js");
const {getDatabaseStatsSummary} = require("../db/db.js");
const { spawn } = require('child_process');
const {customCommands, counter} = require("./CustomCommands.js");
const Twitch_ban_API = require("../twitch/TwitchBanAPI.js");
const Normalization = require("../shared/Normalization.js");
const channelSettings = require("../config/channelSettings.js");
const { syncChannelEmoteSet } = require("../sevenTv/SevenTvEmotes.js");

// timers - per-channel maps so a cooldown in one channel doesn't block another;
// cooldown durations themselves come from that channel's settings.
var lastCountWord = new Map();
var lastTopUsers = new Map();
var lasttopSmiles = new Map();
var lastCountUserMsg = new Map();
var lastcountUnique = new Map();
var lastDirectMSG = new Map();
var lastUpdateSevenTv = new Map();

// utilities
var possible_periods = ["day", "week", "month", "all"];
var period_text_list = {"day": "сегодня", "week": "неделю", "month": "месяц", "all": "все время"};


// overload array random function
Array.prototype.random = function () {
  return this[Math.floor(Math.random() * this.length)];
};

function check_2args_command(args) {
  if (!args)
    return "day";
  if (possible_periods.includes(args[1]))
    return args[1];
  return "day";
}

async function spam_protection(client, channel, userState, message) {
  if (isMod(userState)) {
    return 0;
  }
  const settings = channelSettings.getSettings(channel);
  for (const signature of settings.spamSignatures) {
    if (Normalization.detectObfuscatedSignature(message, signature)) {
      if (replyIfBotLacksMod(client, channel, userState, settings)) return 1;
      Twitch_ban_API.ban(userState["user-id"], userState["room-id"], settings.spamBanReason || "spam bot");
      return 1;
    }
  }
  return 0;
}
// direct message to this bot
function directMsgCheck(client, channel, userState, message) {
  // ignore msg with !duel
  if (message.match(/!duel/)) {
    return 1;
  }

  if (message.match(channelSettings.getCommandSignatureRegex(channel, 'muteduel', 'signature', { anchored: false }))) {
    return 0;
  }

  if (message.toLowerCase().includes(`@${botInitInfo.settings["username"].toLowerCase()}`)) {
    const checks = [mcopDuelExecute, isInsult, question];
    for (const check of checks) {
      if (check(client, channel, userState, message)) {
        return 1;
      }
    }
    const settings = channelSettings.getSettings(channel);
    if (settings.commands.directmsg.enabled && isTimerReady(lastDirectMSG.get(channel) || 0, settings.commands.directmsg.cooldownMs)){
      client.say(channel, settings.responses.busy.random(), userState["id"]);
      lastDirectMSG.set(channel, Date.now());
    }
    return 1;
  }
  return 0;
}
async function get_bot_info (client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.botinfo.enabled) return 0;
  const regex = channelSettings.getCommandSignatureRegex(channel, 'botinfo', 'signature', { anchored: false });
  if (isMod(userState) && message.toLocaleLowerCase().match(regex)){
    var DBstats = await getDatabaseStatsSummary();
    var timeD = new Date() - botInitInfo.settings["startTime"];
    var info = `works: ${timeChanger(timeD/1000)}`;
    client.say(channel, info, userState["id"]);
    return 1;
  }
  return 0;
}

async function count_unique(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.countunique.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'countunique'))) {return 0;}
  if (isTimerReady(lastcountUnique.get(channel) || 0, settings.commands.countunique.cooldownMs)){
    lastcountUnique.set(channel, Date.now());
  }else{return 1;}
  var args = message.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'countunique', '(\\w+)'));
  var period = check_2args_command(args);
  var res =  await ChatStats.getUniqueUsersCount(channel, period);
  client.say(channel, `уникальных пользователей: ${res} за ${period_text_list[period]}`, userState["id"]);
}

async function topChatters(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.topchatters.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'topchatters'))) return 0;
  if (isTimerReady(lastTopUsers.get(channel) || 0, settings.commands.topchatters.cooldownMs)){
    lastTopUsers.set(channel, Date.now());
  }else{return 1;}
  let topSize = 7;
  let showTop =  5;
  let args = message.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'topchatters', '(\\w+)'));
  let period = check_2args_command(args);
  let TopUsers = await ChatStats.getTopUsers(topSize, channel, period);
  let top_smiles = ["👑","🥈","🥉","🍬","🍬"];
  let answer=`🏆 Топ чаттерсов за ${period_text_list[period]}`;
  TopUsers = TopUsers.filter(item => 
    item.userName !== 'moobot' && item.userName !== 'mistercopus_bot'
);
  while (TopUsers.length > showTop) {
    TopUsers.pop();
  }
  for (let row = 0; row < TopUsers.length; row++) {
    answer += top_smiles[row] + " " + TopUsers[row]["userName"] + " (" + TopUsers[row]["count"] + ") |";
  }
  client.say(channel, answer);
  return 1;
}


async function topSmiles(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.topsmiles.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'topsmiles'))) return  0;
  if (isTimerReady(lasttopSmiles.get(channel) || 0, settings.commands.topsmiles.cooldownMs)){
    lasttopSmiles.set(channel, Date.now());
  }else{return 1;}
  let args = message.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'topsmiles', '(\\w+)'));
  let topSize = 5;
  let period = check_2args_command(args);
  var answer = `🏆 Топ смайлов за ${period_text_list[period]}: `;
  var TopSmilesList = await ChatStats.getTopWords(topSize, channel, period);
  for (let index = 0; index < TopSmilesList.length; index++) {
    answer += TopSmilesList[index]["word"] + " - (" + TopSmilesList[index]["count"] + ") | ";
  }
  client.say(channel, answer);
  return 1;
}

async function countWord(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.countword.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'countword'))) return 0;
  if (isTimerReady(lastCountWord.get(channel) || 0, settings.commands.countword.cooldownMs)) {
    lastCountWord.set(channel, Date.now());
  }else{return 1;}

  var res = message.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'countword', '(\\S+)'));
  if (!res) {
    client.say(channel, `Ожидалось: ${settings.commands.countword.signature} СловоДляПоиска  VoHiYo `, userState["id"]);
    return 1;
  }
  var keyWord = res[1];
  var wordInfo = await ChatStats.countWordOccurrences(keyWord, channel, "day");
  client.say(channel, `Найдено упоминаний: ${wordInfo} за ${period_text_list["day"]}`, userState["id"]);
  return 1;
}

async function countUserMsg(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.countmsg.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'countmsg'))) return 0;
  if(isTimerReady(lastCountUserMsg.get(channel) || 0, settings.commands.countmsg.cooldownMs)) {
    lastCountUserMsg.set(channel, Date.now());
  }else{return 1;}
  var args = message.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'countmsg', '(\\w+)'));
  var period = check_2args_command(args);
  var UserMsgCountInfo = await ChatStats.getUserRank(userState["user-id"], channel, period);
  client.say(channel, `У вас ${UserMsgCountInfo["totalMessages"]} сообщений, rank: ${UserMsgCountInfo["rank"]}, Top: ${UserMsgCountInfo["percentage"]}% за ${period_text_list[period]}`, userState["id"]);
  return 1;
}

async function addRemWordToWhiteList(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.addword.enabled) return 0;
  const addSignature = channelSettings.escapeRegExp(settings.commands.addword.signature);
  const remSignature = channelSettings.escapeRegExp(settings.commands.addword.remSignature);
  if (!message.match(new RegExp(`^${addSignature}|^${remSignature}`))) {return 0;}
  if(!isMod(userState)) {return 0;}
  var cmdArgs = message.match(new RegExp(`${addSignature} (\\w+)|${remSignature} (\\w+)`));
  if (!cmdArgs) {
    client.say(channel, `ошибка VoHiYo `, userState["id"]);
    return 1;
  }
  if(message.toLocaleLowerCase().match(new RegExp(addSignature.toLowerCase()))){
    await ChatStats.addToWhiteList(channel, cmdArgs[1]);
    client.say(channel, `слово "${cmdArgs[1]}" отслеживается ✅`, userState["id"]);
    return 1;
  }
  await ChatStats.removeFromWhiteList(channel, cmdArgs[2]);
  client.say(channel, `слово "${cmdArgs[2]}" НЕ отслеживается ✅`, userState["id"]);
  return 1;
}

async function updateSevenTvEmotes(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.update7tv.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'update7tv'))) return 0;
  if (!isMod(userState)) return 0;
  if (isTimerReady(lastUpdateSevenTv.get(channel) || 0, settings.commands.update7tv.cooldownMs)) {
    lastUpdateSevenTv.set(channel, Date.now());
  } else { return 1; }

  if (!settings.sevenTv?.emoteSetUrl) {
    client.say(channel, `7TV сет не настроен для этого канала VoHiYo `, userState["id"]);
    return 1;
  }

  try {
    const { words } = await syncChannelEmoteSet(channel);
    client.say(channel, `7TV эмоуты обновлены: ${words.length} ✅`, userState["id"]);
  } catch (err) {
    console.error('[7TV] Manual update failed:', err.message);
    client.say(channel, `ошибка обновления 7TV VoHiYo `, userState["id"]);
  }
  return 1;
}


async function execCommands(client, channel, userState, message) {
  const commandCheck = [
    muteDuel,
    muteDuelAccept,
    getDota2RandomItem
  ];
  const asyncCommandsCheck = [
    customCommands.getAllCustomCommands,
    get_bot_info, topChatters,topSmiles,countUserMsg,addRemWordToWhiteList,updateSevenTvEmotes,count_unique,countWord,
    customCommands.addCommand,
    customCommands.deleteCustomCommand,
    customCommands.setCommandTimer,
    customCommands.setCommandPin,
    customCommands.exex_custom_command,
    counter.addCounter,
    counter.deleteCounter,
    counter.updateCounter,
    counter.getCountersList,
    counter.addCustomCommandException,
    counter.removeCustomCommandException

  ]
  for (const cmd of asyncCommandsCheck) {
    if ( await cmd(client, channel, userState, message)) {
      ChatStats.incrementCommandCount(channel);
      return 1;
    }
  }
  for (const cmd of commandCheck) {
    if (cmd(client, channel, userState, message)) {
      ChatStats.incrementCommandCount(channel);
      return 1;
    }
  }
  return 0;
}
module.exports = {
  directMsgCheck: directMsgCheck,
  execCommands: execCommands,
  randomEventsAndThings: randomEventsAndThings,
  spam_protection: spam_protection
};
