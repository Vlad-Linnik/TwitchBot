// !longban / !cancellongban / !longbans - mod-only bans/timeouts longer than Twitch's native
// 2-week cap. Two modes, named for the one thing that actually differs between them (both last
// exactly the requested duration): 'timeout' keeps the target's read access to chat and relies on
// twitch/longBanScheduler.js renewing a 2-week Twitch timeout until the requested duration has
// elapsed; 'ban' removes chat visibility immediately via a real Twitch ban, and the scheduler
// unbans once the duration has elapsed. See db/longBansRepo.js for the persisted shape.
//
// LongBans can also originate from TwitchBot-Web's /<channel>/settings/long-bans page - those
// arrive as `status: 'pending'`/`'cancelRequested'` docs this module never writes itself (only
// twitch/longBanScheduler.js promotes/resolves them), which is why findActive/findActiveByLogin
// below treat those statuses as "occupied" too.
const { isMod } = require("../shared/isMod.js");
const { replyIfBotLacksMod } = require("../shared/botPermission.js");
const channelSettings = require("../config/channelSettings.js");
const TwitchBanAPI = require("../twitch/TwitchBanAPI.js");
const longBansRepo = require("../db/longBansRepo.js");
const { getUsersByLogin } = require("../twitch/userLookup.js");
const botInitInfo = require("../botInitInfo.js");
const { RENEWAL_SAFETY_MARGIN_MS } = require("../twitch/longBanScheduler.js");

const MAX_TIMEOUT_SECONDS = 1_209_600; // Twitch's own cap - TwitchBanAPI.timeout() self-clamps to this too
const DURATION_UNIT_SECONDS = { d: 86400, w: 604800, m: 2_592_000, y: 31_536_000 };
// The actual ceiling ECMAScript Date / MongoDB's BSON date can represent (~year 275760-09-13).
// Checked against the parsed year BEFORE any arithmetic/Date construction, so a deliberately
// huge value can't silently overflow into an Invalid Date a few steps downstream - it gets this
// specific message instead of the generic "bad format" one.
const MAX_UNBAN_YEAR = 275760;

const RU_MONTHS_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

const ABSOLUTE_DATE_REGEX = /^(\d{1,2})\.(\d{1,2})\.(\d{4,6})$/;
const RELATIVE_DURATION_REGEX = /^(\d+)([dwmy])?$/i;

// Accepts either an absolute "ДД.ММ.ГГГГ" date (local midnight) or the original relative
// duration shape (a bare number of seconds, or a number with a d/w/m/y suffix - month/year are
// calendar-approximate, 30d/365d, matching how mods actually think about "a couple months"
// rather than exact calendar arithmetic). Returns { ok: true, unbanAt } or
// { ok: false, reason: 'format' | 'overflow' | 'past' } - 'past' only applies to the date form
// (a relative duration can never resolve behind `now`).
function resolveUnbanAt(token, now) {
  const dateMatch = ABSOLUTE_DATE_REGEX.exec(token);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const year = parseInt(dateMatch[3], 10);
    if (year > MAX_UNBAN_YEAR) return { ok: false, reason: 'overflow' };
    if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, reason: 'format' };

    const unbanAt = new Date(year, month - 1, day, 0, 0, 0, 0);
    // getMonth()/getDate() disagreeing with what was typed means the date rolled over
    // (e.g. 31.02.2030 -> early March) - reject rather than silently substitute a nearby date.
    if (isNaN(unbanAt.getTime()) || unbanAt.getMonth() !== month - 1 || unbanAt.getDate() !== day) {
      return { ok: false, reason: 'format' };
    }
    if (unbanAt.getTime() <= now) return { ok: false, reason: 'past' };
    return { ok: true, unbanAt };
  }

  const relMatch = RELATIVE_DURATION_REGEX.exec(token);
  if (!relMatch) return { ok: false, reason: 'format' };
  const value = parseInt(relMatch[1], 10);
  const unit = relMatch[2] ? relMatch[2].toLowerCase() : null;
  const seconds = unit ? value * DURATION_UNIT_SECONDS[unit] : value;
  if (seconds <= 0) return { ok: false, reason: 'format' };
  // Number.isSafeInteger guards something like "1000000y": value*unit silently overflows past
  // 2^53 into an imprecise float, which then produces an Invalid Date a few steps later.
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(seconds * 1000)) return { ok: false, reason: 'overflow' };

  const unbanAt = new Date(now + seconds * 1000);
  if (isNaN(unbanAt.getTime()) || unbanAt.getFullYear() > MAX_UNBAN_YEAR) return { ok: false, reason: 'overflow' };
  return { ok: true, unbanAt };
}

