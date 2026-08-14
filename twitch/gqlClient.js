// Twitch's PRIVATE GraphQL endpoint (gql.twitch.tv) - the one twitch.tv itself uses.
//
// WHY THIS EXISTS AT ALL. The moderator "viewer card" shows two things Helix has no endpoint for
// at any scope: the free-text moderator comments left on a user, and that channel's real lifetime
// ban/timeout/warning counts for them. The "Бюро амнистии" review page needs both - our own
// ModeratorActionLogs only knows what the bot itself witnessed since it joined, which for an old
// account is a small fraction of the truth (verified 2026-08-07: a user Twitch counts at 17 bans
// and 49 timeouts had 0 of each on record here). There is no supported API for either, so this
// speaks the same undocumented protocol the website does.
//
// WHAT THAT COSTS, and why every caller must degrade gracefully:
//   - It is UNDOCUMENTED and unversioned. Twitch can change a field's shape without notice or
//     deprecation. A caller must treat "no data" as normal, never as an error worth failing on.
//   - It needs a WEB SESSION token (the `auth-token` cookie of a logged-in twitch.tv session),
//     NOT the bot's Helix OAuth token. The two are not interchangeable: this endpoint pairs the
//     token with the website's own Client-Id below and rejects a dev-console app's credentials.
//   - That token is FULL ACCOUNT ACCESS, not a scoped grant. It lives in the bot's .env
//     (`gql_auth_token`) and nowhere else - never in Mongo, never sent to a browser, never in
//     TwitchBot-Web (which by design holds no moderation credentials at all - see ../CLAUDE.md).
//     It dies when that browser session is logged out; closing the tab is fine.
//   - `isEnabled()` is false without a token, and a 401/403 disables calls for
//     DISABLE_AFTER_AUTH_FAIL_MS rather than re-failing on every poll.
//
// RAW QUERIES, NOT PERSISTED HASHES. The website sends only an operation name plus a sha256 hash
// of a query stored server-side; this module sends the query text instead. Both are accepted.
// Raw is the deliberate choice: a captured hash silently stops working whenever Twitch rebuilds
// that operation (answering `PersistedQueryNotFound`), and re-capturing means a human with
// DevTools. A query written against the field names survives that.
//
// FINDING FIELD NAMES. Introspection is disabled - `__type`/`__schema` return an empty object
// rather than an error. But Twitch still VALIDATES raw queries against the real schema, so its
// error messages are a usable oracle: "Cannot query field X on type Y" tells you the field
// doesn't exist, "Unknown argument Z" narrows the arg list, and an unlisted enum value comes back
// as `Expected type "T", found V`. scripts/local/probeRawGql.js exists for exactly that, and is
// how twitch/viewerCardModLogs.js's query was derived. Note most fields here return UNION types
// (`ModLogsCommentsResult`, `ModLogsTargetedActionsResult`), so their bodies must be inline
// fragments - querying them directly reads as "cannot query field edges on type ...Result".
const axios = require('axios');
const botInitInfo = require('../botInitInfo.js');
const describeError = require('../shared/describeError.js');

const GQL_URL = 'https://gql.twitch.tv/gql';
// twitch.tv's own web client id. Public knowledge (it ships in every page load) and NOT a secret -
// but it is also not ours: the token above must belong to a session issued for THIS client id,
// which is why the bot's own Client_Id cannot be substituted here.
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
// How long to stop calling after Twitch rejects the token. Long enough that a logged-out session
// doesn't produce a 401 per case per poll, short enough that a replaced token starts working again
// without a bot restart.
const DISABLE_AFTER_AUTH_FAIL_MS = 30 * 60 * 1000;
// How many consecutive failures of ANY kind before calls stop for a while. Three is one full
// scheduler tick's worth of cases on a small queue - enough that a single unlucky request doesn't
// pause the feature, few enough that a genuine outage is noticed before it has spent a hundred
// calls. See noteFailure() for why this exists at all.
const FAILURES_BEFORE_BACKOFF = 3;
// The backoff itself, doubling per consecutive trip. Starts at one scheduler tick (nothing is
// gained by retrying faster than the poll that drives it) and caps at the auth cooldown, since past
// that point the difference between "Twitch is down" and "the token is dead" stops mattering.
const BASE_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = DISABLE_AFTER_AUTH_FAIL_MS;
// Twitch localizes mod-log action labels server-side off Accept-Language, and those labels are the
// ONLY place the ban duration and reason appear (there is no structured `reason` field on
// ModLogsTargetedAction - verified). So the language is fixed here rather than per viewer: the
// mirror is stored once per case, not rendered per request, and the panel's primary audience is
// Russian. An `en` UI therefore shows a Russian tail on those rows; the alternative is fetching
// and storing every label twice.
const LABEL_LANGUAGE = 'ru';

