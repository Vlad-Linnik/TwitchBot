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
const aiReply = require("../games/aiReply.js");
const { isAddressedToBot } = require("../shared/addressedToBot.js");
const {
  getDota2RandomItem,
} = require("../games/randomEvents.js");
const { isTimerReady } = require("../shared/timer.js");
const ChatStats = require('../db/chatStats.js');
const botInitInfo = require("../botInitInfo.js");
const {muteDuelAccept, muteDuel, timeChanger} = require("../games/muteDuel.js");
const {customCommands, counter} = require("./CustomCommands.js");
const Twitch_ban_API = require("../twitch/TwitchBanAPI.js");
const { longBan, cancelLongBan, listLongBans } = require("./longBan.js");
const Normalization = require("../shared/Normalization.js");
const channelSettings = require("../config/channelSettings.js");
const { syncChannelEmoteSet } = require("../sevenTv/SevenTvEmotes.js");
const Clips = require("../twitch/clips.js");
const Weather = require("../twitch/weather.js");
const describeError = require("../shared/describeError.js");
const { parseMentionRedirect, sayMaybeMention } = require("../shared/mentionRedirect.js");

// timers - per-channel maps so a cooldown in one channel doesn't block another;
// cooldown durations themselves come from that channel's settings.
var lastCountWord = new Map();
var lastTopUsers = new Map();
var lasttopSmiles = new Map();
var lastCountUserMsg = new Map();
var lastcountUnique = new Map();
var lastDirectMSG = new Map();
var lastUpdateSevenTv = new Map();
var lastRandomClip = new Map();
var lastWeather = new Map();

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
  for (const raw of settings.spamSignatures) {
    // A signature used to be a bare string, always resulting in a permanent ban with the shared
    // spamBanReason - a doc predating the per-signature duration/reason feature (TwitchBot-Web's
    // lib/spamSignatureValidation.js) still means exactly that, without a separate migration.
    const signature = typeof raw === "string" ? { word: raw, durationSeconds: null, reason: null } : raw;
    if (Normalization.detectObfuscatedSignature(message, signature.word)) {
      if (replyIfBotLacksMod(client, channel, userState, settings)) return 1;
      const reason = signature.reason || settings.spamBanReason || "spam bot";
      if (signature.durationSeconds) {
        Twitch_ban_API.timeout(userState["user-id"], signature.durationSeconds, userState["room-id"], reason);
      } else {
        Twitch_ban_API.ban(userState["user-id"], userState["room-id"], reason);
      }
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

  if (isAddressedToBot(userState, message)) {
    // Order is load bearing: the banned-word check has to see the message before anything can
    // answer it, and question() is now the fallback rather than the first responder - it used to
    // swallow every message with a question mark, which is exactly the traffic the AI path wants.
    for (const check of [mcopDuelExecute, isInsult]) {
      if (check(client, channel, userState, message)) {
        return 1;
      }
    }
    // Returns true the moment it takes responsibility for a reply; the API call itself runs
    // detached (see games/aiReply.js), so nothing below waits on it.
    if (aiReply.tryAnswer(client, channel, userState, message)) {
      return 1;
    }
    if (question(client, channel, userState, message)) {
      return 1;
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
  const { mentionTarget, rest } = parseMentionRedirect(message);
  const regex = channelSettings.getCommandSignatureRegex(channel, 'botinfo', 'signature', { anchored: false });
  if (isMod(userState) && rest.toLocaleLowerCase().match(regex)){
    var timeD = new Date() - botInitInfo.settings["startTime"];
    var info = `works: ${timeChanger(timeD/1000)}`;
    sayMaybeMention(client, channel, mentionTarget, userState["id"], info);
    return 1;
  }
  return 0;
}

async function count_unique(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.countunique.enabled) return 0;
  const { mentionTarget, rest } = parseMentionRedirect(message);
  if (!rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'countunique'))) {return 0;}
  if (isTimerReady(lastcountUnique.get(channel) || 0, settings.commands.countunique.cooldownMs)){
    lastcountUnique.set(channel, Date.now());
  }else{return 1;}
  var args = rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'countunique', '(\\w+)'));
  var period = check_2args_command(args);
  var res =  await ChatStats.getUniqueUsersCount(channel, period);
  sayMaybeMention(client, channel, mentionTarget, null, `уникальных пользователей: ${res} за ${period_text_list[period]}`);
}

