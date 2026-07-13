const {isMod} = require("../shared/isMod.js");
const ChatStats = require('../db/chatStats.js');
const {isTimerReady} = require("../shared/timer.js");
const botInitInfo = require("../botInitInfo.js");
const channelSettings = require("../config/channelSettings.js");
const streamStatus = require("../twitch/streamStatus.js");
const TwitchChatAPI = require("../twitch/TwitchChatAPI.js");

class Counter {
  constructor()
  {
    this.counters = {};
    this.counterAccess = {};
    this.counterKeysList = [];
    this.channelsList = [];
    // Shared per-channel set of usernames exempt from mod-only counter access
    // checks - one list per channel, used by every counter/custom command in
    // that channel rather than tracked separately per counter.
    this.customCommandExceptions = {};
    // Per "channel counterName" last-update timestamp, used to enforce a short
    // cooldown between updates to the same counter (see updateCounter).
    this.lastCounterUpdate = new Map();
    for (var ch of Object.keys(botInitInfo.channels))
    {
      this.channelsList.push("#"+ch);
    }
    this.updateCounters();
    this.updateCustomCommandExceptions();
  }

  updateCounters = async () =>
  {
    for (var ch of this.channelsList) {
      const counters = await ChatStats.getAllCounters(ch);
      this.counters[ch] = {};
      this.counterAccess[ch] = {};
      for (const [name, data] of Object.entries(counters)) {
        this.counters[ch][name] = data.count;
        this.counterAccess[ch][name] = data.access;
      }
      this.counterKeysList[ch] = Object.keys(this.counters[ch]).sort((a,b) => b.length - a.length);
    }
  }

  updateCustomCommandExceptions = async () =>
  {
    for (var ch of this.channelsList) {
      this.customCommandExceptions[ch] = new Set(await ChatStats.getCustomCommandExceptions(ch));
    }
  }

  // Picks up counter edits made OUTSIDE this process - the TwitchBot-Web panel's
  // /<channel>/counters page writes the same `counters` collection. Called from
  // CustomCommands.refreshFromDatabase on its 10s tick. Overwriting the in-memory
  // snapshot with fresh DB values can never lose an increment (chat updates go through
  // an atomic $inc and write the returned value back) - at worst a #name substitution
  // shows a ≤10s-stale number, the same staleness class as command text.
  refreshFromDatabase = async () =>
  {
    for (const ch of this.channelsList) {
      try {
        const counters = await ChatStats.getAllCounters(ch);
        this.counters[ch] = {};
        this.counterAccess[ch] = {};
        for (const [name, data] of Object.entries(counters)) {
          this.counters[ch][name] = data.count;
          this.counterAccess[ch][name] = data.access;
        }
        this.counterKeysList[ch] = Object.keys(this.counters[ch]).sort((a,b) => b.length - a.length);
      } catch (err) {
        // Never let a failed refresh kill the interval - the cache just stays as it was.
        console.error(`[Counter] refresh failed for ${ch}:`, err.message);
      }
    }
  }

  isCustomCommandException = (channel, userState) =>
  {
    const exceptions = this.customCommandExceptions[channel];
    return !!exceptions && exceptions.has(userState["username"].toLowerCase());
  }

