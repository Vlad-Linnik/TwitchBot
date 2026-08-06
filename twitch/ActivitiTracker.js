const axios = require('axios');
const botInitInfo = require('../botInitInfo');
const ChatStats = require('../db/chatStats.js');
const streamStatus = require('./streamStatus.js');
const moderators = require('./moderators.js');
const emoteSyncScheduler = require('./emoteSyncScheduler.js');
const describeError = require('../shared/describeError.js');

// ensureOpenSession's staleAfterMs: below this gap since the last recorded viewer sample, a bot
// restart (crash/redeploy) mid-stream resumes the same StreamSessions row instead of splitting
// the web panel's "Статистика стрима" chart into a new stream date. Above it, the session is
// presumed abandoned (the real stream likely ended, possibly a new one started) and gets closed
// at its own last-known-good timestamp instead. A fixed 1 hour rather than a multiple of the poll
// interval, since the thing being bounded is bot downtime, not poll cadence.
const SESSION_RESTART_GRACE_MS = 60 * 60 * 1000;

// How many consecutive offline readings it takes before the stream is believed to have ended.
//
// fetchStreamInfo() already refuses to treat a FAILED call as evidence of going offline (it
// returns null - see its comment), but a *successful* Get Streams call returning an empty array
// isn't proof either: a streamer's OBS/network blip, or Twitch's own eventual consistency, makes
// a live channel read as offline for a single poll now and then. Believing one such sample closed
// the session and the next poll opened a brand-new one - which is why #mistercop's 2026-08-05
// stream shows up as two separate entries in the web panel's "Статистика стрима" picker instead
// of one. Requiring the reading to repeat costs up to one extra poll interval of delay on a real
// stream end, which nothing here is sensitive to (the daily mod-stats rollup this gates also runs
// on every live tick, so it isn't the only chance to record the day).
const OFFLINE_CONFIRMATIONS = 2;

class ModActivityTracker {
    constructor(broadcasterId, channelLogin, checkIntervalMs = 300000) {
        this.broadcasterId = broadcasterId;
        this.channelLogin = channelLogin;
        this.intervalMs = checkIntervalMs;
        this.timer = null;
        this.isLive = true;
        this.isChecking = false; // guards against overlapping runs if a cycle takes longer than intervalMs
        this.lastCheckTime = null; // used to compute real elapsed delta between checks
        this.lastStatsDate = null; // local calendar date (toDateString()) daily mod stats were last recorded for,
                                    // guards against recomputing every time the stream flaps offline within the same day
        this.offlineChecks = 0;    // consecutive offline readings while still believed live (see OFFLINE_CONFIRMATIONS)
        this.firstOfflineAt = null; // timestamp of the first of them - the honest end time for the session
    }

    // Returns the live stream object (truthy, includes game_name/game_id) when live, `false`
    // when confirmed offline, or `null` when the check itself failed - a transient API/network
    // error is NOT evidence the stream went offline, so callers must treat null as "unknown, try
    // again next cycle" rather than as a real transition.
    async fetchStreamInfo() {
        try {
            const response = await axios.get('https://api.twitch.tv/helix/streams', {
                params: {
                    user_id: this.broadcasterId
                },
                headers: {
                    'Authorization': `Bearer ${botInitInfo.settings['password']}`,
                    'Client-Id': botInitInfo.settings['Client_Id']
                }
            });
            const streams = response.data && response.data.data;
            return streams && streams.length > 0 ? streams[0] : false;
        } catch (error) {
            console.error('[ModTracker] Error Stream status:', describeError(error));
            return null;
        }
    }

    async getAllChatters() {
        const chatters = [];
        let after = '';

        try {
            do {
                const response = await axios.get('https://api.twitch.tv/helix/chat/chatters', {
                    params: {
                        broadcaster_id: this.broadcasterId,
                        moderator_id: botInitInfo.settings["bot_id"],
                        first: 1000,
                        after: after || undefined
                    },
                    headers: {
                        'Authorization': `Bearer ${botInitInfo.settings['password']}`,
                        'Client-Id': botInitInfo.settings['Client_Id']
                    }
                });

                chatters.push(...response.data.data);
                after = response.data.pagination?.cursor;

            } while (after);
            return chatters;
        } catch (error) {
            console.error('[ModTracker] Error:', describeError(error));
            return [];
        }
    }

