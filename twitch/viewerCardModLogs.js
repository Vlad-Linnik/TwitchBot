// The moderator "viewer card" facts behind the Бюро амнистии dossier: the free-text moderator
// comments left on a user, and this channel's REAL lifetime ban/timeout/warning counts for them.
//
// Undocumented GraphQL - see twitch/gqlClient.js's header for the token, the risks, how the field
// names were derived, and why nothing here throws.
//
// One round trip fills the whole card. Verified 2026-08-07 against #vlad_261: the three punishment
// counts come back as 1 warn / 49 timeouts / 17 bans for the same user Twitch's own card shows as
// "1/49/17", which is what pins the meaning of that triple.
const gqlClient = require('./gqlClient.js');

// `count` is the number of edges IN THE REQUESTED PAGE, not a total - asking for `first: 1` returns
// `count: 1` for a user with 49 timeouts. So the page has to be big enough to hold the whole
// history, and `pageInfo.hasNextPage` is the only signal that it wasn't. 1000 is well past any
// plausible per-user history and Twitch accepts it; a user beyond it is reported as truncated
// rather than silently under-counted.
const COUNT_PAGE_SIZE = 1000;
// Twitch pages comments too, but a user with more moderator comments than this in one channel is
// not a case a review page needs to render in full - the point is the first screenful.
const MAX_COMMENTS = 50;
// The punishment list the review page shows per action type. Separate from COUNT_PAGE_SIZE because
// the two want opposite things: an exact count needs a page bigger than any real history, while
// the rows themselves are read by a human who will never scroll past the last few dozen.
const MAX_ACTION_ROWS = 50;
// Twitch's own copy of the user's chat history, which the review page reads when OUR `messages`
// collection can't answer - either because the bot joined the channel long after this user was
// active, or because a moderator paged back past the oldest line we hold.
//
// One request, no cursor paging: Twitch answered `first: 500` with a whole 439-entry history and
// `hasNextPage: false` for the deepest test user available, so a second round trip would almost
// always come back empty. A user beyond 500 simply has their log stop there - the same way it
// stops today when our own records run out, and honest either way. Note this is a snapshot stored
// on a Mongo document, so the ceiling is also what keeps that document a sane size.
const MAX_MESSAGES = 500;

// Every action type Twitch's mod log tracks against one user in one channel. This is the COMPLETE
// set: the enum was brute-forced 2026-08-08 (scripts/local/probeEnum.js) and everything else is
// rejected as an invalid value - there is no DELETE, MOD, VIP or RAID here.
//
// Reading only the first three (all this asked for until 2026-08-08) doesn't just omit rows, it
// misrepresents the applicant: the live test case shows 3 bans of which all 3 were LIFTED, so a
// serial offender and someone the moderators kept forgiving rendered identically.
//
// `selfActed` marks the two entries the user performs on themselves rather than a moderator. Their
// label carries a single user fragment - the applicant - and the parser below would otherwise
// report them as the moderator who acted, crediting the applicant with filing their own verdict.
const ACTION_TYPES = [
  { type: 'BAN', key: 'bans' },
  { type: 'TIMEOUT', key: 'timeouts' },
  { type: 'WARN', key: 'warns' },
  { type: 'UNBAN', key: 'unbans' },
  { type: 'UNTIMEOUT', key: 'untimeouts' },
  { type: 'ACKNOWLEDGE_WARNING', key: 'warnAcks', selfActed: true },
  // The applicant's own appeal history in this channel. `unbanRequests` counts EVERY request ever
  // filed including the one being reviewed right now, so it is not a "has done this before" figure;
  // the two resolved counts are, and they're the only ones the page reasons about.
  { type: 'UNBAN_REQUEST_CREATED', key: 'unbanRequests', selfActed: true },
  { type: 'UNBAN_REQUEST_APPROVED', key: 'unbanRequestsApproved' },
  { type: 'UNBAN_REQUEST_DENIED', key: 'unbanRequestsDenied' },
];

// One action-type block: the rows AND the exact count, which need different page sizes.
//
// `type` is requested on the node but deliberately NOT used as the discriminator - an
// UNBAN_REQUEST_CREATED row comes back as `type: "UNKNOWN"` (verified against a real request), so
// each row is tagged with the type of the block it was asked under instead.
function actionBlock({ key, type }) {
  return `
      ${key}Count: targetedActions(first: $countPage, type: ${type}) {
        ... on ModLogsTargetedActionsConnection { count pageInfo { hasNextPage } }
      }
      ${key}Rows: targetedActions(first: ${MAX_ACTION_ROWS}, type: ${type}) {
        ... on ModLogsTargetedActionsConnection {
          edges { node { id timestamp type localizedLabel {
            localizedStringFragments { token {
              ... on ModActionsLocalizedTextToken { text }
              ... on User { id login displayName }
            } }
          } } }
        }
      }`;
}