  addCustomCommandException = async(client, channel, userState, message) =>
  {
    if (!isMod(userState)) {return 0;}
    const settings = channelSettings.getSettings(channel);
    if (!settings.commands.exception.enabled) return 0;
    var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'exception', '@?(\\w+)'));
    if (!res) {
      if (message.startsWith(settings.commands.exception.signature)) {
        client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.exception.signature} username 😎`, userState["id"]);
        return 1;
      }
      return 0;
    }
    var username = res[1].toLowerCase();
    await ChatStats.addCustomCommandException(channel, username);
    if (!this.customCommandExceptions[channel]) this.customCommandExceptions[channel] = new Set();
    this.customCommandExceptions[channel].add(username);
    client.say(channel, `пользователь ${username} добавлен в исключения ✅`, userState["id"]);
    return 1;
  }

  removeCustomCommandException = async(client, channel, userState, message) =>
  {
    if (!isMod(userState)) {return 0;}
    const settings = channelSettings.getSettings(channel);
    if (!settings.commands.exception.enabled) return 0;
    var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'exception', '@?(\\w+)', 'remSignature'));
    if (!res) {
      if (message.startsWith(settings.commands.exception.remSignature)) {
        client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.exception.remSignature} username 😎`, userState["id"]);
        return 1;
      }
      return 0;
    }
    var username = res[1].toLowerCase();
    await ChatStats.removeCustomCommandException(channel, username);
    this.customCommandExceptions[channel]?.delete(username);
    client.say(channel, `пользователь ${username} удален из исключений ✅`, userState["id"]);
    return 1;
  }

  addCounter = async(client, channel, userState, message) =>
  {
    if (!isMod(userState)) {return 0;}
    const settings = channelSettings.getSettings(channel);
    if (!settings.commands.addcounter.enabled) return 0;
    var access = "all";
    var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'addcounter', '#([a-zа-я0-9]+)'));
    if (!res)
    {
      if (message.startsWith(settings.commands.addcounter.signature)) {
        client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.addcounter.signature} #counter_name [mod] 😎`, userState["id"]);
        return 1;
      }
      return 0;
    }
    var newCounter = res[1];
    if(message.match(channelSettings.getCommandSignatureArgRegex(channel, 'addcounter', '#([a-zа-я0-9]+) mod'))){
      var access = "mods";
    }
    if (! await ChatStats.isCounterExist(channel, newCounter)){
      ChatStats.addNewCounter(channel, newCounter, access);
      this.counters[channel][newCounter] = 0;
      this.counterAccess[channel][newCounter] = access;
      this.counterKeysList[channel] = Object.keys(this.counters[channel]).sort((a,b) => b.length - a.length);
      client.say(channel, `Новый счетчик успешно добавлен ✅`, userState["id"]);
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
    const settings = channelSettings.getSettings(channel);
    if (!settings.commands.delcounter.enabled) return 0;
    var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'delcounter', '#([a-zа-я0-9]+)'));
    if (!res) {
      if (message.startsWith(settings.commands.delcounter.signature)) {
        client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.delcounter.signature} #counter_name 😎`, userState["id"]);
        return 1;
      }
      return 0;
    }
    if (! await ChatStats.isCounterExist(channel, res[1]))
    { 
      client.say(channel, `такого счетчика не существует 🤷‍♂️`, userState["id"]);
      return 1;
    }
    ChatStats.deleteCounter(channel, res[1]);
    delete this.counters[channel][res[1]];
    delete this.counterAccess[channel][res[1]];
    this.counterKeysList[channel] = Object.keys(this.counters[channel]).sort((a,b) => b.length - a.length);
    client.say(channel, `Счетчик удален! ❌`, userState["id"]);
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
    var access = this.counterAccess[channel][counterName];
    if (access == 'mods' && !isMod(userState) && !this.isCustomCommandException(channel, userState)) {return 1;}

    // Chat has real-world latency: two people can both go to update the same
    // counter within a few seconds of each other without having seen the
    // other's message land yet, and end up double-updating it by accident.
    // A short per-counter cooldown (not a lock - the second attempt is just
    // rejected outright) avoids that instead of trying to serialize genuinely
    // concurrent writes.
    var cooldownMs = channelSettings.getSettings(channel).commands.counterUpdate.cooldownMs;
    var cooldownKey = `${channel} ${counterName}`;
    if (!isTimerReady(this.lastCounterUpdate.get(cooldownKey) || 0, cooldownMs)) {
      client.say(channel, `Счетчик #${counterName} уже обновляли только что, подождите немного`, userState["id"]);
      return 1;
    }
    this.lastCounterUpdate.set(cooldownKey, Date.now());

    var delta = operation === "+" ? value : -value;
    var newCount = await ChatStats.incrementCounter(channel, counterName, delta);
    if (newCount === null) {
      client.say(channel, `Ошибка обновления счетчика 😱`, userState["id"]);
      return 1;
    }
    this.counters[channel][counterName] = newCount;
    client.say(channel, `Счетчик #${counterName}: ${newCount} ✅`, userState["id"]);
    return 1;
  }
}

