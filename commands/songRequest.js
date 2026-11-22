// !sr <YouTube link> - a song request: the video goes into the channel's donation media queue on
// the site, as if a moderator had pasted it into the panel.
//
// It travels the same way as !clip (commands/donationMediaControl.js): a row in the shared
// DonationMediaChatCommands, action "add", picked up by TwitchBot-Web within a second, and the
// outcome read back to answer in chat. The contract is TwitchBot-Web
// db/donationMediaChatCommandsRepo.js and lib/donationMediaChatCommand.js.
//
// Decisions:
//   - Off by default (config/channelSettings.js `sr.enabled: false`): a channel decides to let chat
//     put things on stream. `access` is "mods" (default) or "all".
//   - The badge check and the cooldown here are only a filter. The site checks again - whether !sr
//     is on, who may use it, at most two waiting requests per viewer, whether the video can be
//     embedded at all - and its answer is what chat hears.
//   - The cooldown is per viewer and does not apply to moderators.
//   - No now-playing row means the channel never set donation media up: the message is left alone
//     (returns 0), as !song and !clip do.
//   - Waiting for the outcome is detached from the dispatcher, like !clip: execCommands awaits each
//     handler, and holding it for seconds would hold every later command.
const { connect } = require("../db/db.js");
const channelSettings = require("../config/channelSettings.js");
const botInitInfo = require("../botInitInfo.js");
const { isMod } = require("../shared/isMod.js");
const { isTimerReady } = require("../shared/timer.js");

const NOW_PLAYING = "DonationMediaNowPlaying";
const COMMANDS = "DonationMediaChatCommands";
// Longer than !clip's: the site checks the video with YouTube (up to 8 s) before queueing it.
const RESULT_WAIT_MS = 10000;
const RESULT_POLL_MS = 500;

const lastUse = new Map(); // "#channel|login" -> ms

// The chat line for a finished request.
function describeOutcome(status, result) {
  switch (status) {
    case "done": {
      const title = result && result.title ? `«${String(result.title).slice(0, 120)}»` : "Трек";
      const position = result && Number.isInteger(result.position) ? result.position : null;
      if (position === 0) return `🎵 ${title} — играет сейчас`;
      return position ? `🎵 ${title} — в очереди, место ${position}` : `🎵 ${title} — в очереди`;
    }
    case "disabled":
      return "Заказ треков на этом канале выключен";
    case "forbidden":
      return "Заказывать треки могут только модераторы";
    case "invalid":
      return "Нужна ссылка на ролик YouTube";
    case "noEmbed":
      return "Этот ролик нельзя показать в плеере (удалён или запрещено встраивание)";
    case "limit":
      return "У вас уже два трека в очереди — дождитесь их";
    case "full":
      return "Очередь переполнена";
    default:
      return "Сайт не ответил, попробуйте ещё раз";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForOutcome(col, id) {
  const deadline = Date.now() + RESULT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(RESULT_POLL_MS);
    const row = await col.findOne({ _id: id }, { projection: { status: 1, result: 1 } });
    if (row && row.status !== "pending" && row.status !== "handling") return row;
  }
  return null;
}

async function sendAndReport(client, channel, userState, db, command) {
  try {
    const col = db.collection(COMMANDS);
    const { insertedId } = await col.insertOne(command);
    const row = await waitForOutcome(col, insertedId);
    client.say(channel, describeOutcome(row && row.status, row && row.result), userState["id"]);
  } catch (err) {
    console.error("[songRequest] failed:", err.message);
  }
}

async function songRequest(client, channel, userState, message) {
  const conf = channelSettings.getSettings(channel).commands.sr;
  if (!conf || !conf.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, "sr"))) return 0;
  const mod = isMod(userState);
  if (conf.access !== "all" && !mod) return 0;

  const channelId = botInitInfo.channels[channelSettings.normalizeChannel(channel)]?.id;
  if (!channelId) return 0;

  let db;
  let row;
  try {
    db = await connect();
    row = await db.collection(NOW_PLAYING).findOne({ channelId: String(channelId) }, { projection: { _id: 1 } });
  } catch (err) {
    console.error("[songRequest] read failed:", err.message);
    return 1;
  }
  if (!row) return 0;

  const link = (message.trim().split(/\s+/)[1] || "").slice(0, 300);
  if (!link) {
    client.say(channel, `Ожидалось: ${conf.signature} <ссылка на YouTube>`, userState["id"]);
    return 1;
  }

  const login = userState["username"] || "";
  const key = `${channel}|${login}`;
  if (!mod) {
    if (!isTimerReady(lastUse.get(key) || 0, conf.cooldownMs || 0)) return 1;
    lastUse.set(key, Date.now());
  }

  sendAndReport(client, channel, userState, db, {
    channelId: String(channelId),
    action: "add",
    videoId: link,
    by: { userId: String(userState["user-id"] || ""), login: login || null },
    status: "pending",
    createdAt: new Date(),
  });
  return 1;
}

module.exports = { songRequest, describeOutcome };