// Twitch's own server-side failures, as they appear in a GraphQL `errors[]` entry. These say
// nothing about our query - the next poll normally resolves the same field fine - so they are
// reported as a warning rather than as a fault needing a human. Deliberately a small allow-list
// matched on the message text (the entries carry no error code): anything unrecognised is still
// treated as a real schema break, because failing to notice one of THOSE is the expensive mistake.
const TRANSIENT_ERROR_PATTERNS = [
  /service timeout/i,
  /service error/i,
  /failed to (?:reach|fetch|resolve)/i,
  /internal server error/i,
  /deadline exceeded/i,
  /temporarily unavailable/i,
];

// Twitch's anti-automation gate, and the reason this module has a circuit breaker at all.
// gql.twitch.tv fronts most operations with an integrity check (the website sends a signed
// `Client-Integrity` header obtained from POST /integrity, bound to the client id, the device and
// the user agent); a request without one is answered `failed integrity check`. That is a STANDING
// condition, not a hiccup - the identical request fails identically every time - so it belongs in
// neither bucket above: it is not our query being wrong (a schema break, worth an error and a
// human), and it is not something the next poll resolves. Retrying it is pure cost, and 626 of them
// inside one collapse window on 2026-08-14 is what prompted this.
//
// Deliberately NOT worked around by fetching an integrity token here: that is an arms race against
// a bot-detection system, on an undocumented endpoint, with the bot's full-account session token -
// and the whole feature is already built to degrade to "no data". Backing off is the supported
// behaviour; the dossier just falls back to the bot's own ModeratorActionLogs counts.
const PERMANENT_ERROR_PATTERNS = [
  /failed integrity check/i,
];

function isTransientError(message) {
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

function isPermanentError(message) {
  return PERMANENT_ERROR_PATTERNS.some(pattern => pattern.test(message));
}

let disabledUntil = 0;
let lastFailureAt = null;
// Circuit-breaker state. `consecutiveFailures` counts every kind of failure together on purpose:
// what matters to the caller is that this endpoint is not answering usefully right now, and a
// timeout followed by a 500 followed by an integrity rejection is one bad state, not three.
let consecutiveFailures = 0;
let backoffTrips = 0;
let lastFailureReason = null;

// One failed call. Returns nothing; the effect is on the breaker.
//
// Logging lives here rather than at each call site so a sustained outage costs ONE line per trip
// instead of one per request. The ring buffer collapses identical lines, but it counts them
// forever while they keep arriving (shared/errorRingBuffer.js's window slides off `lastAt`), which
// is how a single dead token rendered as "повторений: 626" on the admin panel.
function noteFailure(reason, { permanent = false } = {}) {
  lastFailureAt = new Date();
  lastFailureReason = reason;
  consecutiveFailures += 1;

  if (permanent) {
    // No point counting to three: this one is known not to fix itself.
    backoffTrips += 1;
    disabledUntil = Date.now() + DISABLE_AFTER_AUTH_FAIL_MS;
    console.error(
      `[GQL] ${reason} - viewer-card lookups paused for ${Math.round(DISABLE_AFTER_AUTH_FAIL_MS / 60000)} min. ` +
      'Twitch is refusing these requests outright, not failing them transiently; the dossier falls ' +
      'back to the bot\'s own ModeratorActionLogs counts until it lets up.'
    );
    return;
  }

  if (consecutiveFailures < FAILURES_BEFORE_BACKOFF) return;

  const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** backoffTrips);
  backoffTrips += 1;
  disabledUntil = Date.now() + backoff;
  console.warn(
    `[GQL] ${consecutiveFailures} consecutive failures - pausing viewer-card lookups for ` +
    `${Math.round(backoff / 1000)}s. Last failure: ${reason}`
  );
}

// A call that actually came back with data. Closes out an open backoff so the next failure starts
// counting from scratch rather than inheriting a doubled window from an outage that ended hours ago.
function noteSuccess() {
  if (consecutiveFailures === 0 && backoffTrips === 0) return;
  if (backoffTrips > 0) {
    console.log(`[GQL] recovered after ${consecutiveFailures} failed attempt(s).`);
  }
  consecutiveFailures = 0;
  backoffTrips = 0;
}

