const {isMod} = require("./isMod.js");
const ChatStats = require('./chatStats.js');
const {isTimerReady} = require("./timer.js");

class CustomCommands {
    constructor() {
      // Timer
      this.customCommandsTimer = 15 * 1000; // 15 sec
      this.lastCustomCommand = 0;
      // custom commands
      this.CommandsKeysList = [];
      this.CommandsDict = {};
      this.updateCustomCommands();
    }
    
    updateCustomCommands = async () =>
    {
      this.CommandsDict = await ChatStats.getAllCommands();
      this.CommandsKeysList = Object.keys(this.CommandsDict).sort((a,b) => b.length - a.length);
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
      if (! await ChatStats.isCommandExist(newCommand)){
        ChatStats.addNewCustomCommand(channel, newCommand, CommandResult);
        this.CommandsDict[newCommand] = CommandResult;
        this.CommandsKeysList = Object.keys(this.CommandsDict).sort((a,b) => b.length - a.length);
        client.say(channel, `@${userState["username"]} Команда успешно добавлена ✅`);
        return 1;
      }
      ChatStats.editCustomCommand(newCommand, CommandResult, null);
      this.CommandsDict[newCommand] = CommandResult;
      this.CommandsKeysList = Object.keys(this.CommandsDict).sort((a,b) => b.length - a.length);
      client.say(channel, `@${userState["username"]} command updated ✅`);
      return 1;
    }

  deleteCustomCommand = async(client, channel, userState, message) => 
  {
    if (!isMod(userState)) {return 0;}
    var res = message.match(/!delcommand !([a-z-0-9]+)/);
    if (!res) return 0;
    if (!ChatStats.isCommandExist(res[1]))
    { 
      client.say(channel, `@${userState["username"]} такой команды не существует 🤷‍♂️`);
      return 1;
    }
    ChatStats.deleteCustomCommand(res[1]);
    delete this.CommandsDict[res[1]];
    this.CommandsKeysList = Object.keys(this.CommandsDict).sort((a,b) => b.length - a.length);
    client.say(channel, `@${userState["username"]} Команда удалена! ❌`);
    return 1;
  }

  exex_custom_command = async(client, channel, userState, message) =>
  {
    for (const cmd of this.CommandsKeysList) {
      if (message.startsWith(`!${cmd}`)) {
        if (!isTimerReady(this.lastCustomCommand, this.customCommandsTimer)) return 1;
        client.say(channel, this.CommandsDict[cmd]["result"]);
        this.lastCustomCommand = new Date().getTime();
        return 1;
      }
    }
    return 0;
  }

  getAllCustomCommands = async (client, channel, userState, message) =>
  {
    if (message.toLocaleLowerCase().match(/!commands/)) {
      await this.updateCustomCommands();
      client.say(channel, `custom commands: [${this.CommandsKeysList}]`);
      return 1;
    }
    return 0;
  }


}

module.exports = new CustomCommands();