async function topChatters(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.topchatters.enabled) return 0;
  const { mentionTarget, rest } = parseMentionRedirect(message);
  if (!rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'topchatters'))) return 0;
  if (isTimerReady(lastTopUsers.get(channel) || 0, settings.commands.topchatters.cooldownMs)){
    lastTopUsers.set(channel, Date.now());
  }else{return 1;}
  let topSize = 7;
  let showTop =  5;
  let args = rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'topchatters', '(\\w+)'));
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
  sayMaybeMention(client, channel, mentionTarget, null, answer);
  return 1;
}


async function topSmiles(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.topsmiles.enabled) return 0;
  const { mentionTarget, rest } = parseMentionRedirect(message);
  if (!rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'topsmiles'))) return  0;
  if (isTimerReady(lasttopSmiles.get(channel) || 0, settings.commands.topsmiles.cooldownMs)){
    lasttopSmiles.set(channel, Date.now());
  }else{return 1;}
  let args = rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'topsmiles', '(\\w+)'));
  let topSize = 5;
  let period = check_2args_command(args);
  var answer = `🏆 Топ смайлов за ${period_text_list[period]}: `;
  var TopSmilesList = await ChatStats.getTopWords(topSize, channel, period);
  for (let index = 0; index < TopSmilesList.length; index++) {
    answer += TopSmilesList[index]["word"] + " - (" + TopSmilesList[index]["count"] + ") | ";
  }
  sayMaybeMention(client, channel, mentionTarget, null, answer);
  return 1;
}

async function countWord(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.countword.enabled) return 0;
  const { mentionTarget, rest } = parseMentionRedirect(message);
  if (!rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'countword'))) return 0;
  if (isTimerReady(lastCountWord.get(channel) || 0, settings.commands.countword.cooldownMs)) {
    lastCountWord.set(channel, Date.now());
  }else{return 1;}

  var res = rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'countword', '(\\S+)'));
  if (!res) {
    sayMaybeMention(client, channel, mentionTarget, userState["id"], `Ожидалось: ${settings.commands.countword.signature} СловоДляПоиска  VoHiYo `);
    return 1;
  }
  var keyWord = res[1];
  var wordInfo = await ChatStats.countWordOccurrences(keyWord, channel, "day");
  sayMaybeMention(client, channel, mentionTarget, userState["id"], `Найдено упоминаний: ${wordInfo} за ${period_text_list["day"]}`);
  return 1;
}

// Not wired up to parseMentionRedirect/sayMaybeMention on purpose, unlike its siblings below:
// this reply is inherently first-person ("У вас N сообщений" = YOUR count, i.e. whoever typed
// the message) - redirecting it to a mentioned user would misleadingly show them the caller's
// own stats as if they were the target's.
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

async function updateSevenTvEmotes(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.update7tv.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'update7tv'))) return 0;
  if (!isMod(userState)) return 0;
  if (isTimerReady(lastUpdateSevenTv.get(channel) || 0, settings.commands.update7tv.cooldownMs)) {
    lastUpdateSevenTv.set(channel, Date.now());
  } else { return 1; }

  try {
    const result = await syncChannelEmoteSet(channel);
    if (!result) {
      client.say(channel, `К этому каналу не привязан 7TV-аккаунт VoHiYo `, userState["id"]);
      return 1;
    }
    // Same follow-up the startup/scheduled sync chain does: emotes dropped from the set get
    // their words/WordLifetimeStats rows pruned so they leave the web emote cloud. Safe here
    // even though only the 7TV half re-synced - the whitelist still holds the startup-synced
    // twitch-global rows, so the empty-whitelist guard and "tracked under ANY source"
    // semantics hold. This manual path deliberately does NOT touch emoteSyncScheduler's
    // 3-per-24h cap; it is governed by its own per-channel cooldownMs instead.
    await ChatStats.pruneUntrackedEmoteStats(channel);
    client.say(channel, `7TV эмоуты обновлены: ${result.words.length} ✅`, userState["id"]);
  } catch (err) {
    console.error('[7TV] Manual update failed:', err.message);
    client.say(channel, `ошибка обновления 7TV VoHiYo `, userState["id"]);
  }
  return 1;
}


