const {isMod} = require("../shared/isMod.js");
const ChatStats = require('../db/chatStats.js');
const {isTimerReady} = require("../shared/timer.js");
const botInitInfo = require("../botInitInfo.js");
const channelSettings = require("../config/channelSettings.js");
const streamStatus = require("../twitch/streamStatus.js");
const TwitchChatAPI = require("../twitch/TwitchChatAPI.js");
const { parseMentionRedirect, sayMaybeMention } = require("../shared/mentionRedirect.js");
const VariableTemplate = require("../shared/variableTemplate.js");
const { parseArgs, sanitizeArg, assembleMessage, MAX_ARGS_LENGTH } = require("../shared/variableArgs.js");

// A variable name as chat types it after "#" - the rule itself (and why it is lowercase-only)
// lives in shared/variableTemplate.js, next to the template grammar that reads the same names.
const VARIABLE_NAME = `[${VariableTemplate.USER_NAME_CHARS}]+`;
// "#name + N" / "#name - N" at the very start of a message, and bare "#name" (= + 1).
const VARIABLE_UPDATE_RE = new RegExp(`^#(${VARIABLE_NAME}) (\\+|-) ([0-9]+)`);
const VARIABLE_BUMP_RE = new RegExp(`^#(${VARIABLE_NAME})`);

class Variables {
  constructor()
  {
    // channel -> {name: value}
    this.values = {};
    // channel -> {name: "all" | "mods"}
    this.variableAccess = {};
    // channel -> names, longest first
    this.variableKeysList = {};
    this.channelsList = [];
    // Shared per-channel set of usernames exempt from mod-only variable access
    // checks - one list per channel, used by every variable/custom command in
    // that channel rather than tracked separately per variable.
    this.customCommandExceptions = {};
    // Per "channel variableName" last-update timestamp, used to enforce a short
    // cooldown between updates to the same variable (see updateVariable).
    this.lastVariableUpdate = new Map();
    for (var ch of Object.keys(botInitInfo.channels))
    {
      this.channelsList.push("#"+ch);
    }
    this.updateVariables();
    this.updateCustomCommandExceptions();
  }

  // Replaces one channel's in-memory snapshot with what `variables` holds now.
  loadChannelVariables = async (ch) =>
  {
    const variables = await ChatStats.getAllVariables(ch);
    this.values[ch] = {};
    this.variableAccess[ch] = {};
    for (const [name, data] of Object.entries(variables)) {
      this.values[ch][name] = data.value;
      this.variableAccess[ch][name] = data.access;
    }
    this.rebuildKeysList(ch);
  }

  rebuildKeysList = (ch) =>
  {
    this.variableKeysList[ch] = Object.keys(this.values[ch]).sort((a,b) => b.length - a.length);
  }

  updateVariables = async () =>
  {
    for (var ch of this.channelsList) {
      await this.loadChannelVariables(ch);
    }
  }

  updateCustomCommandExceptions = async () =>
  {
    for (var ch of this.channelsList) {
      this.customCommandExceptions[ch] = new Set(await ChatStats.getCustomCommandExceptions(ch));
    }
  }

  // Brings a channel joined after boot (see twitch/channelJoinScheduler.js) up to the same state
  // the constructor gives every channel known at startup. Without this, values/variableAccess/
  // variableKeysList have no entry for the channel and renderCommandText/updateVariable throw the
  // first time chat mentions a #variable there. No-op if the channel is already tracked.
  addChannel = async (channel) =>
  {
    if (this.channelsList.includes(channel)) return;
    this.channelsList.push(channel);
    await this.loadChannelVariables(channel);
    this.customCommandExceptions[channel] = new Set(await ChatStats.getCustomCommandExceptions(channel));
  }