// Both comment lists are per (channel, target):
//   comments       - written by this channel's own moderators
//   sharedComments - written in OTHER channels that share their bans with this one (a channel-level
//                    Twitch setting, so an empty list is the normal case, not a failure)
// The count fields are aliases over one `targetedActions(type:)` field; WARN is the enum value for
// a warning (WARNING is rejected), and its count comes back null - not 0 - for a user who has
// never been warned.
// `User.relationship` IS NOT HERE ANY MORE, and must not be added back without re-testing.
//
// It used to supply the applicant's subscription state (`relationship.subscriptionBenefit`), read
// from the TARGET's side the way Twitch's own card does. As of 2026-08-14 Twitch put that one field
// behind its anti-automation gate: a document containing it is answered `failed integrity check`
// and NOTHING in the document resolves - one gated field costs the entire dossier, comments, counts
// and all. Bisected 2026-08-15 (scripts/local/gqlBisect.js): every other top-level block here still
// answers normally with the identical token, headers and machine, and both `relationship`
// sub-fields - `subscriptionBenefit` AND `followedAt` - are refused, so it is the field itself that
// is closed rather than anything about subscriptions.
//
// It is dropped rather than retried in a second request: it fails identically every time, so a
// separate call would just trip gqlClient's breaker and take the working half down with it. What
// survives is `channelUser.subscriptionProducts`, which is CHANNEL data and still answers - enough
// to keep saying "nobody can subscribe to this channel", never enough to say "this user is not
// subscribed". See toSubscription() for why that distinction is worth the extra state.
// `chatModeratorStrikeStatus` and `lowTrustUserProperties` are ROOT fields, not part of
// viewerCardModLogs, and both take (channelID, userID) - not the targetID/targetUserID spelling
// the mod-log fields use.
//
// The strike status is the punishment that is IN FORCE right now, which is a different question
// from "the last one on record" and the one a review page actually needs: our own lastBan comes
// out of ModeratorActionLogs and for #vlad_261's test case named the wrong moderator and date
// entirely (the bot's last recorded timeout, not the human ban being appealed).
// `bansSharingSettings` is about the CHANNEL, not the applicant, and it is what makes an empty
// `sharedBanChannels`/`sharedComments` readable: on a channel that never joined Twitch's ban-sharing
// program those lists are empty for everyone, and "no shared bans" then means "we cannot know", not
// "clean elsewhere". Exactly the trap `toSubscription` already dodges with `subscriptionProducts`.
// Note it is a UNION type, so its body must be an inline fragment.
const DOSSIER_QUERY = `
  query BureauViewerCard($channelID: ID!, $targetID: ID!, $countPage: Int!) {
    chatModeratorStrikeStatus(channelID: $channelID, userID: $targetID) {
      banDetails { createdAt reason bannedBy { id login displayName } }
      timeoutDetails { createdAt reason expiresAt timedOutBy { id login displayName } }
      warningDetails { createdAt reason warnedBy { id login displayName } }
    }
    lowTrustUserProperties(channelID: $channelID, userID: $targetID) {
      types
      treatment { type updatedAt updatedBy { id login displayName } }
      banEvasion { likelihood evaluatedAt }
      potentialHarasser { likelihood evaluatedAt }
      sharedBanChannels { id name }
      channelSharedBansUpdatedAt
    }
    channel(id: $channelID) {
      moderationSettings {
        bansSharingSettings {
          ... on BansSharingSettings {
            isEnabled isModCommentsSharingDisabled shareWithTypes treatment
          }
        }
      }
    }
    channelUser: user(id: $channelID) {
      subscriptionProducts { id }
      chatSettings { rules }
    }
    viewerCardModLogs(channelID: $channelID, targetID: $targetID) {
      comments(first: ${MAX_COMMENTS}) {
        ... on ModLogsCommentConnection {
          edges { node { id timestamp text isShareable author { id login displayName chatColor } } }
        }
      }
      sharedComments(first: ${MAX_COMMENTS}) {
        ... on SharedModLogsCommentConnection {
          edges { node { id timestamp text author { id login displayName chatColor } channel { id login } } }
        }
      }
      ${ACTION_TYPES.map(actionBlock).join('')}
      messages(first: ${MAX_MESSAGES}) {
        ... on ViewerCardModLogsMessagesConnection {
          edges { node { ... on ViewerCardModLogsChatMessage { id sentAt content { text } } } }
        }
      }
    }
  }
`;

