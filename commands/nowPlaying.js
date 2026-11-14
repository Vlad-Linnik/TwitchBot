// !track - names the donated clip the channel's OBS player is showing right now.
//
// The queue lives in TwitchBot-Web (realtime/donationMediaManager.js, web db); the bot sees only
// the one row the site publishes for it, DonationMediaNowPlaying in the shared db (contract in
// TwitchBot-Web db/donationMediaNowPlayingRepo.js). It is read on demand, once per command: the
// command has a cooldown and no other reader, so a cache would only add staleness.
//
// Three things decide what is said:
//   - No row at all means the channel never set donation media up. The command then does not claim
//     the message (returns 0), so a channel already answering "!track" with another bot keeps it.
//   - A row whose updatedAt is older than STALE_MS is read as "nothing plays": the site re-writes
//     a playing row every minute (NOW_PLAYING_REFRESH_MS there), so an old one is left behind by a
//     web process that died mid-clip.
//   - The title is the video uploader's text and the donor name is the donor's: both reach chat
//     under the bot's moderator name, which passes neither AutoMod nor the link ban. So both go
//     through variableArgs.sanitizeArg, like a viewer's command argument. The link is built here
//     from the video id, never taken from the row as text.
const { connect } = require("../db/db.js");
const channelSettings = require("../config/channelSettings.js");
const botInitInfo = require("../botInitInfo.js");
const { isTimerReady } = require("../shared/timer.js");
const { sanitizeArg } = require("../shared/variableArgs.js");
const { parseMentionRedirect, sayMaybeMention } = require("../shared/mentionRedirect.js");

const COLLECTION = "DonationMediaNowPlaying";
// Two and a half of the site's refresh intervals: one missed write is not a death.
const STALE_MS = 150 * 1000;
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const MAX_TITLE = 120;
const MAX_DONOR = 40;

const lastUse = new Map();

function formatAmount(amount) {
  if (!amount || !Number.isFinite(Number(amount.value))) return "";
  const value = Number(amount.value);
  const currency = String(amount.currency || "").toUpperCase();
  try {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch (_) {
    return currency ? `${value} ${currency}` : String(value);
  }
}

// row -> the chat line, or null when nothing (usable) plays. Pure, for a throwaway check script.
function describe(row, { now = Date.now(), bannedWords = [], bannedRegex = null } = {}) {
  if (!row || !row.item) return null;
  const updatedAt = row.updatedAt ? new Date(row.updatedAt).getTime() : 0;
  if (!updatedAt || now - updatedAt > STALE_MS) return null;
  const item = row.item;
  if (!VIDEO_ID_RE.test(String(item.videoId || ""))) return null;

  const clean = (text, maxLength) => (text ? sanitizeArg(text, { bannedWords, bannedRegex, maxLength }) : "");
  const title = clean(item.title, MAX_TITLE);
  const donor = clean(item.donor, MAX_DONOR);
  const addedBy = clean(item.addedBy, MAX_DONOR);
  const amount = formatAmount(item.amount);

  let line = `🎵 Сейчас играет: ${title ? `${title} — ` : ""}https://youtu.be/${item.videoId}`;
  if (donor && amount) line += ` · донат от ${donor}, ${amount}`;
  else if (donor) line += ` · донат от ${donor}`;
  else if (amount) line += ` · донат ${amount}`;
  else if (addedBy) line += ` · добавил ${addedBy}`;
  if (row.paused) line += " (на паузе)";
  return line;
}

async function nowPlaying(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  const conf = settings.commands.track;
  if (!conf || !conf.enabled) return 0;
  const { mentionTarget, rest } = parseMentionRedirect(message);
  if (!rest.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, "track"))) return 0;

  const channelId = botInitInfo.channels[channelSettings.normalizeChannel(channel)]?.id;
  if (!channelId) return 0;

  let row;
  try {
    const db = await connect();
    row = await db.collection(COLLECTION).findOne({ channelId: String(channelId) });
  } catch (err) {
    console.error("[nowPlaying] read failed:", err.message);
    return 1;
  }
  if (!row) return 0;

  if (!isTimerReady(lastUse.get(channel) || 0, conf.cooldownMs)) return 1;
  lastUse.set(channel, Date.now());

  const line = describe(row, {
    bannedWords: settings.bannedWords?.words || [],
    bannedRegex: channelSettings.getBannedWordsRegex(channel),
  });
  sayMaybeMention(client, channel, mentionTarget, userState["id"], line || "Сейчас ролик за донат не играет");
  return 1;
}

module.exports = { nowPlaying, describe, formatAmount, STALE_MS };