  // Picks up variable edits made OUTSIDE this process - the TwitchBot-Web panel's
  // /<channel>/variables page writes the same `variables` collection. Called from
  // CustomCommands.refreshFromDatabase on its 10s tick. Overwriting the in-memory
  // snapshot with fresh DB values can never lose an increment (chat updates go through
  // an atomic $inc and write the returned value back) - at worst a #name substitution
  // shows a ≤10s-stale number, the same staleness class as command text.
  refreshFromDatabase = async () =>
  {
    for (const ch of this.channelsList) {
      try {
        await this.loadChannelVariables(ch);
      } catch (err) {
        // Never let a failed refresh kill the interval - the cache just stays as it was.
        console.error(`[Variables] refresh failed for ${ch}:`, err.message);
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

  addVariable = async(client, channel, userState, message) =>
  {
    if (!isMod(userState)) {return 0;}
    const settings = channelSettings.getSettings(channel);
    if (!settings.commands.addvar.enabled) return 0;
    var access = "all";
    var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'addvar', `#(${VARIABLE_NAME})`));
    if (!res)
    {
      if (message.startsWith(settings.commands.addvar.signature)) {
        client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.addvar.signature} #имя [mod] 😎`, userState["id"]);
        return 1;
      }
      return 0;
    }
    var newVariable = res[1];
    // Built-in names are reserved: a channel variable would win over the built-in (see
    // shared/variableTemplate.js's checkVariable), so letting one be created here would quietly
    // switch #username or #rand off in every command of the channel.
    if (VariableTemplate.isBuiltin(newVariable)) {
      client.say(channel, `#${newVariable} — это имя встроенной переменной, выберите другое 🤷‍♂️`, userState["id"]);
      return 1;
    }
    if(message.match(channelSettings.getCommandSignatureArgRegex(channel, 'addvar', `#(${VARIABLE_NAME}) mod`))){
      var access = "mods";
    }
    // An existing name is still this command's message: answering it and stopping the chain is
    // what every other branch here does. Falling through used to mean no reply at all, and the
    // rest of the handlers getting a look at "!addvar #x".
    // Asked of the insert itself (the unique index), not of the in-memory mirror: the mirror can
    // be up to 10s behind a site edit and would call a just-deleted name "taken".
    const created = await ChatStats.addNewVariable(channel, newVariable, access);
    if (created === false) {
      client.say(channel, `Переменная #${newVariable} уже существует 🤷‍♂️`, userState["id"]);
      return 1;
    }
    if (created === null) {
      client.say(channel, `Ошибка создания переменной 😱`, userState["id"]);
      return 1;
    }
    this.values[channel][newVariable] = 0;
    this.variableAccess[channel][newVariable] = access;
    this.rebuildKeysList(channel);
    client.say(channel, `Новая переменная успешно добавлена ✅`, userState["id"]);
    return 1;
  }

  // Matched through the channel's configured signature at the start of the message, like every
  // other built-in, and returns 1 once answered so the chain stops and CommandExecutionStats counts it.
  listVariables = async(client, channel, userState, message) =>
  {
    const settings = channelSettings.getSettings(channel);
    if (!settings.commands.vars.enabled) return 0;
    if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'vars'))) return 0;
    if (!isMod(userState)) {return 0;}
    client.say(channel, `[${this.variableKeysList[channel].toString()}]`);
    return 1;
  }

  deleteVariable = async(client, channel, userState, message) =>
  {
    if (!isMod(userState)) {return 0;}
    const settings = channelSettings.getSettings(channel);
    if (!settings.commands.delvar.enabled) return 0;
    var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'delvar', `#(${VARIABLE_NAME})`));
    if (!res) {
      if (message.startsWith(settings.commands.delvar.signature)) {
        client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.delvar.signature} #имя 😎`, userState["id"]);
        return 1;
      }
      return 0;
    }
    const removed = await ChatStats.deleteVariable(channel, res[1]);
    if (removed === false)
    {
      client.say(channel, `такой переменной не существует 🤷‍♂️`, userState["id"]);
      return 1;
    }
    if (removed === null) {
      client.say(channel, `Ошибка удаления переменной 😱`, userState["id"]);
      return 1;
    }
    delete this.values[channel][res[1]];
    delete this.variableAccess[channel][res[1]];
    this.rebuildKeysList(channel);
    client.say(channel, `Переменная удалена! ❌`, userState["id"]);
    return 1;
  }

  updateVariable = async(client, channel, userState, message) =>
  {
    var res = message.match(VARIABLE_UPDATE_RE);
    if (!!res) {
      var variableName = res[1];
      var operation = res[2];
      var value = parseInt(res[3]);
    } else if (res = message.match(VARIABLE_BUMP_RE)) {
      var variableName = res[1];
      var operation = "+";
      var value = 1;
    } else {return 0;}
    if (!this.variableKeysList[channel].includes(variableName)) {return 1;}
    var access = this.variableAccess[channel][variableName];
    if (access == 'mods' && !isMod(userState) && !this.isCustomCommandException(channel, userState)) {return 1;}

    // Chat has real-world latency: two people can both go to update the same
    // variable within a few seconds of each other without having seen the
    // other's message land yet, and end up double-updating it by accident.
    // A short per-variable cooldown (not a lock - the second attempt is just
    // rejected outright) avoids that instead of trying to serialize genuinely
    // concurrent writes.
    var cooldownMs = channelSettings.getSettings(channel).commands.varUpdate.cooldownMs;
    var cooldownKey = `${channel} ${variableName}`;
    if (!isTimerReady(this.lastVariableUpdate.get(cooldownKey) || 0, cooldownMs)) {
      client.say(channel, `Переменную #${variableName} уже обновляли только что, подождите немного`, userState["id"]);
      return 1;
    }
    this.lastVariableUpdate.set(cooldownKey, Date.now());

    var delta = operation === "+" ? value : -value;
    var newValue = await ChatStats.incrementVariable(channel, variableName, delta);
    if (newValue === null) {
      client.say(channel, `Ошибка обновления переменной 😱`, userState["id"]);
      return 1;
    }
    this.values[channel][variableName] = newValue;
    client.say(channel, `Переменная #${variableName}: ${newValue} ✅`, userState["id"]);
    return 1;
  }
}

