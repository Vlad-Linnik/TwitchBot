const Twitch_ban_API = require("./TwitchBanAPI.js");
const { isSmile } = require("./msgHandlerDependencies/SmileHandler.js");
const { isInsult } = require("./msgHandlerDependencies/isInsult.js");
const { isMod } = require("./msgHandlerDependencies/isMod.js");
const {
  mcopDuelExecute,
} = require("./msgHandlerDependencies/duelFromMrCopusBot.js");
const {
  randomEventsAndThings,
} = require("./msgHandlerDependencies/randomEvents.js");
const { question } = require("./msgHandlerDependencies/questionToThisBot.js");
const {
  getDota2RandomItem,
} = require("./msgHandlerDependencies/randomEvents.js");
const { customMath } = require("./msgHandlerDependencies/myMath.js");
const { isTimerReady } = require("./msgHandlerDependencies/timer.js");
const ChatStats = require('./msgHandlerDependencies/chatStats.js');
const botInitInfo = require("./botInitInfo.js");
const {muteDuelAccept, muteDuel, timeChanger} = require("./msgHandlerDependencies/muteDuel.js");
const {getDatabaseStatsSummary} = require("./msgHandlerDependencies/db.js");
const { spawn } = require('child_process');


//timers
const countWordTimer = 15 * 1000; // 15 sec
var lastCountWord = 0;

const topUsersTimer = 15 * 1000; // 15 sec
var lastTopUsers = 0;

const topSmilesTimer = 15 * 1000; // 15 sec
var lasttopSmiles = 0;

const countUserMsgTimer = 15 * 1000; // 15 sec
var lastCountUserMsg = 0;

const countUniqueTimer = 15 * 1000; // 15 sec
var lastcountUnique = 0;

const customCommandsTimer = 15 * 1000; // 15 sec
var lastCustomCommand = 0;

// utilities
var possible_periods = ["day", "week", "month", "all"];
var period_text_list = {"day": "сегодня", "week": "неделю", "month": "месяц", "all": "все время"};

// custom commands
var custom_commands = {};
var CommandsKeysList = [];


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

function directMsgCheck(client, channel, userState, message) {
  // direct message to this bot
  if (message.match(/@chatwizardbot/)) {
    // ignore msg with !duel
    if (message.match(/!duel/)) {
      return 1;
    }
    if (message.match(/!muteduel/)) {
      return 0;
    }
    const checks = [mcopDuelExecute, isInsult, isSmile, question];
    for (const check of checks) {
      if (check(client, channel, userState, message)) {
        return 1;
      }
    }

    var answer = [
      "я сейчас занят, играю peepoSitGamer ",
      "I'm busy xyliNado",
      "xyliNado",
      "я сейчас занят, пью кофе Kobold ",
      "я сейчас занят, гуляю ppHop ",
      "я сейчас занят, на рыбалке Fishinge ",
      "я сейчас занят, ем пиццу peepoPizza",
    ];
    client.say(channel, `@${userState["username"]} ${answer.random()}`);
    return 1;
  }
  return 0;
}
async function get_bot_info (client, channel, userState, message) {
  if (isMod(userState) && message.toLocaleLowerCase().match(/!botinfo/)){
    var DBstats = await getDatabaseStatsSummary();
    var timeD = new Date() - botInitInfo["startTime"];
    var info = `@${userState["username"]} bot version ${botInitInfo["version"]}, `+
     `works: ${timeChanger(timeD/1000)}, `+
     DBstats;
    client.say(channel, info);
    return 1;
  }
  return 0;
}

function restartBot (client, channel, userState, message) {
  if (!["vlad_261", "mistercop"].includes(userState.username)) return 0;

  if (isMod(userState) && message.toLocaleLowerCase().match(/^!restartbot/)) {
    client.say(channel, `@${userState["username"]} restarting...`);
    var bat_file_name = 'start.bat';
    if (channel.match(/vlad_261/)) {
      bat_file_name = 'start_test.bat';
    }
    spawn('cmd.exe', ['/c', bat_file_name], {
      detached: true,
      stdio: 'ignore'
    }).unref();
    return 1;
  }
  return 0;
}

async function count_unique(client, channel, userState, message) {
  if (!message.toLocaleLowerCase().match(/^!countunique/)) {return 0;}
  if (isTimerReady(lastcountUnique, countUniqueTimer)){
    lastcountUnique = new Date().getTime();
  }else{return 1;}
  var args = message.toLocaleLowerCase().match(/!countunique (\w+)/);
  var period = check_2args_command(args);
  var res =  await ChatStats.getUniqueUsersCount(channel, period);
  client.say(channel, `@${userState["username"]} уникальных пользователей: ${res} за ${period_text_list[period]}`);
}

async function topChatters(client, channel, userState, message) {
  if (!message.toLocaleLowerCase().match(/^!topchatters/)) return 0;
  if (isTimerReady(lastTopUsers, topUsersTimer)){
    lastTopUsers = new Date().getTime();
  }else{return 1;}
  let topSize = 7;
  let showTop =  5;
  let args = message.toLocaleLowerCase().match(/!topchatters (\w+)/);
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
  if (!message.toLocaleLowerCase().match(/^!topsmiles/)) return  0;
  if (isTimerReady(lasttopSmiles, topSmilesTimer)){
    lasttopSmiles = new Date().getTime();
  }else{return 1;}
  let args = message.toLocaleLowerCase().match(/!topsmiles (\w+)/);
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
  if (!message.toLocaleLowerCase().match(/^!countword/)) return 0;
  var period = false;
  if (isTimerReady(lastCountWord, countWordTimer)) {
    lastCountWord = new Date().getTime();
  }else{return 1;}
  // 2 args
  var res = message.toLocaleLowerCase().match(/!countword (\S+) (\w+)/);
  if (res) {
    period = res[2];
    if (!possible_periods.includes(period)){
      client.say(channel, `@${userState["username"]} Ожидалось: !countword СловоДляПоиска (day|week|month|all)  VoHiYo `);
      return 1;
    }
  }else{
    // 1 arg
    var res = message.toLocaleLowerCase().match(/!countword (\S+)/);
    // error
    if (!res) {
      client.say(channel, `@${userState["username"]} Ожидалось: !countword СловоДляПоиска  VoHiYo `);
    return 1;
    }
    period = "day"
  }
  if (period) {
    var text_period = period_text_list[period];
  }else {
    var text_period = "день";
  }
  var keyWord = res[1];
  var wordInfo = await ChatStats.countWordOccurrences(keyWord, channel, period);
  client.say(channel, `@${userState["username"]} Найдено упоминаний: ${wordInfo} за ${text_period}`);
  return 1;
}