// An RFC-3339 string -> Date, or null.
//
// Twitch does not consistently answer "never" with null: `channelSharedBansUpdatedAt` comes back as
// "0001-01-01T00:00:00Z" (Go's zero time) for a channel that has never had a shared-ban read. Stored
// as-is that becomes a real Date the page would happily render as a year-1 timestamp, so anything
// before the epoch is treated as absent.
function toDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return null;
  return date;
}

// Flattens one comment edge into the shape stored on the UnbanRequests document.
// `timestamp` arrives as RFC-3339 with nanosecond precision ("2026-08-02T16:50:14.914972761Z"),
// which `new Date()` parses fine (it truncates), so no hand-parsing is needed.
function toComment(edge, shared) {
  const node = edge?.node;
  if (!node) return null;
  return {
    id: String(node.id),
    timestamp: toDate(node.timestamp),
    text: node.text || '',
    authorId: node.author?.id ? String(node.author.id) : null,
    authorLogin: node.author?.login || null,
    authorDisplayName: node.author?.displayName || node.author?.login || null,
    authorColor: node.author?.chatColor || null,
    // Whether the AUTHOR let other channels see it. Only meaningful on this channel's own
    // comments; one that reached us THROUGH sharing carries `shared` plus the channel it was
    // written in, so the page can say where it came from instead of passing another channel's note
    // off as this channel's.
    isShareable: Boolean(node.isShareable),
    shared,
    sourceChannelLogin: shared ? node.channel?.login || null : null,
  };
}

// A count connection -> a plain number. null means "Twitch has no such record", which for WARN is
// how a never-warned user reads, so it collapses to 0 rather than to "unknown".
function toCount(connection) {
  return Number(connection?.count) || 0;
}

// One action row.
//
// `localizedLabel` is the only place the DURATION and the REASON exist - ModLogsTargetedAction has
// no structured field for either (probed; they aren't there). Twitch renders it as a fragment list
// like [mod][" отстраняет пользователя "][target][" на "]["100"][" секунд. Причина: "]["спам"],
// already localized by the Accept-Language gqlClient sends.
//
// So it's split rather than stored whole: the moderator is the FIRST user fragment, the target is
// the LAST one (always the applicant), and everything after that last user fragment is the tail
// that carries duration + reason. The page then writes the verb itself from `type` in the viewer's
// own language and appends only the tail - which keeps the row readable instead of pasting a
// sentence that names the applicant a second time.
//
// A `selfActed` row breaks that geometry: with only one user fragment the verb sits AFTER it
// ("7_emo_4_ka отправляет запрос на снятие блокировки: не буду больше"), so the tail would start
// with a verb the page is about to write itself. Everything up to the first colon is dropped for
// those two, which leaves the one thing worth keeping - the text of that past appeal - and leaves
// nothing at all for a warning acknowledgement. If Twitch rewords either label the field simply
// goes empty rather than pasting a duplicate sentence onto the row.
function toAction(edge, { type, selfActed }) {
  const node = edge?.node;
  if (!node) return null;

  const fragments = node.localizedLabel?.localizedStringFragments || [];
  const users = fragments.filter(fragment => fragment?.token?.login);
  const moderator = selfActed ? null : users[0]?.token || null;
  const lastUserIndex = fragments.map(f => Boolean(f?.token?.login)).lastIndexOf(true);
  const tail = fragments
    .slice(lastUserIndex + 1)
    .map(fragment => fragment?.token?.text || '')
    .join('')
    // A ban's label puts the target LAST ("vlad_261 банит X. Причина: спам"), so its tail opens on
    // the sentence-ending punctuation - trimmed here rather than rendered as ". Причина: спам".
    .replace(/^[\s.,;:]+/, '')
    .trim();
  const colon = tail.indexOf(':');
  const detail = selfActed ? (colon === -1 ? '' : tail.slice(colon + 1).trim()) : tail;

  return {
    id: String(node.id),
    // The block this row was requested under, NOT `node.type` - see actionBlock().
    type,
    timestamp: toDate(node.timestamp),
    // Absent by design on a self-acted row: nobody moderated it.
    modId: moderator?.id ? String(moderator.id) : null,
    modLogin: moderator?.login || null,
    modDisplayName: moderator?.displayName || moderator?.login || null,
    detail, // "на 100 секунд. Причина: спам", or "" for a bare ban
  };
}

