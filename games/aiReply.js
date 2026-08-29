// AI answers to mentions of this bot.
//
// The scripted replies this replaces are still here and still matter: games/questionToThisBot.js
// (a random "yes/no" to anything with a question mark) and msgHandle's `busy` line are now the
// fallback for when this path is switched off, out of budget, or broken. Nothing about a channel's
// own word lists or reply phrases moved - only the fine settings did, into the admin panel, and
// they live in AiConfig (global) plus ChannelConfig's `ai` block (per channel).
//
// SHAPE OF THE PATH, and why:
//
//   mention -> banned words -> [filter] -> [answer cache] -> model -> sanitize -> reply
//
// The two lookaside tables in the middle are what keeps this affordable. They are checked before
// the API is ever contacted; the filter is global (a greeting means the same thing everywhere)
// and the answer cache is per channel (the right answer to "what are we playing" is not).
//
// THE CALL IS DETACHED. tryAnswer() decides synchronously whether it will take the message and
// returns immediately; everything after that runs on its own. Making the mention path async
// instead would mean moving it into execCommands' awaited list, which would reorder the checks
// that currently run before it - the banned-word check above all - and that ordering is load
// bearing. The cost of detaching is that a late answer has to be dropped rather than sent, which
// is the right trade in a live chat: see LATE_REPLY_MS below.
//
// The model is asked for a verdict on the message in the same call that produces the reply,
// because the call is already paid for. A second "judge" call would double the bill to re-read
// text the model has just read.
const botInitInfo = require('../botInitInfo.js');
const channelSettings = require('../config/channelSettings.js');
const aiSettings = require('../config/aiSettings.js');
const aiStore = require('../db/aiStore.js');
const Twitch_ban_API = require('../twitch/TwitchBanAPI.js');
const { isMod } = require('../shared/isMod.js');
const { isKnownBot, KNOWN_BOT_LOGINS } = require('../config/knownBots.js');
const { replyIfBotLacksMod } = require('../shared/botPermission.js');
const { isTimerReady } = require('../shared/timer.js');
const healthTracker = require('../shared/healthTracker.js');
const describeError = require('../shared/describeError.js');

// Guards, not settings - they are here rather than in the admin panel because turning them
// without a measurement in hand can only make things worse.
//
// A reply is capped at 500 characters by Twitch itself, and 400 output tokens is far more than
// that needs; the ceiling exists because running out of output tokens is silent (the message comes
// back with no usable content rather than an error).
const MAX_TOKENS = 400;
const MAX_REPLY_CHARS = 500;
// How long after the viewer's message an answer is still worth sending. Past this the chat has
// moved on and a reply reads as a non-sequitur, so it is dropped instead.
const LATE_REPLY_MS = 10000;
const CHAT_CONTEXT_LINES = 5;
const MAX_TIMEOUT_REASON_CHARS = 60;
const BUDGET_RECHECK_MS = 30000;
const IGNORE_REFRESH_MS = 60000;
// How long a failing API is treated as a blip rather than an incident - roughly two of anything
// that would retry, per shared/healthTracker.js's convention.
const HEALTH_GRACE_MS = 120000;

// Anthropic list prices in USD per million tokens, checked 2026-08-29. Only fills the journal's
// cost column: a stale number here misreports spend, it never changes behaviour. A model missing
// from this table logs a null cost rather than a wrong one.
const PRICING = {
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-opus-5': { input: 5, output: 25 },
};

