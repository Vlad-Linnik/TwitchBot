// Background poller for !longban (commands/longBan.js): Twitch's Helix ban endpoint caps a
// timeout's duration at 2 weeks, so a longer "long-ban" is only possible by either (a) renewing a
// fresh 2-week timeout until the requested duration has elapsed (mode: 'timeout'), or (b) issuing
// a real ban now and unbanning once it has elapsed (mode: 'ban'). Both need a check against an
// absolute future timestamp that survives a restart - unlike twitch/emoteSyncScheduler.js's
// in-memory lastSyncAt (acceptable to reset there; not acceptable here for a multi-week ban), so
// due-ness is computed from `nextRenewalAt`/`unbanAt` fields persisted in the LongBans collection
// (db/longBansRepo.js).
//
// Also the ONLY thing that ever calls Twitch's ban/timeout/unban endpoints for a long-ban: since
// TwitchBot-Web has no moderation-action credentials, its /<channel>/settings/long-bans page can
// only write a `status: 'pending'` (new request) or `status: 'cancelRequested'` (lift an active
// one) doc - this poller applies the real Helix call and promotes those to 'active'/'cancelled'.
const TwitchBanAPI = require('./TwitchBanAPI.js');
const longBansRepo = require('../db/longBansRepo.js');
const describeError = require('../shared/describeError.js');

// Fast enough that a web-submitted pending/cancelRequested entry takes effect promptly (this is
// just a Mongo poll of a tiny collection - zero Twitch API cost unless something's actually due).
const POLL_INTERVAL_MS = 30 * 1000;
// A renewal fires this long before the current timeout segment's real expiry, so a missed tick
// (or a bot restart) still leaves plenty of slack before the target would actually regain chat
// access early. Must be comfortably larger than POLL_INTERVAL_MS.
const RENEWAL_SAFETY_MARGIN_MS = 2 * 60 * 60 * 1000; // 2h
const MAX_TIMEOUT_MS = 1_209_600 * 1000; // Twitch's own 2-week cap, mirrored from TwitchBanAPI.js

let client;
let interval;

// Segment length is whatever remains, capped at Twitch's 2-week max. If this segment covers the
// rest of the requested duration, no further renewal is needed - the timeout itself expires
// exactly on time via Twitch, so nextRenewalAt is just set to unbanAt (the next tick will see
// `remaining <= 0` and mark the doc completed without touching Twitch again).
function computeNextRenewalAt(now, appliedMs, unbanAtMs) {
  const coversRemainder = now + appliedMs >= unbanAtMs;
  return coversRemainder ? new Date(unbanAtMs) : new Date(now + appliedMs - RENEWAL_SAFETY_MARGIN_MS);
}

async function processRenewal(doc) {
  const now = Date.now();
  const remainingMs = doc.unbanAt.getTime() - now;
  if (remainingMs <= 0) {
    await longBansRepo.updateById(doc._id, { status: 'completed' });
    return;
  }

  const appliedSeconds = Math.min(1_209_600, Math.ceil(remainingMs / 1000));
  await TwitchBanAPI.timeout(doc.userId, appliedSeconds, doc.channelId, doc.reason);
  const nextRenewalAt = computeNextRenewalAt(now, appliedSeconds * 1000, doc.unbanAt.getTime());
  await longBansRepo.updateById(doc._id, { nextRenewalAt });
}

async function processUnban(doc) {
  const success = await TwitchBanAPI.unban(doc.userId, doc.channelId);
  // TwitchBanAPI.unban already logged the failure - leave the doc active so the next poll retries.
  // A persistent failure (e.g. the target was already unbanned outside !cancellongban) retries
  // and re-logs every tick forever; no backoff/attempt-cap exists anywhere else in this codebase
  // either, so this matches existing convention rather than inventing one.
  if (!success) return;

  await longBansRepo.updateById(doc._id, { status: 'completed' });
  if (client) {
    client.say(`#${doc.channelLogin}`, `@${doc.userLogin} автоматически разбанен — истёк срок длительного бана VoHiYo `)
      .catch(err => console.error(`[LongBan] Failed to announce unban for ${doc.userLogin}:`, describeError(err)));
  }
}