// "1 января 2030" - the time suffix only shows up when it isn't exactly midnight, so a
// date-only long-ban (which always resolves to local midnight) reads cleanly while a
// duration-based one still surfaces its time of day.
function formatDateHuman(date) {
  const day = date.getDate();
  const month = RU_MONTHS_GENITIVE[date.getMonth()];
  const year = date.getFullYear();
  const hasTime = date.getHours() !== 0 || date.getMinutes() !== 0;
  const time = hasTime ? ` ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}` : '';
  return `${day} ${month} ${year}${time}`;
}

async function longBan(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.longban.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'longban'))) return 0;
  if (!isMod(userState)) return 0;
  if (replyIfBotLacksMod(client, channel, userState, settings)) return 1;

  const signature = settings.commands.longban.signature;
  const rest = message.slice(signature.length).trim();
  const argMatch = /^@?(\S+)\s+(\S+)\s+(timeout|ban)(?:\s+([\s\S]+))?$/i.exec(rest);
  if (!argMatch) {
    client.say(channel, `Ожидалось: ${signature} пользователь длительность(30d/6w/2m/1y, число секунд, или дата ДД.ММ.ГГГГ) timeout|ban [причина] VoHiYo `, userState["id"]);
    return 1;
  }

  const [, targetLoginRaw, durationToken, modeRaw, reasonRaw] = argMatch;
  const targetLogin = targetLoginRaw.toLowerCase();
  const mode = modeRaw.toLowerCase();
  const reason = reasonRaw ? reasonRaw.trim() : "No reason";

  if (targetLogin === botInitInfo.settings["username"].toLowerCase()) return 1;

  const now = Date.now();
  const resolved = resolveUnbanAt(durationToken, now);
  if (!resolved.ok) {
    const messages = {
      format: `Неверный формат длительности/даты: "${durationToken}". Ожидается число секунд, 30d/6w/2m/1y, или дата ДД.ММ.ГГГГ VoHiYo `,
      overflow: `Слишком большая длительность/дата - максимальный допустимый год: ${MAX_UNBAN_YEAR} VoHiYo `,
      past: `Дата "${durationToken}" уже в прошлом VoHiYo `,
    };
    client.say(channel, messages[resolved.reason], userState["id"]);
    return 1;
  }
  const { unbanAt } = resolved;

  const channelId = userState["room-id"];
  const channelLogin = channelSettings.normalizeChannel(channel);

  const users = await getUsersByLogin([targetLogin]);
  if (!users.length) {
    client.say(channel, `Пользователь "${targetLogin}" не найден VoHiYo `, userState["id"]);
    return 1;
  }
  const targetUser = users[0];

  const existing = await longBansRepo.findActive(channelId, targetUser.id);
  if (existing) {
    client.say(channel, `@${targetUser.login} уже находится под long-ban'ом (до ${formatDateHuman(existing.unbanAt)}) - используйте !cancellongban для отмены VoHiYo `, userState["id"]);
    return 1;
  }

  const durationMs = unbanAt.getTime() - now;
  const baseDoc = {
    channelId, channelLogin, userId: targetUser.id, userLogin: targetUser.login,
    mode, reason, createdBySource: 'chat', createdByLogin: userState.username.toLowerCase(), createdAt: new Date(now),
    unbanAt, status: 'active',
  };

  if (mode === 'timeout') {
    const appliedSeconds = Math.min(MAX_TIMEOUT_SECONDS, Math.ceil(durationMs / 1000));
    await TwitchBanAPI.timeout(targetUser.id, appliedSeconds, channelId, reason);
    const coversRemainder = appliedSeconds * 1000 >= durationMs;
    const nextRenewalAt = coversRemainder ? unbanAt : new Date(now + appliedSeconds * 1000 - RENEWAL_SAFETY_MARGIN_MS);
    await longBansRepo.create({ ...baseDoc, nextRenewalAt });
  } else {
    await TwitchBanAPI.ban(targetUser.id, channelId, reason);
    await longBansRepo.create({ ...baseDoc, nextRenewalAt: unbanAt });
  }

  const modeText = mode === 'timeout' ? 'таймаут, чат виден' : 'бан, чат скрыт';
  client.say(channel, `@${targetUser.login} заблокирован (${modeText}) до ${formatDateHuman(unbanAt)}, причина: ${reason} VoHiYo `, userState["id"]);
  return 1;
}