const ANSWER_TOOL = {
  name: 'answer',
  description: 'Ответить зрителю в чат и оценить его сообщение.',
  strict: true,
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'Текст ответа в чат. Одно сообщение, без переносов строк.',
      },
      verdict: {
        type: 'string',
        enum: ['normal', 'filter', 'ignore_user', 'timeout'],
        description:
          'normal - обычное сообщение. ' +
          'filter - сообщение настолько типовое (приветствие, смайлик, «как дела»), что впредь на него надо отвечать заготовкой без обращения к модели; твой reply и станет этой заготовкой. ' +
          'ignore_user - этот зритель раз за разом пишет бессмыслицу, отвечать ему больше не стоит; метка снимается только вручную администратором, поэтому выбирай её редко. ' +
          'timeout - откровенный бред или провокация, за которые уместен тайм-аут.',
      },
      reason: {
        type: 'string',
        description:
          'Причина для verdict, 2-3 слова. Для timeout она уйдёт в текст тайм-аута и будет видна зрителю и модераторам.',
      },
      cacheable: {
        type: 'string',
        enum: ['eternal', 'temporary'],
        description:
          'eternal - ответ останется верным и завтра, и через месяц, и его можно переиспользовать при точно таком же вопросе. ' +
          'temporary - ответ зависит от текущего момента (что идёт на стриме, сколько времени, кто в чате) и переиспользовать его нельзя.',
      },
    },
    required: ['reply', 'verdict', 'reason', 'cacheable'],
    additionalProperties: false,
  },
};

const SYSTEM_RULES = [
  'Ты — чат-бот на Twitch. Зритель упомянул тебя в чате. Ответь ему.',
  '',
  'Жёсткие правила:',
  '- Один ответ, одно сообщение, без переносов строк.',
  '- Целься в 1-2 предложения. Развёрнутый ответ уместен, только если вопрос действительно этого требует.',
  '- Никаких ссылок. Не начинай ответ с «!» или «/».',
  '- Не ставь «@» перед никами, кроме перечисленных в разделе «Разрешённые ники». К автору вопроса по нику обращаться не нужно: ответ и так прикрепляется к его сообщению.',
  '- Если не знаешь ответа — так и скажи. Не выдумывай факты о канале, стримере, игре или зрителях: всё, что ты знаешь о канале, перечислено ниже, остального у тебя нет.',
  '- Отвечай на языке вопроса.',
  '',
  'Ты обязан вызвать инструмент answer — обычного текстового ответа недостаточно.',
].join('\n');

// channel -> ring of the last CHAT_CONTEXT_LINES messages. Fed from index.js for every message,
// not just mentions: it is both the conversational context and the whitelist of logins the model
// is allowed to put an "@" in front of.
const recentChat = new Map();
const lastAiReply = new Map();

// Anthropic client, built on first use: the key is optional, and a deployment without one should
// fall back to the scripted replies rather than fail to boot.
let anthropic = null;
function getClient(timeoutMs) {
  if (!anthropic) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // No SDK retries: the whole answer has a hard few-second budget, and a retry would spend it
      // producing an answer that is already too late to send.
      maxRetries: 0,
      timeout: timeoutMs,
    });
  }
  return anthropic;
}

function recordChatLine(channel, login, text) {
  let ring = recentChat.get(channel);
  if (!ring) {
    ring = [];
    recentChat.set(channel, ring);
  }
  ring.push({ login: String(login || '').toLowerCase(), text: String(text || '') });
  if (ring.length > CHAT_CONTEXT_LINES) ring.shift();
}

// --- ignore list, kept in memory so eligibility stays a synchronous decision -------------------

let ignoredKeys = new Set();
let ignoreLoadedAt = 0;
let ignoreLoading = null;

function refreshIgnored() {
  if (ignoreLoading) return ignoreLoading;
  ignoreLoading = (async () => {
    try {
      ignoredKeys = new Set(await aiStore.listIgnoredKeys());
      ignoreLoadedAt = Date.now();
    } catch (err) {
      console.error('[aiReply] ignore list refresh failed:', err.message);
    } finally {
      ignoreLoading = null;
    }
  })();
  return ignoreLoading;
}

function ignoreKey(channel, userId) {
  return channel + '|' + userId;
}

function isIgnoredSync(channel, userId) {
  if (Date.now() - ignoreLoadedAt > IGNORE_REFRESH_MS) refreshIgnored();
  return ignoredKeys.has(ignoreKey(channel, userId));
}

