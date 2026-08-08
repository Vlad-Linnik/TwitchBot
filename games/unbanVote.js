// Chat voting for the "Бюро амнистии" review page (TwitchBot-Web's /:channel/unban-bureau).
// While an appeal is at the review window, chat's emote votes are tallied here and shown on the
// page as a live bar. ADVISORY ONLY - nothing here ever approves or denies anything.
//
// The bot is SILENT throughout: it posts no prompt, no running tally and no result. This is an
// on-stream game - chat sees the desk on the broadcast, and a bot narrating it is just noise
// (owner's call). So this module only ever listens.
//
// Per-channel state in a Map keyed by '#channel', seeded for boot channels and extended by
// addChannel() for channels joined later - same shape as games/muteDuel.js and games/randomEvents.js.
//
// recordVote() is called from index.js's chat handler DIRECTLY, not through
// commands/msgHandle.js's execCommands: that router only ever sees '!'/'#'-prefixed messages, and
// votes are bare emotes. So it has to be cheap on the overwhelming majority of messages where no
// vote is running - hence the single Map lookup + null check before anything else happens.
const unbanRequestsRepo = require('../db/unbanRequestsRepo.js');
const botInitInfo = require('../botInitInfo.js');
const describeError = require('../shared/describeError.js');

// The live tally is written back to Mongo so the review page can render a moving bar, but a busy
// chat would otherwise produce one write per vote. Coalesced: at most one write per this interval
// per channel, plus a final one when the vote closes.
const TALLY_FLUSH_INTERVAL_MS = 3000;

const activeVotes = new Map();

for (const channel of Object.keys(botInitInfo.channels)) {
  activeVotes.set(`#${channel}`, null);
}

// Seeds this module's per-channel slot for a channel joined after boot (see
// twitch/channelJoinScheduler.js), matching games/muteDuel.js's addChannel().
function addChannel(channel) {
  if (activeVotes.has(channel)) return;
  activeVotes.set(channel, null);
}

function flushTally(vote) {
  vote.lastFlushAt = Date.now();
  vote.dirty = false;
  // Fire-and-forget: an advisory tally is never worth blocking the chat handler on, and the vote's
  // authoritative counts are written again when it closes.
  unbanRequestsRepo
    .setVoteTally(vote.docId, vote.approve.size, vote.deny.size)
    .catch(err => console.error('[UnbanVote] Tally flush failed:', describeError(err)));
}

// Opens the voting window, when an appeal reaches the review window. Replaces any vote already
// running in that channel - one at a time per channel, since chat can only meaningfully answer one
// question at once. `endsAt` is null for votes opened this way; see recordVote.
function startVote(channel, { docId, requestId, userLogin, endsAt, approveEmote, denyEmote }) {
  activeVotes.set(channel, {
    docId,
    requestId,
    userLogin,
    endsAt,
    // Lowercased once here so recordVote() doesn't re-lowercase per message.
    approveEmote: approveEmote.toLowerCase(),
    denyEmote: denyEmote.toLowerCase(),
    approve: new Set(),
    deny: new Set(),
    dirty: false,
    lastFlushAt: 0,
  });
}

// Rehydrates a vote that was still running when the bot restarted. The per-voter sets can't be
// recovered (they only ever lived in memory), so it resumes from the persisted counts by seeding
// the sets with placeholder entries - the tally stays right, and the only cost is that someone who
// already voted before the restart could vote a second time.
function resumeVote(channel, doc) {
  startVote(channel, {
    docId: doc._id,
    requestId: doc.requestId,
    userLogin: doc.userLogin,
    endsAt: doc.vote.endsAt,
    approveEmote: doc.vote.approveEmote,
    denyEmote: doc.vote.denyEmote,
  });
  const vote = activeVotes.get(channel);
  for (let i = 0; i < (doc.vote.approve || 0); i += 1) vote.approve.add(`__restored_${i}`);
  for (let i = 0; i < (doc.vote.deny || 0); i += 1) vote.deny.add(`__restored_${i}`);
}

// Returns 0/1 like a command handler, but the caller ignores it - a vote must never short-circuit
// the rest of the chat pipeline (the message is still an ordinary chat message that should be
// logged, counted and spam-checked).
function recordVote(channel, userState, message) {
  const vote = activeVotes.get(channel);
  if (!vote) return 0;

  // A vote has no end time any more - it lasts as long as the appeal is at the review window, and
  // twitch/unbanRequestScheduler.js closes it on the verdict. `endsAt` is kept only for docs
  // written before that change, which still carry a real deadline.
  if (vote.endsAt && Date.now() >= vote.endsAt.getTime()) return 0;

  const voterId = userState['user-id'];
  if (!voterId) return 0;

  let side = null;
  for (const token of message.split(/\s+/)) {
    const lowered = token.toLowerCase();
    if (lowered === vote.approveEmote) { side = 'approve'; break; }
    if (lowered === vote.denyEmote) { side = 'deny'; break; }
  }
  if (!side) return 0;

  // Changing your mind is allowed: the voter is removed from the other side first, so the two
  // sets stay disjoint and each voter counts exactly once.
  const [into, outOf] = side === 'approve' ? [vote.approve, vote.deny] : [vote.deny, vote.approve];
  if (into.has(voterId)) return 1; // already on this side, nothing changed
  outOf.delete(voterId);
  into.add(voterId);
  vote.dirty = true;

  if (Date.now() - vote.lastFlushAt >= TALLY_FLUSH_INTERVAL_MS) flushTally(vote);
  return 1;
}

// Ends the window and hands back the final counts for the scheduler to persist.
//
// `docId` is REQUIRED and checked, because this module's state is keyed by channel while the
// scheduler closes votes per REQUEST. Within one tick, twitch/unbanRequestScheduler.js starts newly
// requested votes before closing due ones - so with two appeals open in a channel, the vote sitting
// in memory when a closure runs can easily belong to a different request than the one being closed.
// Without this check that closure would write the WRONG tally onto its document (the freshly
// started vote's 0/0) and, worse, drop the running vote from memory so it silently stopped counting
// while still reading 'active' in Mongo. Refusing here makes the caller fall back to the persisted
// counters, which games/unbanVote.js's own flush keeps current, and leaves the running vote alone.
function closeVote(channel, docId) {
  const vote = activeVotes.get(channel);
  if (!vote) return null;
  if (String(vote.docId) !== String(docId)) return null;
  activeVotes.set(channel, null);
  return { docId: vote.docId, approve: vote.approve.size, deny: vote.deny.size };
}

// Whether this channel currently has a vote running - lets the scheduler avoid starting a second
// one and lets it detect a vote whose in-memory state was lost.
function hasActiveVote(channel) {
  return Boolean(activeVotes.get(channel));
}

module.exports = {
  addChannel,
  startVote,
  resumeVote,
  recordVote,
  closeVote,
  hasActiveVote,
  TALLY_FLUSH_INTERVAL_MS,
};