async function randomClip(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.randomclip.enabled) return 0;
  const { mentionTarget, rest } = parseMentionRedirect(message);
  if (!rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'randomclip'))) return 0;
  if (isTimerReady(lastRandomClip.get(channel) || 0, settings.commands.randomclip.cooldownMs)) {
    lastRandomClip.set(channel, Date.now());
  } else { return 1; }

  const broadcasterId = botInitInfo.channels[channelSettings.normalizeChannel(channel)]?.id;
  if (!broadcasterId) return 1;

  try {
    const clip = await Clips.getRandomClip(broadcasterId);
    if (!clip) {
      sayMaybeMention(client, channel, mentionTarget, userState["id"], `клипов не найдено VoHiYo `);
      return 1;
    }
    sayMaybeMention(client, channel, mentionTarget, userState["id"], `🎬 ${clip.title} — ${clip.url}`);
  } catch (err) {
    console.error('[Clips] Failed to fetch random clip:', err.message);
    sayMaybeMention(client, channel, mentionTarget, userState["id"], `ошибка получения клипа VoHiYo `);
  }
  return 1;
}

async function weather(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.weather.enabled) return 0;
  const { mentionTarget, rest } = parseMentionRedirect(message);
  if (!rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'weather'))) return 0;
  if (isTimerReady(lastWeather.get(channel) || 0, settings.commands.weather.cooldownMs)) {
    lastWeather.set(channel, Date.now());
  } else { return 1; }

  const res = rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureArgRegex(channel, 'weather', '(.+)'));
  const city = res ? res[1].trim() : (settings.commands.weather.defaultCity || '').trim();
  if (!city) {
    sayMaybeMention(client, channel, mentionTarget, userState["id"], `Ожидалось: ${settings.commands.weather.signature} Город VoHiYo `);
    return 1;
  }

  try {
    const result = await Weather.getWeather(city);
    if (!result) {
      sayMaybeMention(client, channel, mentionTarget, userState["id"], `город "${city}" не найден VoHiYo `);
      return 1;
    }
    const emojiPart = result.isMoonEmoji ? `фаза луны: ${result.emoji}` : result.emoji;
    const humidityPart = result.humidity !== undefined ? `, влажность ${result.humidity}%` : '';
    const advicePart = result.advice?.length ? ` — ${result.advice.join(' ')}` : '';
    // result.place is the place the geocoder actually resolved to ("Одесса, Украина"), not the
    // string that was typed - a same-name hit in another country, or a near-miss on a misspelled
    // name, is otherwise indistinguishable from the right answer.
    sayMaybeMention(client, channel, mentionTarget, userState["id"], `Сейчас погода в ${result.place || city}: ${result.description} ${emojiPart}, ${result.tempC}°C${humidityPart}${advicePart}`);
  } catch (err) {
    console.error('[Weather] Failed to fetch weather:', describeError(err));
    sayMaybeMention(client, channel, mentionTarget, userState["id"], `ошибка получения погоды VoHiYo `);
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
    get_bot_info, topChatters,topSmiles,countUserMsg,updateSevenTvEmotes,count_unique,countWord,randomClip,weather,
    longBan, cancelLongBan, listLongBans,
    customCommands.addCommand,
    customCommands.deleteCustomCommand,
    customCommands.setCommandTimer,
    customCommands.setCommandPin,
    customCommands.setCommandAnnounce,
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