    async checkActivity() {
        // A previous cycle (slow API, big chatter list) can still be running when the next
        // tick fires; without this guard both would read/write this.lastCheckTime concurrently
        // and double-count the same wall-clock window into ModUpTimeStats.
        if (this.isChecking) {
            console.log('[ModTracker] Previous check still in progress, skipping this tick.');
            return;
        }
        this.isChecking = true;

        try {
            // Read fresh every cycle so mod/unmod EventSub updates (see events.js) are picked
            // up without needing a bot restart - the cache itself is updated in real time, so
            // this is just a synchronous read, not a network call.
            // The broadcaster is never granted "mod" via channel.moderate (Twitch doesn't model
            // it that way), so moderators.js's ModsList-derived cache never contains them - union
            // them in here so the owner gets tracked the same as any other moderator.
            const currentModerators = new Set(moderators.getModerators(this.broadcasterId));
            currentModerators.add(String(this.broadcasterId));

            const streamInfo = await this.fetchStreamInfo();
            const now = Date.now();

            if (streamInfo === null) {
                // Status unknown this cycle - don't touch isLive/lastCheckTime/streamStatus,
                // and don't treat it as an offline transition. Just retry next cycle.
                return;
            }

            const liveResult = !!streamInfo;
            streamStatus.setLive(this.broadcasterId, liveResult);
            streamStatus.setCategory(this.broadcasterId, liveResult ? streamInfo.game_name : null);

            if (!liveResult) {
                // Don't let an offline gap get counted as activity time once the stream comes back.
                // Unconditional: this holds whether or not the offline reading turns out to be real,
                // since either way no live minutes happened between this poll and the previous one.
                this.lastCheckTime = null;

                if (this.isLive) {
                    if (this.offlineChecks === 0) this.firstOfflineAt = now;
                    this.offlineChecks++;

                    // Not confirmed yet - stay "live" so a single-poll flicker doesn't end the
                    // session (see OFFLINE_CONFIRMATIONS). streamStatus was already set offline
                    // above, which is what we want regardless: auto-sends shouldn't fire into a
                    // channel Twitch is currently reporting as dark.
                    if (this.offlineChecks < OFFLINE_CONFIRMATIONS) {
                        console.log(`[ModTracker] [${this.channelLogin}] Reported offline (${this.offlineChecks}/${OFFLINE_CONFIRMATIONS}), awaiting confirmation`);
                        return;
                    }

                    console.log(`[ModTracker] [${this.channelLogin}] Stream is offline`);
                    this.isLive = false;
                    this.recordDailyModeratorStats(currentModerators);
                    // Closed at the FIRST offline reading, not this confirming one - otherwise every
                    // stream's chart would gain a dead tail as long as the confirmation delay.
                    ChatStats.endStreamSession(this.broadcasterId, new Date(this.firstOfflineAt))
                        .catch(err => console.error('[ModTracker] endStreamSession error:', err));
                    // Streak consumed. Without this the next stream's first live poll would report
                    // itself as a disproven flicker; the `isLive` guard above keeps the counter
                    // from restarting while we stay offline.
                    this.offlineChecks = 0;
                    this.firstOfflineAt = null;
                }
                return;
            }

            // Live again - discard any unconfirmed offline streak (a flicker, now disproven).
            if (this.offlineChecks > 0) {
                console.log(`[ModTracker] [${this.channelLogin}] Back live - offline reading was a flicker, session kept`);
            }
            this.offlineChecks = 0;
            this.firstOfflineAt = null;

            const wasLiveWithBaseline = this.isLive && this.lastCheckTime !== null;
            const justWentLive = !this.isLive;
            if (justWentLive) {
                console.log(`[ModTracker] [${this.channelLogin}] Stream started`);
            }
            this.isLive = true;

            // Piggyback the viewer/category history collector on this same poll - see
            // ChatStats.ensureOpenSession/recordStreamSample and SESSION_RESTART_GRACE_MS above.
            ChatStats.ensureOpenSession(this.broadcasterId, this.channelLogin, new Date(now), SESSION_RESTART_GRACE_MS)
                .catch(err => console.error('[ModTracker] ensureOpenSession error:', err));
            ChatStats.recordStreamSample(this.broadcasterId, new Date(now), streamInfo.viewer_count, streamInfo.game_name || null)
                .catch(err => console.error('[ModTracker] recordStreamSample error:', err));

            // Refresh "today"'s ModeratorStatistics row on every live tick, not just the
            // offline transition - otherwise the web panel's day-period view stays empty for
            // the entire stream: the row this call would write right as the stream goes live
            // is all-zero (nobody's chatted/moderated in the first instant) and gets skipped
            // (see recordDailyModeratorStats), so without a mid-stream refresh nothing appears
            // until either an hour passed or the stream ends. This upsert is idempotent (it
            // recomputes the day's totals-so-far, not a running counter), so re-running it
            // every ~intervalMs is safe - it's the same per-tick cost as updateModUpTime above.
            ChatStats.recordDailyModeratorStats(this.broadcasterId, this.channelLogin, [...currentModerators])
                .catch(err => console.error('[ModTracker] mid-stream recordDailyModeratorStats error:', err));

            // Piggyback the emote re-sync schedule on this poll: it already owns the
            // offline->live transition and never reaches here on an unknown (null) status.
            // Fire-and-forget inside the scheduler - never blocks activity accounting.
            emoteSyncScheduler.maybeSyncOnLiveTick(this.channelLogin, justWentLive);

            const currentChatters = await this.getAllChatters();

            // Use real elapsed time since the last successful check when we have a baseline,
            // otherwise fall back to the configured interval (first check after start/restart/resume).
            const intervalStart = wasLiveWithBaseline ? new Date(this.lastCheckTime) : new Date(now - this.intervalMs);
            const intervalEnd = new Date(now);
            this.lastCheckTime = now;

            const activeModIds = currentChatters
                .map(chatter => chatter.user_id)
                .filter(userId => currentModerators.has(userId));

            if (activeModIds.length > 0) {
                console.log(`[ModTracker] [${this.channelLogin}] Active moderators: ${activeModIds.length}`);
                this.saveToDatabase(activeModIds, intervalStart, intervalEnd);
            }
        } finally {
            this.isChecking = false;
        }
    }