// A web-submitted long-ban request: applies the real Helix ban/timeout call (the doc already
// carries a resolved userId - TwitchBot-Web resolves login->id itself before writing it) and
// promotes the doc to 'active'.
async function processPending(doc) {
  const now = Date.now();

  // Race guard: something else (a chat !longban, or a near-simultaneous second web submission)
  // may have created an occupying entry for this user between the web form's own pre-check and
  // this poll picking the pending doc up.
  const conflict = await longBansRepo.findActive(doc.channelId, doc.userId);
  if (conflict && String(conflict._id) !== String(doc._id)) {
    await longBansRepo.updateById(doc._id, {
      status: 'failed',
      failureReason: "Пользователь уже находится под long-ban'ом",
    });
    return;
  }

  const durationMs = doc.unbanAt.getTime() - now;
  if (doc.mode === 'timeout') {
    const appliedSeconds = Math.min(1_209_600, Math.max(1, Math.ceil(durationMs / 1000)));
    await TwitchBanAPI.timeout(doc.userId, appliedSeconds, doc.channelId, doc.reason);
    const nextRenewalAt = computeNextRenewalAt(now, appliedSeconds * 1000, doc.unbanAt.getTime());
    await longBansRepo.updateById(doc._id, { status: 'active', nextRenewalAt });
  } else {
    await TwitchBanAPI.ban(doc.userId, doc.channelId, doc.reason);
    await longBansRepo.updateById(doc._id, { status: 'active', nextRenewalAt: doc.unbanAt });
  }
}

// A web-requested early cancellation of an 'active' long-ban - lifts it via Twitch's unban
// endpoint (works for both a real ban and an active timeout) and promotes to 'cancelled'.
async function processCancelRequest(doc) {
  const success = await TwitchBanAPI.unban(doc.userId, doc.channelId);
  if (!success) return; // retry next tick
  await longBansRepo.updateById(doc._id, { status: 'cancelled' });
}

async function tick() {
  const now = new Date();
  const [renewals, unbans, pending, cancelRequests] = await Promise.all([
    longBansRepo.findDueRenewals(now),
    longBansRepo.findDueUnbans(now),
    longBansRepo.findPending(),
    longBansRepo.findCancelRequested(),
  ]);

  for (const doc of renewals) {
    await processRenewal(doc).catch(err =>
      console.error(`[LongBan] Renewal failed for ${doc.userLogin} in #${doc.channelLogin}:`, describeError(err))
    );
  }
  for (const doc of unbans) {
    await processUnban(doc).catch(err =>
      console.error(`[LongBan] Scheduled unban failed for ${doc.userLogin} in #${doc.channelLogin}:`, describeError(err))
    );
  }
  for (const doc of pending) {
    await processPending(doc).catch(err =>
      console.error(`[LongBan] Failed to apply pending long-ban for ${doc.userLogin} in #${doc.channelLogin}:`, describeError(err))
    );
  }
  for (const doc of cancelRequests) {
    await processCancelRequest(doc).catch(err =>
      console.error(`[LongBan] Failed to process cancel request for ${doc.userLogin} in #${doc.channelLogin}:`, describeError(err))
    );
  }
}

// Called once from index.js. Needs `client` to announce a completed scheduled unban in chat.
function start(botClient) {
  client = botClient;
  if (interval) return;
  interval = setInterval(() => {
    tick().catch(err => console.error('[LongBan] Scheduler tick failed:', describeError(err)));
  }, POLL_INTERVAL_MS);
  interval.unref?.();
}

module.exports = { start, tick, POLL_INTERVAL_MS, RENEWAL_SAFETY_MARGIN_MS, MAX_TIMEOUT_MS };
