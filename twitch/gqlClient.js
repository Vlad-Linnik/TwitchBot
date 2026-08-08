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
// Twitch localizes mod-log action labels server-side off Accept-Language, and those labels are the
// ONLY place the ban duration and reason appear (there is no structured `reason` field on
// ModLogsTargetedAction - verified). So the language is fixed here rather than per viewer: the
// mirror is stored once per case, not rendered per request, and the panel's primary audience is
// Russian. An `en` UI therefore shows a Russian tail on those rows; the alternative is fetching
// and storing every label twice.
const LABEL_LANGUAGE = 'ru';

let disabledUntil = 0;
let lastFailureAt = null;

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
      console.error(
        '[GQL] token rejected - viewer-card lookups disabled for 30 min. Re-capture the auth-token ' +
        'cookie of a logged-in moderator session into .env gql_auth_token:',
        describeError(error)
      );
      return null;
    }
    console.error('[GQL] request failed:', describeError(error));
    return null;
  }

  const errors = response.data?.errors;
  if (errors?.length) {
    // Schema-level errors ("Cannot query field...") mean Twitch changed the shape under us and the
    // query in the calling module needs re-deriving; a bare "server error" at a path is usually
    // transient. Both are logged the same way - loudly, once per call, without failing the caller.
    console.error('[GQL] errors:', JSON.stringify(errors.map(e => e.message)).slice(0, 500));
  }

  return response.data?.data || null;
}

module.exports = { isEnabled, query, getStatus };