// --- daily budget -------------------------------------------------------------------------------

let billedToday = 0;
let budgetDay = null;
let budgetCheckedAt = 0;
let budgetLoading = null;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function refreshBudget() {
  if (budgetLoading) return budgetLoading;
  budgetLoading = (async () => {
    try {
      const day = startOfToday();
      billedToday = await aiStore.countBilledSince(day);
      budgetDay = day.getTime();
      budgetCheckedAt = Date.now();
    } catch (err) {
      console.error('[aiReply] budget refresh failed:', err.message);
    } finally {
      budgetLoading = null;
    }
  })();
  return budgetLoading;
}

// Reads the last known count and refreshes in the background. The local counter is incremented on
// every billed call, so the window between refreshes can overshoot the limit by at most the number
// of calls made inside it - which the per-channel cooldown already keeps to a handful.
function budgetAvailable(limit) {
  if (budgetDay !== startOfToday().getTime() || Date.now() - budgetCheckedAt > BUDGET_RECHECK_MS) {
    refreshBudget();
  }
  return billedToday < limit;
}

// --- text handling ------------------------------------------------------------------------------

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripBotMention(message) {
  const name = String(botInitInfo.settings['username'] || '').toLowerCase();
  if (!name) return String(message || '').trim();
  return String(message || '')
    .replace(new RegExp('@?' + escapeRegExp(name), 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function allowedMentionLogins(question, lines) {
  const allowed = new Set();
  const matches = String(question).match(/@?[a-z0-9_]{3,25}/gi) || [];
  for (const m of matches) allowed.add(m.replace('@', '').toLowerCase());
  for (const line of lines) allowed.add(line.login);
  return allowed;
}

// Applied to what the model produced, not instead of telling it the rules. The instruction is what
// usually works; this is what always works, and on a cheap model the difference shows.
function sanitizeReply(text, allowedLogins) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  out = out.replace(/https?:\/\/\S+/gi, ' ');
  out = out.replace(/\b[\w-]+\.(?:com|net|org|ru|ua|tv|io|me|gg|xyz|dev|app)\b\S*/gi, ' ');
  // A stray "@nick" would ping a real person who never asked to be involved; the name itself can
  // stay, only the ping is removed.
  out = out.replace(/@([a-z0-9_]{3,25})/gi, (full, login) =>
    allowedLogins.has(login.toLowerCase()) ? full : login
  );
  // A leading "!" or "/" would fire a command - ours, another bot's, or Twitch's own.
  out = out.replace(/^[!/.]+\s*/, '');
  return out.replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY_CHARS);
}

function sanitizeReason(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/[@!/]/g, '')
    .trim()
    .slice(0, MAX_TIMEOUT_REASON_CHARS);
}

// Other chat bots must never reach the model. games/duelFromMrCopusBot.js only claims the two
// exact phrases it knows (a duel challenge and a duel result); every OTHER thing mistercopus_bot
// says that happens to mention us would otherwise fall through to here, cost a request, and get
// a nonsense answer aimed at a machine - with a real chance of the two bots answering each other.
//
// Checked by login first and id second: the id set is resolved from Helix at startup and is empty
// if that lookup failed, while the login list is always there.
function isBotSender(userState) {
  const login = String(userState["username"] || "").toLowerCase();
  return KNOWN_BOT_LOGINS.includes(login) || isKnownBot(userState["user-id"]);
}

function isProtected(userState) {
  if (isMod(userState)) return true;
  const badges = userState['badges'];
  return Boolean(badges && 'vip' in badges);
}

// --- prompt -------------------------------------------------------------------------------------

