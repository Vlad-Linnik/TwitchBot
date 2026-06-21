const {isMod} = require("./isMod.js");
const ChatStats = require('./chatStats.js');
const {isTimerReady} = require("./timer.js");
const botInitInfo = require("../botInitInfo.js");

class Counter {
  constructor() 
  {
    this.counters = {};
    this.counterKeysList = [];
    this.channelsList = [];
    for (var ch of Object.keys(botInitInfo.channels)) 
    {
      this.channelsList.push("#"+ch);
    }
    this.updateCounters();
  }

  updateCounters = async () =>
  {
    for (var ch of this.channelsList) {
      this.counters[ch] = await ChatStats.getAllCounters(ch);
      this.counterKeysList[ch] = Object.keys(this.counters[ch]).sort((a,b) => b.length - a.length);
    }
    
  }

  addCounter = async(client, channel, userState, message) => 
  {
    if (!isMod(userState)) {return 0;}
    var access = "all";
    var res = message.match(/!addcounter #([a-zа-я0-9]+)/);
    if (!res) 
    {
     // incorrect format 
      return 0;
    }
    var newCounter = res[1];
    if(message.match(/!addcounter #([a-zа-я0-9]+) mod/)){
      var access = "mods";
    }
    if (! await ChatStats.isCounterExist(channel, newCounter)){
      ChatStats.addNewCounter(channel, newCounter, access);
      this.counters[channel][newCounter] = 0;
      this.counterKeysList[channel] = Object.keys(this.counters[channel]).sort((a,b) => b.length - a.length);
      client.say(channel, `@${userState["username"]} Новый счетчик успешно добавлен ✅`);
      return 1;
    }
  }

  getCountersList = async(client,channel, userState, message) =>
  {
    if (!isMod(userState)) {return 0;}
    if (message.match(/!counters/)) {
      client.say(channel, `[${await this.counterKeysList[channel].toString()}]`);
    }
    return 0;
  }

  deleteCounter = async(client, channel, userState, message) =>
  {
    if (!isMod(userState)) {return 0;}
    var res = message.match(/!delcounter #([a-zа-я0-9]+)/);
    if (!res) return 0;
    if (!ChatStats.isCounterExist(channel, res[1]))
    { 
      client.say(channel, `@${userState["username"]} такого счетчика не существует 🤷‍♂️`);
      return 1;
    }
    ChatStats.deleteCounter(channel, res[1]);
    delete this.counters[channel][res[1]];
    this.counterKeysList[channel] = Object.keys(this.counters[channel]).sort((a,b) => b.length - a.length);
    client.say(channel, `@${userState["username"]} Счетчик удален! ❌`);
    return 1;
  }

  updateCounter = async(client, channel, userState, message) =>
  {
    var res = message.match(/^#([a-zа-я0-9]+) (\+|-) ([0-9]+)/);
    if (!!res) {
      var counterName = res[1];
      var operation = res[2];
      var value = parseInt(res[3]);
    } else if (res = message.match(/^#([a-zа-я0-9]+)/)) {
      var counterName = res[1];
      var operation = "+";
      var value = 1;
    } else {return 0;}
    if (!this.counterKeysList[channel].includes(counterName)) {return 1;}
    var access = (await ChatStats.getCounter(channel, counterName))[0]['access'];
    if (access == 'mods' && !isMod(userState)) {return 1;}
    if (operation === "+") {
      ChatStats.updateCounter(channel, counterName, this.counters[channel][counterName] + value);
      this.counters[channel][counterName] += value;
    } else if (operation === "-") {
      ChatStats.updateCounter(channel, counterName, this.counters[channel][counterName] - value);
      this.counters[channel][counterName] -= value;
    }
    client.say(channel, `@${userState["username"]} Счетчик #${counterName}: ${this.counters[channel][counterName]} ✅`);
    return 1;
  }
}

class CustomCommands {
    constructor(counter) {
      // Timer
      this.customCommandsTimer = 10 * 1000; // 10 sec
      this.lastCustomCommand = 0;
      //connect counter
      this.counter = counter;
      // custom commands
      this.CommandsKeysList = {};
      this.CommandsDict = {};
      this.channelsList = [];
      for (var ch of Object.keys(botInitInfo.channels)) 
      {
        this.channelsList.push("#"+ch);
      }
      this.updateCustomCommands();
    }
    
    updateCustomCommands = async () =>
    {
      for (var ch of this.channelsList) {
        this.CommandsDict[ch] = await ChatStats.getAllCommands(ch);
        this.CommandsKeysList[ch] = Object.keys(this.CommandsDict[ch]).sort((a,b) => b.length - a.length);
      }
    }

    addCommand = async(client, channel, userState, message) => 
    {
      if (!isMod(userState)) {return 0;}
      var res = message.match(/!addcommand !([a-zа-я0-9]+) (.+)/);
      if (!res) 
      {
        if (message.startsWith("!addcommand")) {
          client.say(channel, `@${userState["username"]} Неверный формат команды 😱 Используйте: !addcommand !command_name "command_result" 😎`);
          return 1;
        }
        return 0;
      }
      var newCommand = res[1];
      var CommandResult = res[2];
      if (! await ChatStats.isCommandExist(channel, newCommand)){
        ChatStats.addNewCustomCommand(channel, newCommand, CommandResult);
        this.CommandsDict[channel][newCommand] = {result: CommandResult, timer: null};
        this.CommandsKeysList[channel] = Object.keys(this.CommandsDict[channel]).sort((a,b) => b.length - a.length);
        client.say(channel, `@${userState["username"]} Команда успешно добавлена ✅`);
        return 1;
      }
      // изменить существующую команду
      ChatStats.editCustomCommand(channel, newCommand, CommandResult, null);
      this.CommandsDict[channel][newCommand] = {result: CommandResult, timer: null};
      this.CommandsKeysList[channel] = Object.keys(this.CommandsDict[channel]).sort((a,b) => b.length - a.length);
      client.say(channel, `@${userState["username"]} command updated ✅`);
      return 1;
    }

  deleteCustomCommand = async(client, channel, userState, message) => 
  {
    if (!isMod(userState)) {return 0;}
    var res = message.match(/!delcommand !([a-zа-я0-9]+)/);
    if (!res) return 0;
    if (!ChatStats.isCommandExist(channel, res[1]))
    { 
      client.say(channel, `@${userState["username"]} такой команды не существует 🤷‍♂️`);
      return 1;
    }
    ChatStats.deleteCustomCommand(channel, res[1]);
    delete this.CommandsDict[channel][res[1]];
    this.CommandsKeysList[channel] = Object.keys(this.CommandsDict[channel]).sort((a,b) => b.length - a.length);
    client.say(channel, `@${userState["username"]} Команда удалена! ❌`);
    return 1;
  }

  exex_custom_command = async(client, channel, userState, message) =>
  { 
    for (const cmd of this.CommandsKeysList[channel]) {
      if (message.toLocaleLowerCase().startsWith(`!${cmd}`)) {
        if (!isTimerReady(this.lastCustomCommand, this.customCommandsTimer)) return 1;
        var commandResult = this.CommandsDict[channel][cmd]["result"];
        var res = commandResult.match(/#([a-zа-я0-9]+)/g);
        if (res){
          for(const wordReplace of res) {
            if(counter.counterKeysList[channel].includes(wordReplace.substring(1))){
              commandResult = commandResult.replace(wordReplace, counter.counters[channel][wordReplace.substring(1)].toString());
            }
          }
        }
        client.say(channel, commandResult);
        this.lastCustomCommand = new Date().getTime();
        return 1;
      }
    }
    return 0;
  }

  getAllCustomCommands = async (client, channel, userState, message) =>
  {
    if (message.toLocaleLowerCase().match(/!customcommands/)) {
      await this.updateCustomCommands();
      client.say(channel, `custom commands: [${this.CommandsKeysList[channel]}]`);
      return 1;
    }
    return 0;
  }


}

const counter = new Counter();
const customCommands = new CustomCommands(counter);

module.exports = {
  counter,
  customCommands
};

