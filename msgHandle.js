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
const countWordTimer = 30 * 1000; // 30 sec
var lastCountWord = 0;

const mcopGaGaGaFRKTimer = 30 * 60 * 1000; // 30 minutes
var lastMcopGaGaGaFRK = 0;

const topUsersTimer = 30 * 1000; // 30 sec
var lastTopUsers = 0;

const topSmilesTimer = 30 * 1000; // 30 sec
var lasttopSmiles = 0;

const countUserMsgTimer = 30 * 1000; // 30 sec
var lastCountUserMsg = 0;


// utilities
var possible_periods = ["day", "week", "month", "all"];
var period_text_list = {"day": "сегодня", "week": "неделю", "month": "месяц", "all": "все время"};


// overload array random function
Array.prototype.random = function () {
  return this[Math.floor(Math.random() * this.length)];
};

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

  if (isMod(userState) && message.toLocaleLowerCase().match(/!restartbot/)) {
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

async function execCommands(client, channel, userState, message) {
  const commandCheck = [
    muteDuel,
    muteDuelAccept,
    get_bot_info,
    customMath,
    getDota2RandomItem,
    restartBot,
    topChatters,
    topSmiles,
    countWord,
    countUserMsg,
    addRemWordToWhiteList
    
  ];
  for (const cmd of commandCheck) {
    if ( await cmd(client, channel, userState, message)) {
      console.log(cmd.name)
      return 1;
    }
  }

  return 0;
}

async function spam_protection(client, channel, userState, message) {
  if (isMod(userState)) {
    return;
  }
  if (userState["first-msg"] && message.match(/^-_-/)) {
    Twitch_ban_API.ban(userState["user-id"], userState["room-id"], "spam bot");
    return;
  }
  if (message.match(/^-_-/)) {
    Twitch_ban_API.timeout(
      userState["user-id"],
      1200,
      userState["room-id"],
      "spam bot"
    );
  }
}



async function topChatters(client, channel, userState, message) {
  if (!message.toLocaleLowerCase().match(/^!topchatters/)) return 0;
  if (isTimerReady(lastTopUsers, topUsersTimer)){
    lastTopUsers = new Date().getTime();
  }else{return 1;}
  let topSize = 6;
  let args = message.toLocaleLowerCase().match(/!topchatters (\w+)/);
  let period;
  if (!args) {
    period = "day";
  } else {
    if (possible_periods.includes(args[1])) {
      period = args[1];
    } else {
      client.say(channel, `@${userState["username"]} ожидалось !topchatters (day|week|month|all)  VoHiYo `);
      return 1;
    }
  }
  let TopUsers = await ChatStats.getTopUsers(topSize, channel, period);
  let top_smiles = ["👑","🥈","🥉","🍬","🍬"];
  let answer=`🏆 Топ чаттерсов за ${period_text_list[period]}`;
  TopUsers = TopUsers.filter(item => item.userName !== 'moobot');
  if (topSize == TopUsers.length) {
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
  let period = "day";
  if (!args) {
    period = "day";
  } else {
    if (possible_periods.includes(args[1])) {
      period = args[1];
    } else {
      client.say(channel, `@${userState["username"]} ожидалось !topsmiles (day|week|month|all)  VoHiYo `);
      return 1;
    }
  }
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
    var res = message.toLocaleLowerCase().match(/!countword (\W+)/);
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
  var period = "day";
  var res = message.toLocaleLowerCase().match(/!countmsg (\w+)/);
  if (res) {
    if(!possible_periods.includes(res[1])){
      client.say(channel, `@${userState["username"]} Ожидалось: !countmsg (day|week|month|all)  VoHiYo `);
      return 1;
    }
    period = res[1];
  }
  var UserMsgCount = await ChatStats.getUserMessageCount(userState["user-id"], channel, period);
  client.say(channel, `У пользователя @${userState["username"]} ${UserMsgCount} сообщений за ${period_text_list[period]}`);
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

module.exports = {
  directMsgCheck: directMsgCheck,
  execCommands: execCommands,
  randomEventsAndThings: randomEventsAndThings,
  spam_protection: spam_protection,
};