// The punishment currently in force, or null if the user is not restricted right now. At most one
// of the three sub-documents is ever set; each names its own actor under a different key.
function toActiveStrike(status) {
  const kinds = [
    { kind: 'ban', details: status?.banDetails, actor: status?.banDetails?.bannedBy },
    { kind: 'timeout', details: status?.timeoutDetails, actor: status?.timeoutDetails?.timedOutBy },
    { kind: 'warn', details: status?.warningDetails, actor: status?.warningDetails?.warnedBy },
  ].find(entry => entry.details);
  if (!kinds) return null;

  const { kind, details, actor } = kinds;
  return {
    kind,
    at: toDate(details.createdAt),
    // Twitch keeps a reason here separately from the mod-log label, and it is very often null -
    // a ban issued from chat carries no reason at all.
    reason: details.reason || null,
    expiresAt: toDate(details.expiresAt),
    modId: actor?.id ? String(actor.id) : null,
    modLogin: actor?.login || null,
    modDisplayName: actor?.displayName || actor?.login || null,
  };
}

// Twitch's own risk read on this user in this channel. Kept because it answers the question an
// amnesty decision actually turns on - is this the same person coming back around a ban - which
// nothing in our own data can even approximate.
//
// Two likelihoods, not one: ban evasion and harassment are separate evaluations of the same user
// and Twitch answers both in this one field, so dropping `potentialHarasser` (as this did until
// 2026-08-08) threw away half the read for nothing.
function toRisk(properties) {
  if (!properties) return null;
  const treatedBy = properties.treatment?.updatedBy;
  return {
    banEvasion: properties.banEvasion?.likelihood || null, // UNLIKELY | POSSIBLE | LIKELY
    banEvasionAt: toDate(properties.banEvasion?.evaluatedAt),
    harassment: properties.potentialHarasser?.likelihood || null, // same three values
    harassmentAt: toDate(properties.potentialHarasser?.evaluatedAt),
    treatment: properties.treatment?.type || null, // NONE | ACTIVE_MONITORING | RESTRICTED
    // Who put them under that treatment and when. Note `updatedAt` is stamped even on a NONE
    // treatment (verified), so it only means anything once `treatment` says something.
    treatmentAt: toDate(properties.treatment?.updatedAt),
    treatmentByLogin: treatedBy?.login || null,
    treatmentByDisplayName: treatedBy?.displayName || treatedBy?.login || null,
    // Twitch's own low-trust classification labels. Empty for a clean user; kept raw because the
    // value set is undocumented and unguessable (the enum can't be introspected).
    types: (properties.types || []).filter(Boolean),
    // Other channels that share their bans with this one and have this user banned.
    sharedBanChannels: (properties.sharedBanChannels || []).map(channel => channel.name).filter(Boolean),
    sharedBansUpdatedAt: toDate(properties.channelSharedBansUpdatedAt),
  };
}

// The CHANNEL's ban-sharing participation - see DOSSIER_QUERY's note. Not about the applicant at
// all, which is why it sits beside `risk` rather than inside it: it says whether `risk`'s
// `sharedBanChannels` and the shared half of `comments` could have held anything in the first place.
// The channel's own posted chat rules (the list under the stream, `chatSettings.rules`). Channel
// data rather than applicant data, like `bansSharingSettings` above, and free-form strings the
// broadcaster typed - Twitch imposes no structure on them, so neither do we.
//
// They are here because an accusation needs a law to cite. Without them the review page's experts
// could only argue from tone, and the absent ban reason - which on most channels simply means the
// moderator did not bother typing one - kept being read as "наказали ни за что".
//
// Null (no rules posted) is deliberately distinct from [] so a reader can tell "channel posted
// none" from "we failed to read them".
function toChannelRules(chatSettings) {
  if (!chatSettings) return null;
  const rules = (chatSettings.rules || []).map((line) => String(line ?? "").trim()).filter(Boolean);
  return rules.length ? rules : null;
}

function toBanSharing(settings) {
  if (!settings) return null;
  return {
    enabled: Boolean(settings.isEnabled),
    // Twitch stores the negative; stored as the positive so a reader doesn't have to invert it.
    commentsShared: settings.isModCommentsSharingDisabled === false,
    // Which channels this one shares WITH: ALL | PARTNERS | AFFILIATES | MUTUAL_FOLLOWERS.
    shareWith: (settings.shareWithTypes || []).filter(Boolean),
    treatment: settings.treatment || null, // what a shared ban does here, e.g. ACTIVE_MONITORING
  };
}

