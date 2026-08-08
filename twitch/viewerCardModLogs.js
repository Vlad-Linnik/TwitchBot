// The moderator "viewer card" facts behind the Бюро амнистии dossier: the free-text moderator
// comments left on a user, and this channel's REAL lifetime ban/timeout/warning counts for them.
//
// Undocumented GraphQL - see twitch/gqlClient.js's header for the token, the risks, how the field
// names were derived, and why nothing here throws.
//
// One round trip fills the whole card. Verified 2026-08-07 against #vlad_261: the three counts
// come back as 1 warn / 49 timeouts / 17 bans for the same user Twitch's own card shows as
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

// One action-type block: the rows AND the exact count, which need different page sizes.
function actionBlock(alias, type) {
  return `
      ${alias}Count: targetedActions(first: $countPage, type: ${type}) {
        ... on ModLogsTargetedActionsConnection { count pageInfo { hasNextPage } }
      }
      ${alias}Rows: targetedActions(first: ${MAX_ACTION_ROWS}, type: ${type}) {
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
// Subscription status is a THREE-state answer, and collapsing it to a boolean would put a lie on
// the dossier. `subscriptionBenefit: null` means "not subscribed" only when the channel actually
// sells subscriptions - an unaffiliated channel has an empty `subscriptionProducts` and nobody
// CAN subscribe to it, which is why #vlad_261 reads null for every viewer (verified against
// #forsen, which returns three tiers). The page says which of the two it is.
//
// Note the relationship is read from the TARGET's side (`user(id: targetID).relationship(
// targetUserID: channelID)`) - that's the direction Twitch's own card uses, and its `followedAt`
// matches the Helix follow lookup the bot already does to the second.
// `chatModeratorStrikeStatus` and `lowTrustUserProperties` are ROOT fields, not part of
// viewerCardModLogs, and both take (channelID, userID) - not the targetID/targetUserID spelling
// the mod-log fields use.
//
// The strike status is the punishment that is IN FORCE right now, which is a different question
// from "the last one on record" and the one a review page actually needs: our own lastBan comes
// out of ModeratorActionLogs and for #vlad_261's test case named the wrong moderator and date
// entirely (the bot's last recorded timeout, not the human ban being appealed).
const DOSSIER_QUERY = `
  query BureauViewerCard($channelID: ID!, $targetID: ID!, $countPage: Int!) {
    chatModeratorStrikeStatus(channelID: $channelID, userID: $targetID) {
      banDetails { createdAt reason bannedBy { id login displayName } }
      timeoutDetails { createdAt reason expiresAt timedOutBy { id login displayName } }
      warningDetails { createdAt reason warnedBy { id login displayName } }
    }
    lowTrustUserProperties(channelID: $channelID, userID: $targetID) {
      treatment { type }
      banEvasion { likelihood }
      sharedBanChannels { id name }
    }
    targetUser: user(id: $targetID) {
      relationship(targetUserID: $channelID) {
        subscriptionBenefit { tier purchasedWithPrime }
      }
    }
    channelUser: user(id: $channelID) {
      subscriptionProducts { id }
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
      ${actionBlock('bans', 'BAN')}
      ${actionBlock('timeouts', 'TIMEOUT')}
      ${actionBlock('warns', 'WARN')}
      messages(first: ${MAX_MESSAGES}) {
        ... on ViewerCardModLogsMessagesConnection {
          edges { node { ... on ViewerCardModLogsChatMessage { id sentAt content { text } } } }
        }
      }
    }
  }
`;

// Flattens one comment edge into the shape stored on the UnbanRequests document.
// `timestamp` arrives as RFC-3339 with nanosecond precision ("2026-08-02T16:50:14.914972761Z"),
// which `new Date()` parses fine (it truncates), so no hand-parsing is needed.
function toComment(edge, shared) {
  const node = edge?.node;
  if (!node) return null;
  return {
    id: String(node.id),
    timestamp: node.timestamp ? new Date(node.timestamp) : null,
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

// One punishment row.
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
function toAction(edge) {
  const node = edge?.node;
  if (!node) return null;

  const fragments = node.localizedLabel?.localizedStringFragments || [];
  const users = fragments.filter(fragment => fragment?.token?.login);
  const moderator = users[0]?.token || null;
  const lastUserIndex = fragments.map(f => Boolean(f?.token?.login)).lastIndexOf(true);
  const detail = fragments
    .slice(lastUserIndex + 1)
    .map(fragment => fragment?.token?.text || '')
    .join('')
    .trim();

  return {
    id: String(node.id),
    timestamp: node.timestamp ? new Date(node.timestamp) : null,
    type: node.type || null, // BAN | TIMEOUT | WARN
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
    at: details.createdAt ? new Date(details.createdAt) : null,
    // Twitch keeps a reason here separately from the mod-log label, and it is very often null -
    // a ban issued from chat carries no reason at all.
    reason: details.reason || null,
    expiresAt: details.expiresAt ? new Date(details.expiresAt) : null,
    modId: actor?.id ? String(actor.id) : null,
    modLogin: actor?.login || null,
    modDisplayName: actor?.displayName || actor?.login || null,
  };
}

// Twitch's own risk read on this user in this channel. Kept because it answers the question an
// amnesty decision actually turns on - is this the same person coming back around a ban - which
// nothing in our own data can even approximate.
function toRisk(properties) {
  if (!properties) return null;
  return {
    banEvasion: properties.banEvasion?.likelihood || null, // UNLIKELY | POSSIBLE | LIKELY
    treatment: properties.treatment?.type || null, // NONE | ACTIVE_MONITORING | RESTRICTED
    // Other channels that share their bans with this one and have this user banned.
    sharedBanChannels: (properties.sharedBanChannels || []).map(channel => channel.name).filter(Boolean),
  };
}

// See DOSSIER_QUERY's note: `state` is 'subscribed' | 'none' | 'unavailable', never a boolean.
// `tier` arrives as "1000"/"2000"/"3000" and is reported as 1/2/3; anything unrecognised stays
// null so the page says "subscribed" without inventing a tier.
function toSubscription(data) {
  const benefit = data?.targetUser?.relationship?.subscriptionBenefit;
  if (benefit) {
    const tier = { 1000: 1, 2000: 2, 3000: 3 }[Number(benefit.tier)] || null;
    return { state: 'subscribed', tier, prime: Boolean(benefit.purchasedWithPrime) };
  }
  const products = data?.channelUser?.subscriptionProducts;
  // An absent products list (rather than an empty one) means the lookup itself failed - report
  // "unavailable" only when Twitch actually said the channel has no tiers.
  if (Array.isArray(products) && products.length === 0) {
    return { state: 'unavailable', tier: null, prime: false };
  }
  return { state: 'none', tier: null, prime: false };
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
  // three per-type columns. The type is kept on every row for the icon and the verb.
  const actions = [
    ...(card.bansRows?.edges || []),
    ...(card.timeoutsRows?.edges || []),
    ...(card.warnsRows?.edges || []),
  ]
    .map(toAction)
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
      timestamp: node.sentAt ? new Date(node.sentAt) : null,
      text: node.content.text,
    }))
    .sort((a, b) => (a.timestamp?.getTime() || 0) - (b.timestamp?.getTime() || 0));

  return {
    comments: comments.slice(0, MAX_COMMENTS),
    subscription: toSubscription(data),
    activeStrike: toActiveStrike(data.chatModeratorStrikeStatus),
    risk: toRisk(data.lowTrustUserProperties),
    actions,
    messages,
    counts: {
      bans: toCount(card.bansCount),
      timeouts: toCount(card.timeoutsCount),
      warns: toCount(card.warnsCount),
      // True only if a history actually overflowed COUNT_PAGE_SIZE - the page then shows "1000+"
      // instead of a number it cannot stand behind.
      truncated: Boolean(
        card.bansCount?.pageInfo?.hasNextPage ||
        card.timeoutsCount?.pageInfo?.hasNextPage ||
        card.warnsCount?.pageInfo?.hasNextPage
      ),
    },
  };
}

module.exports = { getViewerCard };