function buildUserContent({ channel, question, login, card, cheatsheet, tone, lines, memory, allowed }) {
  const parts = ['Канал: ' + channel];

  if (card.live) {
    const bits = ['в эфире ' + Math.floor(card.uptimeMinutes / 60) + ' ч ' + (card.uptimeMinutes % 60) + ' мин'];
    if (card.category) bits.unshift('категория «' + card.category + '»');
    if (card.viewers != null) bits.push(card.viewers + ' зрителей');
    parts.push('Стрим: ' + bits.join(', '));
  } else {
    parts.push('Стрим: сейчас офлайн');
  }

  if (cheatsheet) parts.push('О канале: ' + cheatsheet);
  if (tone) parts.push('Тон ответов на этом канале: ' + tone);
  parts.push('Разрешённые ники: ' + ([...allowed].join(', ') || '(нет)'));

  if (lines.length) {
    parts.push('Последние сообщения чата:');
    for (const l of lines) parts.push('  ' + l.login + ': ' + l.text);
  }

  if (memory.length) {
    parts.push('Предыдущий разговор с этим зрителем:');
    for (const pair of memory) {
      parts.push('  ' + login + ': ' + pair.question);
      parts.push('  ты: ' + pair.answer);
    }
  }

  parts.push('Вопрос от ' + login + ': ' + question);
  return parts.join('\n');
}

// --- the path -----------------------------------------------------------------------------------

// Synchronous eligibility check. Returning true means "this message is mine, a reply is on its
// way" - the caller must not fall through to the scripted replies. Everything expensive happens
// after the caller has already returned.
function tryAnswer(client, channel, userState, message) {
  const cfg = aiSettings.get();
  if (!cfg.enabled) return false;
  if (!process.env.ANTHROPIC_API_KEY) return false;

  const settings = channelSettings.getSettings(channel);
  if (!settings.ai || !settings.ai.enabled) return false;

  if (isBotSender(userState)) return false;
  if (isIgnoredSync(channel, userState['user-id'])) return false;
  if (!isTimerReady(lastAiReply.get(channel) || 0, cfg.cooldownMs)) return false;
  if (!budgetAvailable(cfg.dailyRequestLimit)) return false;

  // Claimed before the async work starts, so a burst of mentions in the same second produces one
  // answer rather than one per message.
  lastAiReply.set(channel, Date.now());
  answer(client, channel, userState, message, cfg, settings).catch((err) =>
    console.error('[aiReply] unhandled failure:', describeError(err))
  );
  return true;
}