// What is left of the subscription read now that `relationship` is gated (see DOSSIER_QUERY):
// 'unavailable' when Twitch says the channel sells no subscriptions, and NULL - "we don't know" -
// for everyone else. Both consumers already render a null subscription as "неизвестно" /
// "Subscription unknown" (TwitchBot-Web's unban-bureau.js and lib/unbanCaseBrief.js), so this needs
// no change on the web side.
//
// Deliberately NOT 'none'. That value asserts the applicant chose not to support the channel, which
// is a mark against them in an amnesty argument, and we can no longer see it either way - the exact
// mistake the three-state design was built to avoid, just moved one state along. 'subscribed' is
// unreachable for the same reason and stays in the vocabulary only for stored documents mirrored
// before 2026-08-14.
function toSubscription(data) {
  const products = data?.channelUser?.subscriptionProducts;
  // An absent products list (rather than an empty one) means the lookup itself failed - report
  // "unavailable" only when Twitch actually said the channel has no tiers.
  if (Array.isArray(products) && products.length === 0) {
    return { state: 'unavailable', tier: null, prime: false };
  }
  return null;
}

// Everything the viewer card knows about this user in this channel.
//
// Returns null when the token is missing/expired or Twitch answered with something unusable - the
// caller then leaves the dossier's Twitch-sourced half absent, and the page falls back to the
// bot's own records. An EMPTY result is different and returned normally: `{comments: [], counts:
// {...zeros}}` means Twitch genuinely has nothing on them.
async function getViewerCard(channelId, targetUserId) {
  if (!gqlClient.isEnabled()) return null;

  const data = await gqlClient.query(DOSSIER_QUERY, {
    channelID: String(channelId),
    targetID: String(targetUserId),
    countPage: COUNT_PAGE_SIZE,
  });
  const card = data?.viewerCardModLogs;
  if (!card) return null;

  const comments = [
    ...(card.comments?.edges || []).map(edge => toComment(edge, false)),
    ...(card.sharedComments?.edges || []).map(edge => toComment(edge, true)),
  ].filter(Boolean);

  // Each list is newest-first on its own; merged they have to be re-sorted, and a comment with no
  // timestamp sorts oldest rather than jumping to the top.
  comments.sort((a, b) => (b.timestamp?.getTime() || 0) - (a.timestamp?.getTime() || 0));

  // One list, newest first, so the page's punishments tab reads as a single history rather than
  // nine per-type columns. The type is kept on every row for the icon and the verb - and is the
  // only thing that survives the merge, since each row is tagged from its own block.
  const actions = ACTION_TYPES.flatMap(entry =>
    (card[`${entry.key}Rows`]?.edges || []).map(edge => toAction(edge, entry))
  )
    .filter(Boolean)
    .sort((a, b) => (b.timestamp?.getTime() || 0) - (a.timestamp?.getTime() || 0));

  // The message feed interleaves mod-action entries with real chat lines; only the chat lines are
  // wanted here (the actions are the list above), and an action node has no `content.text`, so
  // filtering on that is also what drops them.
  const messages = (card.messages?.edges || [])
    .map(edge => edge?.node)
    .filter(node => node && node.content && typeof node.content.text === 'string')
    .map(node => ({
      id: String(node.id),
      timestamp: toDate(node.sentAt),
      text: node.content.text,
    }))
    .sort((a, b) => (a.timestamp?.getTime() || 0) - (b.timestamp?.getTime() || 0));

  // One key per ACTION_TYPES entry, plus `truncated`: true only if some history actually overflowed
  // COUNT_PAGE_SIZE, in which case the page shows "1000+" rather than a number it can't stand behind.
  const counts = { truncated: false };
  for (const entry of ACTION_TYPES) {
    counts[entry.key] = toCount(card[`${entry.key}Count`]);
    if (card[`${entry.key}Count`]?.pageInfo?.hasNextPage) counts.truncated = true;
  }

  return {
    comments: comments.slice(0, MAX_COMMENTS),
    subscription: toSubscription(data),
    activeStrike: toActiveStrike(data.chatModeratorStrikeStatus),
    risk: toRisk(data.lowTrustUserProperties),
    banSharing: toBanSharing(data.channel?.moderationSettings?.bansSharingSettings),
    channelRules: toChannelRules(data.channelUser?.chatSettings),
    actions,
    messages,
    counts,
  };
}

module.exports = { getViewerCard };