function token() {
  return botInitInfo.settings['gql_auth_token'] || '';
}

// Whether a call is worth attempting at all. Callers use this to skip silently instead of logging
// a failure per request on an install that simply never configured a token.
function isEnabled() {
  return Boolean(token()) && Date.now() >= disabledUntil;
}

// Snapshot for the admin panel's bot-status tile (index.js folds this into the BotHeartbeat
// write). `disabled` reflects the 30-minute cooldown from the last 401/403, which is the closest
// thing to "this needs re-capturing right now" this module can say without spending a real call -
// it can lag up to DISABLE_AFTER_AUTH_FAIL_MS behind an actual fix, same as the console.error it
// mirrors.
function getStatus() {
  return {
    configured: Boolean(token()),
    disabled: Date.now() < disabledUntil,
    disabledUntil: disabledUntil ? new Date(disabledUntil) : null,
    lastFailureAt,
    // Why it is paused, not just that it is - "failed integrity check" and "the token was logged
    // out" both read as `disabled` and need completely different things done about them.
    lastFailureReason,
    consecutiveFailures,
  };
}

// Runs one GraphQL document and returns its `data`, or null if anything at all went wrong.
//
// NEVER throws: every caller is filling in an optional dossier field, not doing something the
// feature depends on. A partial response (some fields resolved, others errored) is returned as
// data with the failed fields null - which is why callers read defensively down the whole path
// rather than trusting the shape.
async function query(document, variables) {
  if (!isEnabled()) return null;

  let response;
  try {
    response = await axios.post(GQL_URL, { query: document, variables }, {
      headers: {
        'Client-Id': WEB_CLIENT_ID,
        Authorization: `OAuth ${token()}`,
        'Accept-Language': LABEL_LANGUAGE,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    const status = error.response?.status;
    if (status === 401 || status === 403) {
      disabledUntil = Date.now() + DISABLE_AFTER_AUTH_FAIL_MS;
      lastFailureAt = new Date();
      lastFailureReason = 'token rejected';
      consecutiveFailures += 1;
      console.error(
        '[GQL] token rejected - viewer-card lookups disabled for 30 min. Re-capture the auth-token ' +
        'cookie of a logged-in moderator session into .env gql_auth_token:',
        describeError(error)
      );
      return null;
    }
    // A transport-level failure (HTTP 500, ECONNABORTED, DNS) says nothing about our query and
    // fixes itself - but only if it is in fact temporary, and repeating it every tick for hours is
    // what the breaker exists to stop. So it is counted rather than logged here.
    noteFailure(`request failed: ${describeError(error)}`);
    return null;
  }

  const errors = response.data?.errors;
  if (errors?.length) {
    // Three very different things arrive in this array. Schema-level errors ("Cannot query
    // field...") mean Twitch changed the shape under us and the query in the calling module
    // genuinely needs re-deriving - the expensive mistake is failing to notice one, so anything
    // unrecognised lands here. Twitch's own server-side hiccups resolve on the next poll. And an
    // integrity rejection is neither: it will not resolve, so it trips the breaker outright.
    // None of the three fails the caller - see the header.
    const messages = errors.map(e => String(e?.message || ''));
    const summary = JSON.stringify(messages).slice(0, 500);
    if (messages.some(isPermanentError)) {
      noteFailure(`Twitch refused the request: ${summary}`, { permanent: true });
      return null;
    }
    if (messages.every(isTransientError)) {
      // Still counted: one of these is genuinely a blip, but forty in a row is an outage, and
      // before the breaker existed those forty were forty log lines and forty wasted calls.
      noteFailure(`transient error: ${summary}`);
      return response.data?.data || null;
    }
    // Loud, and separately from noteFailure(), because this is the one case that needs a human:
    // the raw query has to be re-derived (see the header's note on probeRawGql.js). It is ALSO
    // counted, so a broken query slows itself down instead of re-issuing every tick until someone
    // reads the panel - the error line above is already in the ring buffer by then.
    console.error('[GQL] errors:', summary);
    noteFailure(`schema error: ${summary}`);
    return null;
  }

  const data = response.data?.data || null;
  if (data) noteSuccess();
  return data;
}

module.exports = { isEnabled, query, getStatus };
