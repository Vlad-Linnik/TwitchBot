// !clip hide|show|pause|play|skip - a moderator controls the donated clip on stream from chat.
//
// The queue and the OBS player belong to TwitchBot-Web (realtime/donationMediaManager.js), which
// this process never calls. So the command travels through the shared db: the bot inserts a row
// into DonationMediaChatCommands, the site picks it up within a second, applies it and writes the
// outcome back, and the bot reads that outcome to say it in chat. The row's contract is
// TwitchBot-Web db/donationMediaChatCommandsRepo.js.
//
//   hide - the picture is covered, the sound goes on   show - uncover it
//   pause                                              play - resume
//   skip - the next clip
//
// Decisions:
//   - The command names the clip it is about: the `item.id` of the now-playing row
//     (DonationMediaNowPlaying, the same row !track reads). Chat is seconds behind the stream, and
//     two moderators typing "!clip skip" at once must skip one clip, not two - the second finds the
//     clip already gone and is told so.
//   - No now-playing row means the channel never set donation media up: the message is left alone
//     (returns 0), as !track does. A row with nothing playing (or a stale one) gets an answer.
//   - The badge check here is only a filter. The site checks again with its own rules, so a
//     moderator the owner denied the donation media section on the site cannot do from chat what
//     they cannot do from the panel.
//   - Waiting for the outcome is detached from the dispatcher: execCommands awaits each handler,
//     and holding it for seconds would hold every later command in the chain.
const { connect } = require("../db/db.js");
const channelSettings = require("../config/channelSettings.js");
const botInitInfo = require("../botInitInfo.js");
const { isMod } = require("../shared/isMod.js");
const { STALE_MS } = require("./nowPlaying.js");

const NOW_PLAYING = "DonationMediaNowPlaying";
const COMMANDS = "DonationMediaChatCommands";
// The site looks every second (CHAT_COMMAND_POLL_MS in donationMediaManager.js); five seconds
// covers a slow tick or two without a moderator wondering whether the bot heard them.
const RESULT_WAIT_MS = 5000;
const RESULT_POLL_MS = 500;

const ACTIONS = ["hide", "show", "pause", "play", "skip"];
// What a moderator may type for each action. The second word is lowercased before the lookup.
const ALIASES = {
  hide: "hide", скрыть: "hide", спрятать: "hide",
  show: "show", unhide: "show", показать: "show",
  pause: "pause", stop: "pause", пауза: "pause",
  play: "play", resume: "play", продолжить: "play",
  skip: "skip", next: "skip", пропустить: "skip", скип: "skip",
};

const DONE = {
  hide: "🙈 Клип скрыт, звук играет",
  show: "👀 Клип снова виден",
  pause: "⏸ Клип на паузе",
  play: "▶ Клип продолжает играть",
  skip: "⏭ Клип пропущен",
};
const NOOP = {
  hide: "Клип и так скрыт",
  show: "Клип и так виден",
  pause: "Клип и так на паузе",
  play: "Клип и так играет",
  skip: "Клип уже пропущен",
};

function usage(signature) {
  return `Ожидалось: ${signature} hide | show | pause | play | skip`;
}

// The chat line for a finished command row, or for no answer at all (null).
function describeOutcome(action, status) {
  switch (status) {
    case "done":
      return DONE[action];
    case "noop":
      return NOOP[action];
    case "changed":
      return "Этот клип уже не играет";
    case "forbidden":
      return "Нет прав на управление медиа за донат";
    case "expired":
    case null:
    case undefined:
    case "pending":
    case "handling":
      return "Сайт не ответил, попробуйте ещё раз";
    default:
      return "Не получилось";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOutcome(col, id) {
  const deadline = Date.now() + RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(RESULT_POLL_MS);
    const row = await col.findOne({ _id: id }, { projection: { status: 1 } });
    if (row && row.status !== "pending" && row.status !== "handling") return row.status;
  }
  return null;
}

async function sendAndReport(client, channel, userState, db, command) {
  try {
    const col = db.collection(COMMANDS);
    const { insertedId } = await col.insertOne(command);
    const status = await waitForOutcome(col, insertedId);
    client.say(channel, describeOutcome(command.action, status), userState["id"]);
  } catch (err) {
    console.error("[donationMediaControl] failed:", err.message);
  }
}

async function donationMediaControl(client, channel, userState, message) {
  const conf = channelSettings.getSettings(channel).commands.clip;
  if (!conf || !conf.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, "clip"))) return 0;
  if (!isMod(userState)) return 0;

  const channelId = botInitInfo.channels[channelSettings.normalizeChannel(channel)]?.id;
  if (!channelId) return 0;

  let db;
  let row;
  try {
    db = await connect();
    row = await db.collection(NOW_PLAYING).findOne({ channelId: String(channelId) });
  } catch (err) {
    console.error("[donationMediaControl] read failed:", err.message);
    return 1;
  }
  if (!row) return 0;

  const word = (message.trim().split(/\s+/)[1] || "").toLocaleLowerCase();
  const action = ALIASES[word];
  if (!action) {
    client.say(channel, usage(conf.signature), userState["id"]);
    return 1;
  }

  const fresh = row.updatedAt && Date.now() - new Date(row.updatedAt).getTime() <= STALE_MS;
  if (!fresh || !row.item || !Number.isInteger(row.item.id)) {
    client.say(channel, "Сейчас ролик за донат не играет", userState["id"]);
    return 1;
  }

  sendAndReport(client, channel, userState, db, {
    channelId: String(channelId),
    action,
    itemId: row.item.id,
    by: { userId: String(userState["user-id"] || ""), login: userState["username"] || null },
    status: "pending",
    createdAt: new Date(),
  });
  return 1;
}

module.exports = { donationMediaControl, describeOutcome, ALIASES, ACTIONS };