class CustomCommands {
    // How often the bot re-reads `custom_commands` to pick up edits made on the website. Short
    // enough that an edit on the panel feels live (same spirit as channelSettings' 5s TTL), long
    // enough to be a rounding error against chat volume: one indexed find per channel per tick.
    static REFRESH_INTERVAL_MS = 10 * 1000;

    constructor(variables) {
      // Timer - keyed per "channel commandName" (the CANONICAL name, so a command's aliases share
      // one cooldown with it rather than each getting a free extra trigger), same convention as
      // Variables' lastVariableUpdate above. It was per-channel until this, and before that a single
      // scalar shared across every channel; both meant one command's cooldown silently blocked
      // unrelated ones - triggering !discord made !youtube unavailable for the next 10s.
      this.customCommandsTimer = 10 * 1000; // 10 sec
      this.lastCustomCommand = new Map();
      //connect variables
      this.variables = variables;
      // custom commands
      this.CommandsKeysList = {};
      this.CommandsDict = {};
      // per-channel map of trigger (command name OR alias) -> canonical command name, built
      // alongside CommandsKeysList by rebuildTriggerIndex whenever CommandsDict changes.
      this.CommandTriggerMap = {};
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
        this.rebuildTriggerIndex(ch);
      }
    }

    // Rebuilds CommandsKeysList/CommandTriggerMap for one channel from its current CommandsDict.
    // A "trigger" is anything typed in chat that should fire a command: the command's own name,
    // or one of its web-panel-only aliases (see TwitchBot-Web's lib/commandValidation.js). Both
    // are matched with the same startsWith-prefix logic in exex_custom_command, so they're merged
    // into one longest-first list; CommandTriggerMap resolves whichever trigger matched back to
    // the canonical command name that owns the actual command data.
    //
    // On an alias/name collision (shouldn't happen - the web panel and every chat write path
    // reject it - but a stale/hand-edited doc could still produce one) the first command visited
    // wins the trigger and the loser's alias is silently unreachable, rather than throwing.
    rebuildTriggerIndex = (channel) =>
    {
      const commands = this.CommandsDict[channel] || {};
      const triggerMap = {};
      for (const [name, data] of Object.entries(commands)) {
        if (!(name in triggerMap)) triggerMap[name] = name;
        for (const alias of data.aliases || []) {
          if (!(alias in triggerMap)) triggerMap[alias] = name;
        }
      }
      this.CommandTriggerMap[channel] = triggerMap;
      this.CommandsKeysList[channel] = Object.keys(triggerMap).sort((a, b) => b.length - a.length);
    }

    // Only the parts of a command that affect the AUTO-SEND SCHEDULE. Used to decide whether a
    // refresh has to rebuild the timers, because rebuilding is not free: scheduleChannelCommands()
    // re-staggers the whole channel, so doing it on every poll would keep resetting the phase of
    // commands whose timers never changed, and they'd drift instead of firing on their period.
    // `enabled` is included because scheduleChannelCommands() excludes disabled commands from the
    // schedule entirely - toggling it on/off has to rebuild just like a timer change would.
    // Command TEXT (including per-category overrides) can change freely without any of that.
    timerSignature = (commands) =>
      Object.keys(commands)
        .sort()
        .map((name) => `${name}:${commands[name].timer ?? ''}:${commands[name].pin ? 1 : 0}:${commands[name].enabled === false ? 0 : 1}`)
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
          this.rebuildTriggerIndex(ch);

          if (before !== after) {
            this.scheduleChannelCommands(ch);
            console.log(`[CustomCommands] ${ch}: timer schedule changed externally, rebuilt`);
          }
        } catch (err) {
          // Never let a failed refresh kill the interval - the cache just stays as it was.
          console.error(`[CustomCommands] refresh failed for ${ch}:`, err.message);
        }
      }
      // Variables are web-editable too (/<channel>/variables) - refresh them on the same tick.
      await this.variables.refreshFromDatabase();
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
        this.CommandsDict[channel][newCommand] = {result: CommandResult, timer: null, pin: false, announce: false, announceColor: "primary", enabled: true, categoryTexts: [], modOnly: false, aliases: []};
        this.rebuildTriggerIndex(channel);
        client.say(channel, `Команда успешно добавлена ✅`, userState["id"]);
        return 1;
      }
      // изменить существующую команду (текст) — таймер, автозакрепление (!settimer/!setpin),
      // объявление (!setannounce), состояние включена/выключена, текст по категориям стрима,
      // ограничение только для модераторов и синонимы (настраиваются только на сайте), если были
      // настроены ранее, сохраняются, чтобы правка текста не сбрасывала их
      var existingTimer = this.CommandsDict[channel][newCommand]?.timer ?? null;
      var existingPin = this.CommandsDict[channel][newCommand]?.pin ?? false;
      var existingAnnounce = this.CommandsDict[channel][newCommand]?.announce ?? false;
      var existingAnnounceColor = this.CommandsDict[channel][newCommand]?.announceColor ?? "primary";
      var existingEnabled = this.CommandsDict[channel][newCommand]?.enabled ?? true;
      var existingCategoryTexts = this.CommandsDict[channel][newCommand]?.categoryTexts ?? [];
      var existingModOnly = this.CommandsDict[channel][newCommand]?.modOnly ?? false;
      var existingAliases = this.CommandsDict[channel][newCommand]?.aliases ?? [];
      ChatStats.editCustomCommand(channel, newCommand, CommandResult, existingTimer, existingPin, existingAnnounce, existingAnnounceColor, existingEnabled, existingCategoryTexts, existingModOnly, existingAliases);
      this.CommandsDict[channel][newCommand] = {result: CommandResult, timer: existingTimer, pin: existingPin, announce: existingAnnounce, announceColor: existingAnnounceColor, enabled: existingEnabled, categoryTexts: existingCategoryTexts, modOnly: existingModOnly, aliases: existingAliases};
      this.rebuildTriggerIndex(channel);
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
      var existingAnnounce = this.CommandsDict[channel][cmdName]["announce"] ?? false;
      var existingAnnounceColor = this.CommandsDict[channel][cmdName]["announceColor"] ?? "primary";
      var existingEnabled = this.CommandsDict[channel][cmdName]["enabled"] ?? true;
      var existingCategoryTexts = this.CommandsDict[channel][cmdName]["categoryTexts"] ?? [];
      var existingModOnly = this.CommandsDict[channel][cmdName]["modOnly"] ?? false;
      var existingAliases = this.CommandsDict[channel][cmdName]["aliases"] ?? [];
      // timer + pin can't coexist - pin fires on every auto-post, and Twitch only
      // allows one active pinned message per channel at a time
      if (newTimerSeconds !== null && existingPin) {
        client.say(channel, `Нельзя включить таймер для !${cmdName}, пока включено автозакрепление (${settings.commands.setpin.signature} !${cmdName} off) 😱`, userState["id"]);
        return 1;
      }
      var newTimer = newTimerSeconds === null ? null : newTimerSeconds * 1000;
      var existingResult = this.CommandsDict[channel][cmdName]["result"];
      ChatStats.editCustomCommand(channel, cmdName, existingResult, newTimer, existingPin, existingAnnounce, existingAnnounceColor, existingEnabled, existingCategoryTexts, existingModOnly, existingAliases);
      this.CommandsDict[channel][cmdName] = {result: existingResult, timer: newTimer, pin: existingPin, announce: existingAnnounce, announceColor: existingAnnounceColor, enabled: existingEnabled, categoryTexts: existingCategoryTexts, modOnly: existingModOnly, aliases: existingAliases};
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
      var existingAnnounce = this.CommandsDict[channel][cmdName]["announce"] ?? false;
      var existingAnnounceColor = this.CommandsDict[channel][cmdName]["announceColor"] ?? "primary";
      var existingEnabled = this.CommandsDict[channel][cmdName]["enabled"] ?? true;
      var existingCategoryTexts = this.CommandsDict[channel][cmdName]["categoryTexts"] ?? [];
      var existingModOnly = this.CommandsDict[channel][cmdName]["modOnly"] ?? false;
      var existingAliases = this.CommandsDict[channel][cmdName]["aliases"] ?? [];
      // timer + pin can't coexist - see setCommandTimer
      if (newPin && existingTimer) {
        client.say(channel, `Нельзя включить автозакрепление для !${cmdName}, пока включен таймер (${settings.commands.settimer.signature} !${cmdName} off) 😱`, userState["id"]);
        return 1;
      }
      // announce + pin can't coexist - an announcement is a self-contained send with no
      // message id to pin, so combining the two doesn't map onto Twitch's API
      if (newPin && existingAnnounce) {
        client.say(channel, `Нельзя включить автозакрепление для !${cmdName}, пока включено объявление (${settings.commands.setannounce.signature} !${cmdName} off) 😱`, userState["id"]);
        return 1;
      }
      ChatStats.editCustomCommand(channel, cmdName, existingResult, existingTimer, newPin, existingAnnounce, existingAnnounceColor, existingEnabled, existingCategoryTexts, existingModOnly, existingAliases);
      this.CommandsDict[channel][cmdName] = {result: existingResult, timer: existingTimer, pin: newPin, announce: existingAnnounce, announceColor: existingAnnounceColor, enabled: existingEnabled, categoryTexts: existingCategoryTexts, modOnly: existingModOnly, aliases: existingAliases};
      client.say(channel, newPin
        ? `Команда !${cmdName} теперь автоматически закрепляется в чате (закрепление сработает, только если её вызвал модератор) ✅`
        : `Автозакрепление для !${cmdName} отключено ✅`, userState["id"]);
      return 1;
    }

    setCommandAnnounce = async(client, channel, userState, message) =>
    {
      if (!isMod(userState)) {return 0;}
      const settings = channelSettings.getSettings(channel);
      if (!settings.commands.setannounce.enabled) return 0;
      var res = message.match(channelSettings.getCommandSignatureArgRegex(channel, 'setannounce', '!([a-zа-я0-9]+) (on|off)'));
      if (!res) {
        if (message.startsWith(settings.commands.setannounce.signature)) {
          client.say(channel, `Неверный формат 😱 Используйте: ${settings.commands.setannounce.signature} !command_name on|off 😎`, userState["id"]);
          return 1;
        }
        return 0;
      }
      var cmdName = res[1];
      if (!this.CommandsDict[channel] || !this.CommandsDict[channel][cmdName]) {
        client.say(channel, `такой команды не существует 🤷‍♂️`, userState["id"]);
        return 1;
      }
      var newAnnounce = res[2] === "on";
      var existingResult = this.CommandsDict[channel][cmdName]["result"];
      var existingTimer = this.CommandsDict[channel][cmdName]["timer"];
      var existingPin = this.CommandsDict[channel][cmdName]["pin"] ?? false;
      var existingAnnounceColor = this.CommandsDict[channel][cmdName]["announceColor"] ?? "primary";
      var existingEnabled = this.CommandsDict[channel][cmdName]["enabled"] ?? true;
      var existingCategoryTexts = this.CommandsDict[channel][cmdName]["categoryTexts"] ?? [];
      var existingModOnly = this.CommandsDict[channel][cmdName]["modOnly"] ?? false;
      var existingAliases = this.CommandsDict[channel][cmdName]["aliases"] ?? [];
      // announce + pin can't coexist - see setCommandPin
      if (newAnnounce && existingPin) {
        client.say(channel, `Нельзя включить объявление для !${cmdName}, пока включено автозакрепление (${settings.commands.setpin.signature} !${cmdName} off) 😱`, userState["id"]);
        return 1;
      }
      ChatStats.editCustomCommand(channel, cmdName, existingResult, existingTimer, existingPin, newAnnounce, existingAnnounceColor, existingEnabled, existingCategoryTexts, existingModOnly, existingAliases);
      this.CommandsDict[channel][cmdName] = {result: existingResult, timer: existingTimer, pin: existingPin, announce: newAnnounce, announceColor: existingAnnounceColor, enabled: existingEnabled, categoryTexts: existingCategoryTexts, modOnly: existingModOnly, aliases: existingAliases};
      client.say(channel, newAnnounce
        ? `Команда !${cmdName} теперь отправляется как объявление в чате (цвет настраивается на сайте) ✅`
        : `Объявление для !${cmdName} отключено ✅`, userState["id"]);
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
    this.rebuildTriggerIndex(channel);
    this.scheduleChannelCommands(channel);
    client.say(channel, `Команда удалена! ❌`, userState["id"]);
    return 1;
  }

  // A command's text -> the message for chat, through shared/variableTemplate.js. `caller` is
  // {userState, args, mentionTarget} for a command someone typed and null for a timer's
  // auto-send, which has nobody: per-caller built-ins are then empty, or their fallback text.
  // Returns "" when nothing is left to send.
  renderCommandText = (channel, text, { caller = null, category = null, maxLength = VariableTemplate.MAX_MESSAGE_LENGTH } = {}) =>
  {
    const own = this.variables.values[channel] || {};
    const settings = channelSettings.getSettings(channel);
    const cleanOpts = {
      bannedWords: settings.bannedWords?.words || [],
      bannedRegex: channelSettings.getBannedWordsRegex(channel),
    };
    const resolve = (name, params) => {
      const check = VariableTemplate.checkVariable(name, params, Object.keys(own));
      if (!check.ok || check.kind === "unknown") return undefined;
      if (check.kind === "user") return String(own[name]);
      return this.resolveBuiltin(channel, name, params, { caller, category, cleanOpts });
    };
    const pieces = VariableTemplate.renderPieces(VariableTemplate.tokenize(text), resolve);
    return assembleMessage(pieces, maxLength);
  }

  // Values of the cheap built-ins: everything here is already in memory or in the message.
  // A viewer-supplied value is returned as {text, untrusted: true} so assembleMessage can refuse
  // to let it open the message with a command character.
  resolveBuiltin = (channel, name, params, { caller, category, cleanOpts }) =>
  {
    const orFallback = (value) => (value ? value : (params || ""));
    const viewer = (raw, maxLength) => {
      const value = sanitizeArg(raw, { ...cleanOpts, maxLength });
      return value ? { text: value, untrusted: true } : (params || "");
    };
    const displayName = (userState) => userState["display-name"] || userState["username"] || "";

    const argMatch = name.match(/^argument([1-9])$/);
    if (argMatch) {
      return caller ? viewer(caller.args.list[Number(argMatch[1]) - 1]) : orFallback("");
    }
    switch (name) {
      case "username":
        return caller ? orFallback(displayName(caller.userState)) : orFallback("");
      case "touser": {
        if (!caller) return orFallback("");
        const first = (caller.args.list[0] || "").replace(/^@+/, "");
        const fromArg = first ? sanitizeArg(first, cleanOpts) : "";
        if (fromArg) return { text: fromArg, untrusted: true };
        return orFallback(caller.mentionTarget || displayName(caller.userState));
      }
      case "args":
        return caller ? viewer(caller.args.tail, MAX_ARGS_LENGTH) : orFallback("");
      case "rand": {
        const { min, max } = VariableTemplate.parseRange(params);
        return String(min + Math.floor(Math.random() * (max - min + 1)));
      }
      case "pick": {
        const options = VariableTemplate.parsePick(params);
        return options[Math.floor(Math.random() * options.length)];
      }
      case "channel":
        return channel.replace(/^#/, "");
      case "game":
        return orFallback(category || "");
      // Server clock in the process's time zone - the same clock games/aiReply.js puts into the
      // model's prompt, so the bot never states two different times.
      case "time":
        return new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      case "date":
        return new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
      default:
        return undefined;
    }
  }

  // Picks the text to send: a category override whose name matches the stream's current Twitch
  // category (case-insensitive - mods type it freely on the web panel), or the command's plain
  // `result` for every other category (including offline/unknown, where streamStatus.getCategory
  // returns null). Web-panel-only feature - see lib/commandValidation.js on the TwitchBot-Web side.
  // Only commands that actually need the category to be current pay for a live Helix check
  // (streamStatus's cache is otherwise up to ActivitiTracker's 5-minute poll interval stale): those
  // with categoryTexts, and those that say #game - a mod switching category mid-stream and
  // immediately triggering the command used to get the old category back. Every other command
  // keeps reading the cheap cached value. -> {text, category}
  resolveCommandText = async (channel, cmdData) =>
  {
    const broadcasterId = this.getBroadcasterId(channel);
    const hasCategoryTexts = cmdData.categoryTexts && cmdData.categoryTexts.length;
    const texts = [cmdData.result, ...(cmdData.categoryTexts || []).map((ct) => ct.result)];
    const saysGame = texts.some((t) => VariableTemplate.tokenize(t).some((tok) => tok.type === "var" && tok.name === "game"));
    const category = hasCategoryTexts || saysGame
      ? await streamStatus.refreshCategory(broadcasterId)
      : streamStatus.getCategory(broadcasterId);
    if (category && hasCategoryTexts) {
      const override = cmdData.categoryTexts.find((ct) => ct.category.toLowerCase() === category.toLowerCase());
      if (override) return { text: override.result, category };
    }
    return { text: cmdData.result, category };
  }

  exex_custom_command = async(client, channel, userState, message) =>
  {
    // "@user !command" - redirects the reply to the mentioned user instead of whoever actually
    // typed the message - see shared/mentionRedirect.js for the full rationale (this is the
    // pattern's original home; other built-in commands in msgHandle.js reuse the same helper).
    const { mentionTarget, rest } = parseMentionRedirect(message);

    const lowerRest = rest.toLocaleLowerCase();
    for (const trigger of this.CommandsKeysList[channel]) {
      const prefix = `!${trigger}`;
      if (lowerRest.startsWith(prefix)) {
        // Require a word boundary right after the trigger - otherwise a short command name like
        // "hi" would spuriously fire on an unrelated longer word, e.g. someone typing "!history"
        // (".startsWith('!hi')" is true for "!history" too). The next character must be end-of-
        // string or whitespace, same fix as channelSettings.js's getCommandSignatureRegex.
        const nextChar = lowerRest.charAt(prefix.length);
        if (nextChar && !/\s/.test(nextChar)) continue;
        // trigger is either the command's own name or one of its aliases - resolve back to the
        // canonical name that CommandsDict actually keys its data under.
        var cmd = this.CommandTriggerMap[channel][trigger];
        var cmdData = this.CommandsDict[channel][cmd];
        // Disabled on the web panel - treat it as if the command didn't match at all, so a
        // shorter command name sharing a prefix still gets a chance to match.
        if (cmdData.enabled === false) continue;
        // `modOnly` gates whether the command can be triggered at all - a mod opts a command
        // into that explicitly (web-panel-only, like categoryTexts). Pin no longer gates
        // triggering by itself: a non-mod's `!name` on a pin-enabled command still sends the
        // text, it just doesn't pin it below - only the pin action itself stays mod-gated
        // (it replaces the channel's single active pin, so a non-mod repeatedly triggering it
        // must not be able to keep changing what's pinned).
        if (cmdData.modOnly && !isMod(userState)) return 1;
        // Cooldown is per command, not per channel: two different commands never block each other.
        var cooldownKey = `${channel} ${cmd}`;
        if (!isTimerReady(this.lastCustomCommand.get(cooldownKey) || 0, this.customCommandsTimer)) return 1;
        var { text, category } = await this.resolveCommandText(channel, cmdData);
        // Arguments are counted from "!trigger", so in "@user !command a b" the redirect stays
        // a redirect and "a" is still #argument1.
        var caller = { userState, args: parseArgs(rest.slice(prefix.length)), mentionTarget };
        // A plain reply redirected with "@user " is that much longer than what was rendered.
        var replyPrefixLength = !cmdData.announce && !cmdData.pin && mentionTarget ? mentionTarget.length + 2 : 0;
        var commandResult = this.renderCommandText(channel, text, {
          caller, category, maxLength: VariableTemplate.MAX_MESSAGE_LENGTH - replyPrefixLength,
        });
        // E.g. a text that is only "#argument1" and was called without one: nothing to say.
        if (!commandResult) return 1;
        if (cmdData.announce) {
          var broadcasterId = this.getBroadcasterId(channel);
          var sent = broadcasterId && await TwitchChatAPI.sendAnnouncement(broadcasterId, commandResult, cmdData.announceColor);
          if (!sent) await client.say(channel, commandResult);
        } else if (cmdData.pin) {
          var messageId = await client.say(channel, commandResult);
          if (isMod(userState) && messageId) {
            var broadcasterId = this.getBroadcasterId(channel);
            if (broadcasterId) TwitchChatAPI.pinMessage(broadcasterId, messageId);
          }
        } else {
          // Neither announce nor pin - reply to whoever triggered it (Twitch reply-threading),
          // or to the mentioned user via a plain @mention prefix if this was "@user !command".
          await sayMaybeMention(client, channel, mentionTarget, userState["id"], commandResult);
        }
        this.lastCustomCommand.set(cooldownKey, new Date().getTime());
        // Counted only here, after the answer went out: a call swallowed by modOnly, the cooldown
        // or an empty render did not make the bot say anything. Keyed by the canonical name, so
        // an alias counts toward its command. Shown on the site's command list.
        ChatStats.incrementCustomCommandUses(channel, cmd);
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
      // Disabled since this fire was scheduled (refreshFromDatabase rebuilds the whole schedule
      // on a signature change, but that poll is up to REFRESH_INTERVAL_MS behind a web edit) -
      // skip sending, but keep the timer alive so re-enabling resumes on schedule automatically.
      if (cmd.enabled === false) {
        this.scheduleCommand(channel, cmdName, timerMs);
        return;
      }
      if (!this.canAutoSend(channel)) {
        this.scheduleCommand(channel, cmdName, this.autoSendRetryMs);
        return;
      }
      const { text, category } = await this.resolveCommandText(channel, cmd);
      const commandResult = this.renderCommandText(channel, text, { caller: null, category });
      if (!commandResult) {
        this.scheduleCommand(channel, cmdName, timerMs);
        return;
      }
      if (cmd.announce) {
        const broadcasterId = this.getBroadcasterId(channel);
        const sent = broadcasterId && await TwitchChatAPI.sendAnnouncement(broadcasterId, commandResult, cmd.announceColor);
        if (!sent) await this.client.say(channel, commandResult);
      } else {
        // No pin check here: timer + pin are mutually exclusive at every write path
        // (setCommandTimer/setCommandPin below, commandValidation.js on the web side),
        // so a scheduled auto-post can never have cmd.pin set.
        await this.client.say(channel, commandResult);
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
      if (commands[cmdName].enabled === false) continue;
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
      // CommandsKeysList is triggers (names + aliases merged) - list canonical command names only,
      // or an alias would show up looking like its own separate command.
      client.say(channel, `custom commands: [${Object.keys(this.CommandsDict[channel])}]`);
      return 1;
    }
    return 0;
  }

  // Brings a channel joined after boot (see twitch/channelJoinScheduler.js) up to the same
  // state the constructor gives every channel known at startup: without an entry in
  // CommandsDict/CommandsKeysList, exex_custom_command's `for (const cmd of
  // this.CommandsKeysList[channel])` throws on the very first !-prefixed message from that
  // channel. If timers are already running (startCommandTimers was called), also schedules this
  // channel's auto-sends so a command with a timer doesn't just sit inert until the next
  // refreshFromDatabase tick notices it. No-op if the channel is already tracked.
  addChannel = async (channel) =>
  {
    if (this.channelsList.includes(channel)) return;
    this.channelsList.push(channel);
    this.CommandsDict[channel] = await ChatStats.getAllCommands(channel);
    this.rebuildTriggerIndex(channel);
    this.messagesSinceLastAuto[channel] = 0;
    if (this.client) this.scheduleChannelCommands(channel);
  }


}

const variables = new Variables();
const customCommands = new CustomCommands(variables);

module.exports = {
  variables,
  customCommands
};