async function countUserMsg(client, channel, userState, message) {
  if (!message.toLocaleLowerCase().match(/^!countmsg/)) return 0;
  if(isTimerReady(lastCountUserMsg, countUserMsgTimer)) {
    lastCountUserMsg = new Date().getTime();
  }else{return 1;}
  var args = message.toLocaleLowerCase().match(/!countmsg (\w+)/);
  var period = check_2args_command(args);
  var UserMsgCountInfo = await ChatStats.getUserRank(userState["user-id"], channel, period);
  client.say(channel, `У пользователя @${userState["username"]} ${UserMsgCountInfo["totalMessages"]} сообщений, rank: ${UserMsgCountInfo["rank"]}, Top: ${UserMsgCountInfo["percentage"]}% за ${period_text_list[period]}`);
  return 1;
}

async function addRemWordToWhiteList(client, channel, userState, message) {
  if (!message.match(/^!addword|^!remword/)) {return 0;}
  if(!isMod(userState)) {return 0;}
  var cmdArgs = message.match(/!addword (\w+)|!remword (\w+)/);
  if (!cmdArgs) {
    client.say(channel, `@${userState["username"]} ошибка VoHiYo `);
    return 1;
  }
  if(message.toLocaleLowerCase().match(/!addword/)){
    await ChatStats.addToWhiteList(cmdArgs[1]);
    client.say(channel, `@${userState["username"]} слово "${cmdArgs[1]}" отслеживается ✅`);
    return 1;
  }
  await ChatStats.removeFromWhiteList(cmdArgs[2]);
  client.say(channel, `@${userState["username"]} слово "${cmdArgs[2]}" НЕ отслеживается ✅`);
  return 1;
}

async function updateCustomCommands() {
  CommandsDict = await ChatStats.getAllCommands();
  CommandsKeysList = Object.keys(CommandsDict).sort((a,b) => b.length - a.length);
}

async function exex_custom_command(client, channel, userState, message) {
  updateCustomCommands();
  for (const cmd of CommandsKeysList) {
    if (message.startsWith(`!${cmd}`)) {
      if (!isTimerReady(lastCustomCommand, customCommandsTimer)) return 1;
      client.say(channel, CommandsDict[cmd]["result"]);
      lastCustomCommand = new Date().getTime();
      return 1;
    }
  }
  return 0;
}

async function addCommand(client, channel, userState, message) {
  if (!isMod(userState)) {return 0;}
  var res = message.match(/!addcommand !([a-z-0-9]+) (.+)/);
  if (!res) return 0;
  var newCommand = res[1];
  var CommandResult = res[2];
  if (! await ChatStats.isCommandExist(newCommand)){
    ChatStats.addNewCustomCommand(newCommand, CommandResult);
    client.say(channel, `@${userState["username"]} Команда успешно добавлена ✅`);
    updateCustomCommands();
    return 1;
  }
  console.log(newCommand, CommandResult);
  ChatStats.editCustomCommand(newCommand, CommandResult, null);
  client.say(channel, `@${userState["username"]} Команда успешно обновленна ✅`);
  updateCustomCommands();
  return 1;
}

async function deleteCustomCommand(client, channel, userState, message) {
  if (!isMod(userState)) {return 0;}
  var res = message.toLocaleLowerCase().match(/!delcommand !([a-z-0-9]+)/);
  if (!res) return 0;
  if (!ChatStats.isCommandExist(res[1])) return 1;
  ChatStats.deleteCustomCommand(res[1]);
  client.say(channel, `@${userState["username"]} Команда удалена! ❌`);
  updateCustomCommands();
  return 1;
}

async function getAllCustomCommands(client, channel, userState, message) {
  if (message.toLocaleLowerCase().match(/!commands/)) {
    await updateCustomCommands();
    client.say(channel, `custom commands: ${CommandsKeysList}`);
    return 1;
  }
  return 0;
}

async function execCommands(client, channel, userState, message) {
  const commandCheck = [
    muteDuel,
    muteDuelAccept,
    customMath,
    getDota2RandomItem,
    restartBot
  ];
  const asyncCommandsCheck = [
    getAllCustomCommands, deleteCustomCommand, addCommand, get_bot_info, topChatters,topSmiles,countWord,countUserMsg,addRemWordToWhiteList,count_unique, exex_custom_command
  ]
  for (const cmd of asyncCommandsCheck) {
    if ( await cmd(client, channel, userState, message)) {
      return 1;
    }
  }
  for (const cmd of commandCheck) {
    if (cmd(client, channel, userState, message)) {
      return 1;
    }
  }
  return 0;
}
module.exports = {
  directMsgCheck: directMsgCheck,
  execCommands: execCommands,
  randomEventsAndThings: randomEventsAndThings
};