async function cancelLongBan(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.cancellongban.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'cancellongban'))) return 0;
  if (!isMod(userState)) return 0;
  if (replyIfBotLacksMod(client, channel, userState, settings)) return 1;

  const signature = settings.commands.cancellongban.signature;
  const rest = message.slice(signature.length).trim();
  const argMatch = /^@?(\S+)/.exec(rest);
  if (!argMatch) {
    client.say(channel, `Ожидалось: ${signature} пользователь VoHiYo `, userState["id"]);
    return 1;
  }
  const targetLogin = argMatch[1].toLowerCase();
  const channelId = userState["room-id"];

  const doc = await longBansRepo.findActiveByLogin(channelId, targetLogin);
  if (!doc) {
    client.say(channel, `Активный long-ban для "${targetLogin}" не найден VoHiYo `, userState["id"]);
    return 1;
  }

  // A still-'pending' web submission never actually reached Twitch yet, so cancelling it needs
  // no unban call; 'cancelRequested' means the web already asked for this and the scheduler will
  // finish it within its next poll - calling unban again here would just be redundant. Everything
  // else ('active') is a real ban/timeout in effect and needs the real Twitch call to lift it.
  if (doc.status === 'pending') {
    await longBansRepo.updateById(doc._id, { status: 'cancelled' });
  } else if (doc.status !== 'cancelRequested') {
    await TwitchBanAPI.unban(doc.userId, channelId);
    await longBansRepo.updateById(doc._id, { status: 'cancelled' });
  }

  client.say(channel, `@${doc.userLogin} - long-ban отменён, доступ к чату восстановлен VoHiYo `, userState["id"]);
  return 1;
}

async function listLongBans(client, channel, userState, message) {
  const settings = channelSettings.getSettings(channel);
  if (!settings.commands.longbans.enabled) return 0;
  if (!message.toLocaleLowerCase().match(channelSettings.getCommandSignatureRegex(channel, 'longbans'))) return 0;
  if (!isMod(userState)) return 0;

  const channelId = userState["room-id"];
  const docs = await longBansRepo.listActiveForChannel(channelId);
  if (!docs.length) {
    client.say(channel, `Активных long-ban'ов нет VoHiYo `, userState["id"]);
    return 1;
  }

  const modeLabel = { timeout: 'таймаут', ban: 'бан' };
  const statusMarker = { pending: ' [в обработке]', cancelRequested: ' [снимается]' };
  const list = docs.map(d => {
    const origin = d.createdBySource === 'web' ? `с сайта: ${d.createdByLogin}` : `из чата: ${d.createdByLogin}`;
    return `@${d.userLogin} (${modeLabel[d.mode]}, до ${formatDateHuman(d.unbanAt)}, ${origin})${statusMarker[d.status] || ''}`;
  }).join(' | ');
  client.say(channel, `Активные long-ban'ы: ${list}`, userState["id"]);
  return 1;
}

module.exports = { longBan, cancelLongBan, listLongBans, resolveUnbanAt, formatDateHuman, MAX_UNBAN_YEAR };