class CustomCommands {
    // How often the bot re-reads `custom_commands` to pick up edits made on the website. Short
    // enough that an edit on the panel feels live (same spirit as channelSettings' 5s TTL), long
    // enough to be a rounding error against chat volume: one indexed find per channel per tick.
    static REFRESH_INTERVAL_MS = 10 * 1000;

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
      // per-channel map of cmdName -> active setTimeout handle for the timer-driven auto-send
      this.commandTimers = {};
      this.client = null;
      // per-channel count of ordinary (non-bot) chat messages seen since the last
      // auto-send; reset to 0 on every auto-send so it also enforces "no two
      // consecutive automated messages" regardless of which command fires.
      this.messagesSinceLastAuto = {};
      // how often a gated auto-send (offline stream / chat too quiet) re-checks,
      // instead of waiting out a full command timer period
      this.autoSendRetryMs = 30 * 1000;
      // Handle for the periodic re-read that picks up edits made on the website (see
      // refreshFromDatabase). Armed by startCommandTimers(), which index.js calls once at startup.
      this.refreshInterval = null;
      this.updateCustomCommands();
    }
    
    updateCustomCommands = async () =>
    {
      for (var ch of this.channelsList) {
        this.CommandsDict[ch] = await ChatStats.getAllCommands(ch);
        this.CommandsKeysList[ch] = Object.keys(this.CommandsDict[ch]).sort((a,b) => b.length - a.length);
      }
    }

    // Only the parts of a command that affect the AUTO-SEND SCHEDULE. Used to decide whether a
    // refresh has to rebuild the timers, because rebuilding is not free: scheduleChannelCommands()
    // re-staggers the whole channel, so doing it on every poll would keep resetting the phase of
    // commands whose timers never changed, and they'd drift instead of firing on their period.
    // Command TEXT can change freely without any of that.
    timerSignature = (commands) =>
      Object.keys(commands)
        .sort()
        .map((name) => `${name}:${commands[name].timer ?? ''}:${commands[name].pin ? 1 : 0}`)
        .join('|');

    // Picks up edits made OUTSIDE this process - i.e. on the TwitchBot-Web control panel, which
    // writes the same `custom_commands` collection.
    //
    // Why a poll and not the lazy TTL that config/channelSettings.js uses: that pattern refreshes
    // on READ, which is fine for settings (every message reads them) but not for commands. A
    // command added on the website with a timer has to start auto-sending even if nobody ever
    // types anything in chat - and with a read-triggered refresh there'd be no read to trigger it.
    // So this is a small periodic re-read (one indexed find per channel), and it costs nothing
    // when nothing changed.
    refreshFromDatabase = async () =>
    {
      for (const ch of this.channelsList) {
        try {
          const fresh = await ChatStats.getAllCommands(ch);
          const before = this.timerSignature(this.CommandsDict[ch] || {});
          const after = this.timerSignature(fresh);

          this.CommandsDict[ch] = fresh;
          this.CommandsKeysList[ch] = Object.keys(fresh).sort((a, b) => b.length - a.length);

          if (before !== after) {
            this.scheduleChannelCommands(ch);
            console.log(`[CustomCommands] ${ch}: timer schedule changed externally, rebuilt`);
          }
        } catch (err) {
          // Never let a failed refresh kill the interval - the cache just stays as it was.
          console.error(`[CustomCommands] refresh failed for ${ch}:`, err.message);
        }
      }
      // Counters are web-editable too (/<channel>/counters) - refresh them on the same tick.
      await this.counter.refreshFromDatabase();
    }

    startAutoRefresh = () =>
    {
      if (this.refreshInterval) return;
      this.refreshInterval = setInterval(
        () => this.refreshFromDatabase().catch((err) => console.error('[CustomCommands] refresh error:', err)),
        CustomCommands.REFRESH_INTERVAL_MS
      );
      // Don't hold the event loop open - standalone scripts that require this module must exit.
      this.refreshInterval.unref?.();
    }

    stopAutoRefresh = () =>
    {
      if (this.refreshInterval) clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    addCommand = async(client, channel, userState, message) =>
    {
      if (!isMod(userState)) {return 0;}
      const settings = channelSettings.getSettings(channel);
      if (!settings.commands.addcommand.enabled) return 0;
      var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'addcommand', '!([a-zа-я0-9]+) (.+)'));
      if (!res)
      {
        if (message.startsWith(settings.commands.addcommand.signature)) {
          client.say(channel, `Неверный формат команды 😱 Используйте: ${settings.commands.addcommand.signature} !command_name "command_result" 😎`, userState["id"]);
          return 1;
        }
        return 0;
      }
      var newCommand = res[1];
      var CommandResult = res[2];
      if (! await ChatStats.isCommandExist(channel, newCommand)){
        ChatStats.addNewCustomCommand(channel, newCommand, CommandResult);
        this.CommandsDict[channel][newCommand] = {result: CommandResult, timer: null, pin: false};
        this.CommandsKeysList[channel] = Object.keys(this.CommandsDict[channel]).sort((a,b) => b.length - a.length);
        client.say(channel, `Команда успешно добавлена ✅`, userState["id"]);
        return 1;
      }
      // изменить существующую команду (текст) — таймер и настройка автозакрепления
      // (!settimer/!setpin), если были настроены ранее, сохраняются, чтобы правка
      // текста не отключала их
      var existingTimer = this.CommandsDict[channel][newCommand]?.timer ?? null;
      var existingPin = this.CommandsDict[channel][newCommand]?.pin ?? false;
      ChatStats.editCustomCommand(channel, newCommand, CommandResult, existingTimer, existingPin);
      this.CommandsDict[channel][newCommand] = {result: CommandResult, timer: existingTimer, pin: existingPin};
      this.CommandsKeysList[channel] = Object.keys(this.CommandsDict[channel]).sort((a,b) => b.length - a.length);
      client.say(channel, `command updated ✅`, userState["id"]);
      return 1;
    }

    setCommandTimer = async(client, channel, userState, message) =>
    {
      if (!isMod(userState)) {return 0;}
      const settings = channelSettings.getSettings(channel);
      if (!settings.commands.settimer.enabled) return 0;
      var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'settimer', '!([a-zа-я0-9]+) (\\d+|off)'));
      if (!res) {
        if (message.startsWith(settings.commands.settimer.signature)) {
          client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.settimer.signature} !command_name <секунды>|off 😎`, userState["id"]);
          return 1;
        }
        return 0;
      }
      var cmdName = res[1];
      if (!this.CommandsDict[channel] || !this.CommandsDict[channel][cmdName]) {
        client.say(channel, `такой команды не существует 🤷‍♂️`, userState["id"]);
        return 1;
      }
      const MIN_TIMER_SECONDS = 60;
      var newTimerSeconds = res[2] === "off" ? null : parseInt(res[2], 10);
      if (newTimerSeconds !== null && newTimerSeconds < MIN_TIMER_SECONDS) {
        client.say(channel, `Минимальный таймер: ${MIN_TIMER_SECONDS} секунд 😱`, userState["id"]);
        return 1;
      }
      var existingPin = this.CommandsDict[channel][cmdName]["pin"] ?? false;
      // timer + pin can't coexist - pin fires on every auto-post, and Twitch only
      // allows one active pinned message per channel at a time
      if (newTimerSeconds !== null && existingPin) {
        client.say(channel, `Нельзя включить таймер для !${cmdName}, пока включено автозакрепление (${settings.commands.setpin.signature} !${cmdName} off) 😱`, userState["id"]);
        return 1;
      }
      var newTimer = newTimerSeconds === null ? null : newTimerSeconds * 1000;
      var existingResult = this.CommandsDict[channel][cmdName]["result"];
      ChatStats.editCustomCommand(channel, cmdName, existingResult, newTimer, existingPin);
      this.CommandsDict[channel][cmdName] = {result: existingResult, timer: newTimer, pin: existingPin};
      // timer membership/period changed for this channel - recompute the stagger for the whole group
      this.scheduleChannelCommands(channel);
      client.say(channel, newTimer
        ? `Таймер для !${cmdName} установлен: ${newTimerSeconds} сек ✅`
        : `Таймер для !${cmdName} отключен ✅`, userState["id"]);
      return 1;
    }

    setCommandPin = async(client, channel, userState, message) =>
    {
      if (!isMod(userState)) {return 0;}
      const settings = channelSettings.getSettings(channel);
      if (!settings.commands.setpin.enabled) return 0;
      var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'setpin', '!([a-zа-я0-9]+) (on|off)'));
      if (!res) {
        if (message.startsWith(settings.commands.setpin.signature)) {
          client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.setpin.signature} !command_name on|off 😎`, userState["id"]);
          return 1;
        }
        return 0;
      }
      var cmdName = res[1];
      if (!this.CommandsDict[channel] || !this.CommandsDict[channel][cmdName]) {
        client.say(channel, `такой команды не существует 🤷‍♂️`, userState["id"]);
        return 1;
      }
      var newPin = res[2] === "on";
      var existingResult = this.CommandsDict[channel][cmdName]["result"];
      var existingTimer = this.CommandsDict[channel][cmdName]["timer"];
      // timer + pin can't coexist - see setCommandTimer
      if (newPin && existingTimer) {
        client.say(channel, `Нельзя включить автозакрепление для !${cmdName}, пока включен таймер (${settings.commands.settimer.signature} !${cmdName} off) 😱`, userState["id"]);
        return 1;
      }
      ChatStats.editCustomCommand(channel, cmdName, existingResult, existingTimer, newPin);
      this.CommandsDict[channel][cmdName] = {result: existingResult, timer: existingTimer, pin: newPin};
      client.say(channel, newPin
        ? `Команда !${cmdName} теперь автоматически закрепляется в чате (только для модераторов) ✅`
        : `Автозакрепление для !${cmdName} отключено ✅`, userState["id"]);
      return 1;
    }

  deleteCustomCommand = async(client, channel, userState, message) =>
  {
    if (!isMod(userState)) {return 0;}
    const settings = channelSettings.getSettings(channel);
    if (!settings.commands.delcommand.enabled) return 0;
    var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'delcommand', '!([a-zа-я0-9]+)'));
    if (!res) {
      if (message.startsWith(settings.commands.delcommand.signature)) {
        client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.delcommand.signature} !command_name 😎`, userState["id"]);
        return 1;
      }
      return 0;
    }
    if (! await ChatStats.isCommandExist(channel, res[1]))
    {
      client.say(channel, `такой команды не существует 🤷‍♂️`, userState["id"]);
      return 1;
    }
    ChatStats.deleteCustomCommand(channel, res[1]);
    delete this.CommandsDict[channel][res[1]];
    this.CommandsKeysList[channel] = Object.keys(this.CommandsDict[channel]).sort((a,b) => b.length - a.length);
    this.scheduleChannelCommands(channel);
    client.say(channel, `Команда удалена! ❌`, userState["id"]);
    return 1;
  }

  substituteCounters = (channel, commandResult) =>
  {
    var res = commandResult.match(/#([a-zа-я0-9]+)/g);
    if (res){
      for(const wordReplace of res) {
        if(counter.counterKeysList[channel].includes(wordReplace.substring(1))){
          commandResult = commandResult.replace(wordReplace, counter.counters[channel][wordReplace.substring(1)].toString());
        }
      }
    }
    return commandResult;
  }

  exex_custom_command = async(client, channel, userState, message) =>
  {
    for (const cmd of this.CommandsKeysList[channel]) {
      if (message.toLocaleLowerCase().startsWith(`!${cmd}`)) {
        var cmdData = this.CommandsDict[channel][cmd];
        // pin-on-send is a moderation action (it replaces the channel's single
        // active pin) - only mods, who could pin manually anyway, may trigger it
        if (cmdData.pin && !isMod(userState)) return 1;
        if (!isTimerReady(this.lastCustomCommand, this.customCommandsTimer)) return 1;
        var commandResult = this.substituteCounters(channel, cmdData["result"]);
        var messageId = await client.say(channel, commandResult);
        if (cmdData.pin && messageId) {
          var broadcasterId = this.getBroadcasterId(channel);
          if (broadcasterId) TwitchChatAPI.pinMessage(broadcasterId, messageId);
        }
        this.lastCustomCommand = new Date().getTime();
        // someone just said it in chat - push the next auto-send a full period out
        // from now instead of letting it fire again shortly after
        this.resetCommandTimer(channel, cmd);
        return 1;
      }
    }
    return 0;
  }

  // Every ordinary (non-bot) chat message counts toward the "chat is active enough"
  // gate. Called from index.js's chat handler for every message that also gets
  // logged to ChatStats.
  recordChatMessage = (channel) =>
  {
    this.messagesSinceLastAuto[channel] = (this.messagesSinceLastAuto[channel] || 0) + 1;
  }

  getBroadcasterId = (channel) =>
  {
    const login = channelSettings.normalizeChannel(channel);
    return botInitInfo.channels[login]?.id;
  }

  // Gate an auto-send on (a) the stream being live - skipped in debug mode so local
  // testing doesn't need a real live stream - and (b) enough ordinary chat activity
  // having happened since the last auto-send (also what prevents two automated
  // messages from landing back-to-back, since a send always resets the count to 0).
  canAutoSend = (channel) =>
  {
    if (botInitInfo.settings["debug"]) return true;
    if (!streamStatus.isLive(this.getBroadcasterId(channel))) {
      return false;
    }
    const minMessages = channelSettings.getSettings(channel).commands.customCommandTimer.minMessagesBetween;
    return (this.messagesSinceLastAuto[channel] || 0) >= minMessages;
  }

  // Arms (or re-arms) the single auto-send timeout for one command, replacing whatever
  // was previously scheduled for it. Firing sends the message, then re-arms itself for
  // the command's *current* timer value (read fresh, so a !settimer change or deletion
  // that happens between now and the next fire is picked up automatically). If the
  // stream is offline or chat's been too quiet, it defers to a short retry instead of
  // sending or waiting out a full period.
  scheduleCommand = (channel, cmdName, delay) =>
  {
    if (!this.commandTimers[channel]) this.commandTimers[channel] = {};
    if (this.commandTimers[channel][cmdName]) {
      clearTimeout(this.commandTimers[channel][cmdName]);
    }
    this.commandTimers[channel][cmdName] = setTimeout(async () => {
      const cmd = this.CommandsDict[channel] && this.CommandsDict[channel][cmdName];
      const timerMs = cmd ? parseInt(cmd.timer, 10) : NaN;
      if (!cmd || !timerMs || timerMs <= 0) {
        delete this.commandTimers[channel][cmdName];
        return;
      }
      if (!this.canAutoSend(channel)) {
        this.scheduleCommand(channel, cmdName, this.autoSendRetryMs);
        return;
      }
      const messageId = await this.client.say(channel, this.substituteCounters(channel, cmd.result));
      if (cmd.pin && messageId) {
        const broadcasterId = this.getBroadcasterId(channel);
        if (broadcasterId) TwitchChatAPI.pinMessage(broadcasterId, messageId);
      }
      this.messagesSinceLastAuto[channel] = 0;
      this.scheduleCommand(channel, cmdName, timerMs);
    }, delay);
  }

  // A manual chat trigger counts as a send too - push the pending auto-send out a full
  // period from now instead of leaving the earlier (pre-trigger) schedule in place, which
  // would otherwise repeat text chat just said moments ago.
  resetCommandTimer = (channel, cmdName) =>
  {
    if (!this.client) return;
    const cmd = this.CommandsDict[channel] && this.CommandsDict[channel][cmdName];
    const timerMs = cmd ? parseInt(cmd.timer, 10) : NaN;
    if (!cmd || !timerMs || timerMs <= 0) return;
    this.scheduleCommand(channel, cmdName, timerMs);
  }

  // Rebuilds the entire auto-send schedule for a channel. Commands sharing the exact same
  // `timer` period are spread evenly across that period (stagger = period / groupSize) so
  // e.g. two commands both on a 2-minute timer end up 1 minute apart instead of firing
  // together. Called on startup and whenever a channel's timer-command membership/period
  // changes (!settimer, !delcommand).
  scheduleChannelCommands = (channel) =>
  {
    if (!this.client) return;
    if (this.commandTimers[channel]) {
      for (const handle of Object.values(this.commandTimers[channel])) {
        clearTimeout(handle);
      }
    }
    this.commandTimers[channel] = {};

    const commands = this.CommandsDict[channel] || {};
    const groups = new Map(); // timerMs -> [cmdName, ...]
    for (const cmdName of Object.keys(commands)) {
      const timerMs = parseInt(commands[cmdName].timer, 10);
      if (!timerMs || timerMs <= 0) continue;
      if (!groups.has(timerMs)) groups.set(timerMs, []);
      groups.get(timerMs).push(cmdName);
    }

    for (const [timerMs, cmdNames] of groups) {
      const stagger = timerMs / cmdNames.length;
      cmdNames.forEach((cmdName, i) => {
        this.scheduleCommand(channel, cmdName, Math.round(stagger * i));
      });
    }
  }

  startCommandTimers = (client) =>
  {
    this.client = client;
    for (const ch of this.channelsList) {
      this.scheduleChannelCommands(ch);
    }
    // Commands can also be created/edited/deleted on the TwitchBot-Web panel, which writes the
    // same collection. Without this, those edits would only reach the running bot on a restart.
    this.startAutoRefresh();
  }

  stopCommandTimers = () =>
  {
    for (const ch of Object.keys(this.commandTimers)) {
      for (const handle of Object.values(this.commandTimers[ch])) {
        clearTimeout(handle);
      }
    }
    this.commandTimers = {};
    this.stopAutoRefresh();
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