async function answer(client, channel, userState, message, cfg, settings) {
  const receivedAt = Date.now();
  const question = stripBotMention(message);
  const login = userState['username'];
  const base = { channel, userId: String(userState['user-id']), login, question };

  const send = (text) => {
    if (!text) return false;
    if (Date.now() - receivedAt > LATE_REPLY_MS) return false;
    client.say(channel, text, userState['id']);
    return true;
  };

  // 1. The global filter: messages already judged not worth an API call.
  const canned = await aiStore.findFilterAnswer(question);
  if (canned) {
    const sent = send(canned);
    await aiStore.writeLog({ ...base, answer: canned, source: 'filter', verdict: 'normal', billed: false, sent });
    return;
  }

  // 2. This channel's cache of durable answers.
  const cached = await aiStore.findCachedAnswer(channel, question);
  if (cached) {
    const sent = send(cached);
    await aiStore.writeLog({ ...base, answer: cached, source: 'cache', verdict: 'normal', billed: false, sent });
    return;
  }

  const channelEntry = botInitInfo.channels[channel.replace('#', '')];
  const lines = (recentChat.get(channel) || []).slice();
  const [card, memory] = await Promise.all([
    channelEntry ? aiStore.streamCard(channelEntry.id) : Promise.resolve({ live: false }),
    aiStore.recentExchanges(channel, base.userId, cfg.memoryPairs),
  ]);
  const allowed = allowedMentionLogins(question, lines);

  let res;
  const startedAt = Date.now();
  try {
    res = await getClient(cfg.requestTimeoutMs).messages.create({
      model: cfg.model,
      max_tokens: MAX_TOKENS,
      // Rules and persona are the same for every channel and every message, so they are the stable
      // cache prefix; everything that varies is in the user turn below it. Whether the prefix is
      // long enough for the cache to engage is visible in the journal's cacheReadTokens column -
      // a short prompt silently does not cache.
      system: [
        {
          type: 'text',
          text: cfg.persona ? SYSTEM_RULES + '\n\n' + cfg.persona : SYSTEM_RULES,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [ANSWER_TOOL],
      tool_choice: { type: 'tool', name: 'answer' },
      messages: [
        {
          role: 'user',
          content: buildUserContent({
            channel,
            question,
            login,
            card,
            cheatsheet: settings.ai.cheatsheet,
            tone: settings.ai.tone,
            lines,
            memory,
            allowed,
          }),
        },
      ],
    });
    healthTracker.reportSuccess('ai-reply', { label: 'AI-ответы на упоминания', scope: channel });
  } catch (err) {
    // Every network-facing subsystem here recovers by itself, so one failed call is not an
    // incident - healthTracker holds it for the grace window and only then calls it one.
    healthTracker.reportFailure('ai-reply', {
      label: 'AI-ответы на упоминания',
      detail: describeError(err),
      scope: channel,
      graceMs: HEALTH_GRACE_MS,
    });
    // The viewer still gets an answer, just the scripted one - the same line they would have got
    // with the feature switched off.
    const fallback = settings.responses.busy.random();
    const sent = send(fallback);
    await aiStore.writeLog({
      ...base,
      answer: fallback,
      source: 'error',
      verdict: 'normal',
      billed: false,
      sent,
      error: describeError(err),
    });
    return;
  }

  billedToday += 1;

  const toolUse = (res.content || []).find((b) => b.type === 'tool_use');
  // A forced tool_choice makes this the expected shape, but a refusal or a truncated response can
  // still arrive as a normal 200 with nothing usable in it - checked rather than assumed, because
  // the failure is silent otherwise.
  const out = toolUse && toolUse.input ? toolUse.input : null;
  const rawReply = out
    ? out.reply
    : (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ');

  const reply = sanitizeReply(rawReply, allowed);
  const verdict = out && out.verdict ? out.verdict : 'normal';
  const reason = sanitizeReason(out ? out.reason : '');
  const usage = res.usage || {};
  const price = PRICING[cfg.model];

  const sent = send(reply);

  let punished = false;
  if (verdict === 'timeout' && !isProtected(userState)) {
    // Observe mode is the default and stays until the journal says the model's calls are worth
    // acting on. The row is written either way, which is what makes that comparison possible.
    if (cfg.punishMode === 'enforce' && !replyIfBotLacksMod(client, channel, userState, settings)) {
      Twitch_ban_API.timeout(
        userState['user-id'],
        cfg.timeoutSeconds,
        userState['room-id'],
        reason || 'глупый вопрос'
      );
      punished = true;
    }
  } else if (verdict === 'filter') {
    // The answer it just gave becomes the canned one, so the same message never costs again.
    await aiStore.addFilterEntry(question, reply);
  } else if (verdict === 'ignore_user') {
    await aiStore.ignoreUser(channel, base.userId, login, reason);
    ignoredKeys.add(ignoreKey(channel, base.userId));
  }

  if (verdict === 'normal' && out && out.cacheable === 'eternal' && reply) {
    await aiStore.cacheAnswer(channel, question, reply);
  }

  await aiStore.writeLog({
    ...base,
    answer: reply,
    source: 'model',
    verdict,
    reason,
    cacheable: out ? out.cacheable : null,
    billed: true,
    sent,
    punished,
    protectedUser: isProtected(userState),
    model: cfg.model,
    inputTokens: usage.input_tokens ?? null,
    outputTokens: usage.output_tokens ?? null,
    cacheReadTokens: usage.cache_read_input_tokens ?? null,
    costUsd:
      price && usage.input_tokens != null
        ? (usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6
        : null,
    latencyMs: Date.now() - startedAt,
  });
}

module.exports = { tryAnswer, recordChatLine };
