const {isMod} = require("./isMod.js");
const ChatStats = require('./chatStats.js');
const {isTimerReady} = require("./timer.js");
const botInitInfo = require("../botInitInfo.js");

class CustomCommands {
    constructor() {
      // Timer
      this.customCommandsTimer = 15 * 1000; // 15 sec
      this.lastCustomCommand = 0;
      // custom commands
      this.CommandsKeysList = {};
      this.CommandsDict = {};
      this.channelsList = [];
      for (var ch of botInitInfo["channels"]) 
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
      var res = message.match(/!addcommand !([a-z-0-9]+) (.+)/);
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
        console.log(this.CommandsDict);
        console.log(this.CommandsKeysList);
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
    var res = message.match(/!delcommand !([a-z-0-9]+)/);
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
      if (message.startsWith(`!${cmd}`)) {
        if (!isTimerReady(this.lastCustomCommand, this.customCommandsTimer)) return 1;
        client.say(channel, this.CommandsDict[channel][cmd]["result"]);
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

module.exports = new CustomCommands();