    saveToDatabase(activeModIds, intervalStart, intervalEnd) {
        ChatStats.updateModUpTime(this.broadcasterId, activeModIds, intervalStart, intervalEnd)
            .catch(err => console.error('[ModTracker] updateModUpTime error:', err));
    }

    // Fired once per calendar day, right as the stream goes offline - that moment marks the
    // day's moderation activity as "done" without needing a separate cron schedule. Uses the
    // local calendar date (matching the local setHours(0,0,0,0) bucketing chatStats.js uses for
    // the actual day-range queries) rather than UTC, so the guard can't disagree with the data.
    recordDailyModeratorStats(currentModerators) {
        const today = new Date().toDateString();
        if (this.lastStatsDate === today) return;
        this.lastStatsDate = today;

        ChatStats.recordDailyModeratorStats(this.broadcasterId, this.channelLogin, [...currentModerators])
            .catch(err => console.error('[ModTracker] recordDailyModeratorStats error:', err));
    }

    async start() {
        await this.checkActivity();
        this.timer = setInterval(() => this.checkActivity(), this.intervalMs);
        console.log(`[ModTracker] [${this.channelLogin}] running... Interval = ${this.intervalMs / 1000} seconds.`);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        console.log('[ModTracker] Stopt.');
    }
}

module.exports = ModActivityTracker;
