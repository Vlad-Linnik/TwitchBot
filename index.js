require("./shared/logger.js");
require("./shared/errorRingBuffer.js").install();
const botInitInfo = require("./botInitInfo.js");
const tmi = require("tmi.js");

// Deferred until after botInitInfo.loadChannels() resolves - several of these modules
// (games/*.js, commands/CustomCommands.js) pre-seed per-channel Maps by iterating
// Object.keys(botInitInfo.channels) at their own top level, so botInitInfo.channels
// must already be populated from Mongo by the time they're first required.
async function bootstrap() {
  await botInitInfo.loadChannels();

  const msgHandle = require("./commands/msgHandle.js");
  const ChatStats = require('./db/chatStats.js');
  const axios = require('axios');
  const TokenManager = require('./twitch/TokenManager.js');
  const eventSub = require('./twitch/events.js');
  const ActivityTracker = require('./twitch/ActivitiTracker.js');
  const moderators = require('./twitch/moderators.js');
  const { customCommands } = require('./commands/CustomCommands.js');
  const emoteSyncScheduler = require('./twitch/emoteSyncScheduler.js');
  const channelJoinScheduler = require('./twitch/channelJoinScheduler.js');
  const botHeartbeatRepo = require('./db/botHeartbeatRepo.js');
  const errorRingBuffer = require('./shared/errorRingBuffer.js');
  const describeError = require('./shared/describeError.js');

  // bot settings
  const opts = {
    options: {
      debug: botInitInfo.settings["debug"],
    },
    identity: {
      username: botInitInfo.settings["username"],
      password: botInitInfo.settings["password"],
    },
    channels: Object.keys(botInitInfo.channels),
  };

  // create bot instance
  const client = new tmi.client(opts);

  // overload client.say with new Helix API
  client.say = async (channel, message, replyParentMessageId) => {
    const normalizedChannel = channel.toLowerCase().replace('#', '');
    const broadcasterId = botInitInfo.channels[normalizedChannel].id;

    if (!broadcasterId) {
      console.error(`[API] Error msg send to ${channel}: ID is not exist.`);
      return;
    }

    try {
      const body = {
        broadcaster_id: broadcasterId,
        sender_id: botInitInfo.settings["bot_id"],
        message: message
      };
      if (replyParentMessageId) {
        body.reply_parent_message_id = replyParentMessageId;
      }
      const response = await axios.post('https://api.twitch.tv/helix/chat/messages',
        body,
        {
          headers: {
            'Authorization': `Bearer ${botInitInfo.settings["appAccessToken"]}`,
            'Client-Id': botInitInfo.settings["Client_Id"],
            'Content-Type': 'application/json'
          }
        }
      );
      if (opts.options.debug) console.log(`[API] msg sendet to #${normalizedChannel}`);
      return response.data?.data?.[0]?.message_id ?? null;
    } catch (error) {
      console.error('[API] Error msg:', describeError(error));
      return null;
    }
  };

  // Connection-liveness watchdog. tmi.js's own ping/pong reconnect logic should catch a dropped
  // connection on its own (~70s), but a genuinely zombied socket (TCP session dead at the network
  // level with no close/error ever firing) can leave the process technically alive - and since pm2
  // only restarts on process exit, that hangs forever until someone notices and restarts it by hand.
  // lastActivityAt is updated by any of chat/pong/connected, so a channel with quiet chat doesn't
  // false-positive: 'pong' alone keeps it fresh every ~60s as long as the connection is real.
  let lastActivityAt = Date.now();
  // Until tmi.js has connected even once there is no connection to call dead - see the two
  // deadlines below.
  let hasConnected = false;
  const markActivity = () => { lastActivityAt = Date.now(); };
  client.on('pong', markActivity);
  client.on('connected', () => {
    hasConnected = true;
    markActivity();
    console.log('[tmi] Connected to Twitch IRC.');
  });
  client.on('disconnected', (reason) => console.error('[tmi] Disconnected:', reason));
  client.on('reconnect', () => console.error('[tmi] Reconnecting to Twitch IRC...'));

  const HEARTBEAT_INTERVAL_MS = 30_000;
  const WATCHDOG_STALE_MS = 5 * 60 * 1000;
  // Startup gets its own, much longer deadline, because before the first connection the idle
  // check above isn't measuring a dead connection - it's measuring how long startup is taking,
  // and killing a process for being slow to start is how a temporary problem becomes a permanent
  // one. That's not hypothetical: on 2026-07-24 two un-timed-out token requests stalled ~130s
  // each (fixed with axios.defaults.timeout in botInitInfo.js), startup ran ~280s, and this
  // watchdog fired at 300s just before client.connect() finished - over and over, with pm2
  // dutifully restarting into the same wall. A process genuinely wedged before connecting still
  // needs the restart, hence a deadline rather than none, and a distinct message so the two
  // failures are never confused again in a log.
  const STARTUP_DEADLINE_MS = 15 * 60 * 1000;
  const startedAt = new Date();
  let prevCpuUsage = process.cpuUsage();
  let prevCpuAt = Date.now();

  setInterval(() => {
    const now = Date.now();
    const idleMs = now - lastActivityAt;
    const stale = hasConnected && idleMs > WATCHDOG_STALE_MS;
    const startupStalled = !hasConnected && (now - startedAt.getTime()) > STARTUP_DEADLINE_MS;

    const cpuDelta = process.cpuUsage(prevCpuUsage);
    const elapsedMs = now - prevCpuAt;
    const cpuPercent = elapsedMs > 0 ? ((cpuDelta.user + cpuDelta.system) / 1000 / elapsedMs) * 100 : 0;
    prevCpuUsage = process.cpuUsage();
    prevCpuAt = now;

    botHeartbeatRepo.writeHeartbeat({
      status: stale || startupStalled ? 'stale' : 'ok',
      pid: process.pid,
      startedAt,
      updatedAt: new Date(now),
      lastActivityAt: new Date(lastActivityAt),
      connectedChannels: Object.keys(botInitInfo.channels),
      memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      cpuPercent: Math.round(cpuPercent * 10) / 10,
      recentErrors: errorRingBuffer.getRecent(),
    }).catch((err) => console.error('[Heartbeat] write failed:', err.message));

    // Self-restart rather than trying to nurse tmi.js's internal state back to health - a
    // supervisor-level kill+respawn (pm2 picks this up as a normal process exit) is far more
    // reliable than attempting to manually reconnect a client that may be stuck in an unknown
    // internal state.
    if (stale) {
      console.error(`[Watchdog] No tmi.js activity for ${Math.round(idleMs / 1000)}s - connection appears dead. Exiting so pm2 restarts.`);
      process.exit(1);
    }
    if (startupStalled) {
      console.error(`[Watchdog] tmi.js never connected within ${Math.round((now - startedAt.getTime()) / 1000)}s of startup - exiting so pm2 restarts.`);
      process.exit(1);
    }
  }, HEARTBEAT_INTERVAL_MS);

  // main
  client.on("chat", async (channel, userState, message, self) => {
    const normalizedChannel = channel.toLowerCase().replace('#', '');
    markActivity();

    // Don't listen to my own messages..
    if (self) return;
    if (userState["user-id"] == botInitInfo.settings["bot_id"]) return;
    if (userState["username"].toLocaleLowerCase() == 'moobot') return;

    // Everything below touches Mongo/regex/external state per message across every channel this
    // bot serves - a single wrapping try/catch keeps a transient failure (e.g. a Mongo hiccup
    // inside one channel's !topchatters query) from becoming an unhandled rejection that takes
    // the whole process down for every channel. Node's default (unhandled-rejections=throw)
    // crashes the process on an uncaught rejection, and that failure wouldn't even reach
    // BotHeartbeat's error ring buffer (shared/errorRingBuffer.js only wraps console.error).
    try {
      // log msg
      if (!["moobot", "mistercopus_bot"].includes((userState["username"]).toLocaleLowerCase())) {
        ChatStats.addMessage(userState["user-id"], userState["username"], message, channel)
          .catch(err => console.error('[ChatStats] addMessage error:', err));
        // counts toward the "standard messages between automated commands" gate
        customCommands.recordChatMessage(channel);
      }

      // spam protection
      if (await msgHandle.spam_protection(client, channel, userState, message)) {
        return;
      }

      // ! commands
      if (message.match(/^!|^#/)) {
        // execCommands is async - must be awaited. An unawaited call here used to make this `if`
        // always truthy (a Promise is always truthy), so it "worked" by accident: every !/#
        // message returned early regardless of whether any handler actually matched.
        if (await msgHandle.execCommands(client, channel, userState, message)) {
          return;
        }
      }

      // direct msg to this bot
      if (message.toLowerCase().includes(botInitInfo.settings["username"].toLowerCase())) {
        if (msgHandle.directMsgCheck(client, channel, userState, message)) {
          return;
        }
      }

      //radom things
      msgHandle.randomEventsAndThings(client, channel, userState, message);
    } catch (err) {
      console.error(`[chat] handler error in ${channel}:`, describeError(err));
    }
  });

  // startup
  async function start() {
    // TokenManager owns client.opts.identity.password from here on - it sets it on every
    // successful refresh, not just this first one, so a reconnect hours later uses a live token.
    await TokenManager.start(client);
    // Resolve known bot logins -> ids (config/knownBots.js) so ChatStats can skip their
    // ModeratorStatistics/ModUpTimeStats writes. After TokenManager.start so the app token
    // its Helix lookup needs already exists; non-fatal on failure by design.
    await require('./config/knownBots.js').resolveKnownBotIds();
    for (let channel of Object.keys(botInitInfo.channels)) {
      // Seed the in-memory moderator cache from the DB before anything else for this channel
      // starts, so eventSub/ActivityTracker never read an empty cache while it loads.
      await moderators.loadFromDatabase(botInitInfo.channels[channel].id);
      // One shared EventSub socket for every channel - see twitch/events.js for why per-channel
      // sockets broke past the 3rd channel.
      eventSub.addChannel(botInitInfo.channels[channel].id, channel);
      ModsActivitiTracker = new ActivityTracker(botInitInfo.channels[channel].id, channel);
      ModsActivitiTracker.start();
      // Startup emote sync (globals -> 7TV -> prune; ordering rationale lives in
      // emoteSyncScheduler.syncNow). Going through the scheduler makes this startup run count
      // toward the 3-per-24h re-sync cap and seed lastSyncAt - so a stream already live at bot
      // start (the tracker can't see that as a transition) still gets its next re-sync 4h from
      // NOW rather than 5 minutes after boot. Fire-and-forget: a failed emote sync must never
      // stop the bot joining the channel, it just means that source isn't tracked until the
      // next scheduled re-sync or restart.
      emoteSyncScheduler.syncNow(channel)
        .catch(err => console.error(`[Emotes] Sync failed for #${channel}:`, err.message));
    }
    customCommands.startCommandTimers(client);
    await client.connect();
    // Picks up channels registered/enabled AFTER this boot (scripts/seedChannel.js, or an
    // approved /request-bot request) without needing a restart - see channelJoinScheduler.js.
    channelJoinScheduler.start(client);
  }

  await start();
}

bootstrap().catch((err) => {
  console.error('[index] Fatal startup error:', err.message);
  process.exit(1);
});
