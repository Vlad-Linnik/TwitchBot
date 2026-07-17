const axios = require('axios');
const botInitInfo = require('../botInitInfo');
const ChatStats = require('../db/chatStats.js');
const streamStatus = require('./streamStatus.js');
const moderators = require('./moderators.js');
const emoteSyncScheduler = require('./emoteSyncScheduler.js');

// How often "today"'s ModeratorStatistics row is refreshed while the stream is live - otherwise
// recordDailyModeratorStats only ever fires on the offline transition, so the web panel's
// day-period view stays empty for the entire duration of an ongoing stream. Re-running it mid-day
// is safe: it's an idempotent upsert of the day's totals-so-far, not a running counter.
const HOURLY_STATS_REFRESH_MS = 60 * 60 * 1000;

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
        this.lastHourlyStatsAt = 0; // Date.now() of the last mid-stream ModeratorStatistics refresh
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
            console.error('[ModTracker] Error Stream status:', error.response?.data || error.message);
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
            console.error('[ModTracker] Error:', error.response?.data || error.message);
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
                if (this.isLive) {
                    console.log(`[ModTracker] [${this.channelLogin}] Stream is offline`);
                    this.isLive = false;
                    this.recordDailyModeratorStats(currentModerators);
                }
                // Don't let an offline gap get counted as activity time once the stream comes back.
                this.lastCheckTime = null;
                return;
            }

            const wasLiveWithBaseline = this.isLive && this.lastCheckTime !== null;
            const justWentLive = !this.isLive;
            if (justWentLive) {
                console.log(`[ModTracker] [${this.channelLogin}] Stream started`);
                this.lastHourlyStatsAt = 0; // get today's row on the board promptly, not up to an hour late
            }
            this.isLive = true;

            if (now - this.lastHourlyStatsAt >= HOURLY_STATS_REFRESH_MS) {
                this.lastHourlyStatsAt = now;
                ChatStats.recordDailyModeratorStats(this.broadcasterId, this.channelLogin, [...currentModerators])
                    .catch(err => console.error('[ModTracker] hourly recordDailyModeratorStats error:', err));
            }

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
