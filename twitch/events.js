// ONE EventSub WebSocket for the WHOLE bot, carrying every channel's `channel.moderate`
// subscription - not one socket per channel.
//
// This used to be a per-channel class (`new EventSubManager(id, login).connect()`), which broke
// as soon as the bot joined a 4th channel: Twitch allows a maximum of 3 WebSocket connections
// with enabled subscriptions per (client ID, user ID), so every channel past the third got
// `429 number of websocket transports limit exceeded` on subscribe and then span forever -
// welcome resets the backoff, the subscribe fails, Twitch closes the subscription-less socket
// after 10s (code 4003), reconnect 1s later, repeat. Those channels recorded no moderation
// actions at all. A single connection holds up to 300 subscriptions, and `channel.moderate`
// costs 0 (the moderator authorized us), so one socket covers every channel we'll ever join.
const WebSocket = require('ws');
const axios = require('axios');
const botInitInfo = require("../botInitInfo.js");
const ChatStats = require('../db/chatStats.js');
const moderators = require('./moderators.js');

const DEFAULT_URL = 'wss://eventsub.wss.twitch.tv/ws';
const MAX_RECONNECT_DELAY_MS = 30000;
// Twitch tells us its own keepalive period in session_welcome; this is only the pre-welcome
// fallback and the multiplier applied to whatever it reports.
const DEFAULT_KEEPALIVE_TIMEOUT_S = 10;
const KEEPALIVE_GRACE_FACTOR = 3;
// Re-attempt any channel whose subscribe failed transiently (network blip, Helix 5xx). Without
// this a single failed call means that channel silently records nothing until the next restart.
const RESUBSCRIBE_SWEEP_MS = 5 * 60 * 1000;

const processedMessages = new Set();

class EventSubClient {
    constructor() {
        this.ws = null;
        this.sessionId = null;
        // channelId (string) -> channel login, every channel the bot has joined this process.
        this.channels = new Map();
        // channelIds believed subscribed on the CURRENT session. Cleared whenever a new session
        // starts from scratch; preserved across a session_reconnect handoff (see below).
        this.subscribed = new Set();
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
        this.keepaliveTimer = null;
        this.keepaliveTimeoutMs = DEFAULT_KEEPALIVE_TIMEOUT_S * 1000 * KEEPALIVE_GRACE_FACTOR;
        this.sweepTimer = null;
    }

    // The only entry point call sites need: register a channel and make sure it's subscribed.
    // Safe to call at any point in the connection lifecycle - before the socket exists, while
    // it's still connecting, or long after it's live.
    addChannel(channelId, channelLogin) {
        const id = String(channelId);
        this.channels.set(id, channelLogin || id);

        if (this.sessionId) {
            this.subscribeChannel(id).catch(err =>
                console.error(`[EventSub] [${this.label(id)}] Subscribe failed:`, err.message));
        }
        this.connect();
        this.startSweep();
    }

    label(channelId) {
        return this.channels.get(String(channelId)) || channelId;
    }

    // Idempotent: a socket that's already open or opening is left alone, so addChannel() can
    // call this unconditionally.
    connect(url = DEFAULT_URL, isHandoff = false) {
        if (!isHandoff && this.ws &&
            (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        const socket = new WebSocket(url);
        this.ws = socket;
        // A handoff's new session inherits the old one's subscriptions, so its welcome must NOT
        // re-subscribe (that's a guaranteed 409). Any other connect starts from nothing.
        socket.isHandoff = isHandoff;

        socket.on('open', () => console.log('[EventSub] Connecting...'));

        socket.on('message', async (data) => {
            if (this.ws !== socket) return;
            this.armKeepalive();

            let message;
            try {
                message = JSON.parse(data);
            } catch (err) {
                console.error('[EventSub] Unparseable message:', err.message);
                return;
            }
            const { metadata, payload } = message;

            if (processedMessages.has(metadata.message_id)) return;
            processedMessages.add(metadata.message_id);
            setTimeout(() => processedMessages.delete(metadata.message_id), 600000).unref?.();

            if (metadata.message_type === 'session_welcome') {
                this.sessionId = payload.session.id;
                this.reconnectAttempts = 0;
                const keepaliveS = payload.session.keepalive_timeout_seconds || DEFAULT_KEEPALIVE_TIMEOUT_S;
                this.keepaliveTimeoutMs = keepaliveS * 1000 * KEEPALIVE_GRACE_FACTOR;
                this.armKeepalive();

                if (socket.isHandoff) {
                    // Twitch migrates the old session's subscriptions onto this one, so
                    // re-subscribing here would only earn a 409 per channel.
                    console.log(`[EventSub] Reconnected (${this.subscribed.size} subscriptions carried over)`);
                } else {
                    console.log('[EventSub] Connected');
                    this.subscribed.clear();
                    await this.subscribeAll();
                }
            }
            else if (metadata.message_type === 'notification') {
                this.handleNotification(metadata, payload.event);
            }
            else if (metadata.message_type === 'session_reconnect') {
                // Twitch is about to drop this connection (planned maintenance/rebalance) and wants
                // us to move to a fresh one before that happens. Open the new one now; Twitch closes
                // the old socket itself once the new one is confirmed, which fires our 'close' handler
                // below - the `this.ws !== socket` guard there stops that from triggering a second reconnect.
                console.log('[EventSub] Reconnect requested by Twitch, switching connection...');
                this.connect(payload.session.reconnect_url, true);
            }
            else if (metadata.message_type === 'revocation') {
                // Dropping it from `subscribed` lets the sweep below re-create it (e.g. the bot was
                // re-modded after being unmodded, which revokes channel.moderate).
                const revokedId = String(payload.subscription?.condition?.broadcaster_user_id || '');
                this.subscribed.delete(revokedId);
                console.warn(`[EventSub] [${this.label(revokedId)}] Subscription revoked: ${payload.subscription?.status}`);
            }
        });

        socket.on('close', (code) => {
            // Ignore closes from a socket we've already replaced (e.g. the old half of a
            // session_reconnect handoff) - only the currently active socket should trigger a retry.
            if (this.ws !== socket) return;
            this.clearKeepalive();
            // Drop the reference before scheduling: connect()'s "already connected" guard reads
            // readyState, and leaving a dead socket in this.ws makes the retry depend on ws having
            // flipped that first.
            this.ws = null;
            this.sessionId = null;
            console.log(`[EventSub] Connection closed (code ${code}).`);
            this.scheduleReconnect();
        });
        socket.on('error', (err) => console.error('[EventSub] WebSocket error:', err.message));
    }

    // A silently dead socket now costs every channel its moderation events at once, not just one,
    // so don't wait for TCP to notice: Twitch guarantees a keepalive every
    // keepalive_timeout_seconds, and silence past a few of those means the connection is gone.
    armKeepalive() {
        this.clearKeepalive();
        this.keepaliveTimer = setTimeout(() => {
            console.warn(`[EventSub] No keepalive for ${this.keepaliveTimeoutMs / 1000}s, reconnecting.`);
            const dead = this.ws;
            this.ws = null;
            this.sessionId = null;
            try { dead?.terminate(); } catch { /* already gone */ }
            this.scheduleReconnect();
        }, this.keepaliveTimeoutMs);
        this.keepaliveTimer.unref?.();
    }

    clearKeepalive() {
        if (this.keepaliveTimer) {
            clearTimeout(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** this.reconnectAttempts);
        this.reconnectAttempts++;
        console.log(`[EventSub] Reconnecting in ${delay / 1000}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
        this.reconnectTimer.unref?.();
    }

    // Retries whatever isn't subscribed - covers a transient failure during subscribeAll() and a
    // revoked subscription alike. Cheap: a no-op once every channel is subscribed.
    startSweep() {
        if (this.sweepTimer) return;
        this.sweepTimer = setInterval(() => {
            if (!this.sessionId) return;
            this.subscribeAll().catch(err => console.error('[EventSub] Resubscribe sweep failed:', err.message));
        }, RESUBSCRIBE_SWEEP_MS);
        // Don't hold the event loop open - same convention as CustomCommands.startAutoRefresh.
        this.sweepTimer.unref?.();
    }

    async subscribeAll() {
        for (const channelId of this.channels.keys()) {
            if (this.subscribed.has(channelId)) continue;
            try {
                await this.subscribeChannel(channelId);
            } catch (err) {
                console.error(`[EventSub] [${this.label(channelId)}] Subscribe failed:`, err.message);
            }
        }
    }

    async subscribeChannel(channelId, isRetry = false) {
        const sessionId = this.sessionId;
        if (!sessionId) return;

        try {
            await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
                type: 'channel.moderate',
                version: '2',
                condition: {
                    broadcaster_user_id: channelId,
                    moderator_user_id: botInitInfo.settings.bot_id
                },
                transport: {
                    method: 'websocket',
                    session_id: sessionId
                }
            }, {
                headers: {
                    'Authorization': `Bearer ${botInitInfo.settings['password']}`,
                    'Client-Id': botInitInfo.settings['Client_Id'],
                    'Content-Type': 'application/json'
                }
            });
            this.subscribed.add(channelId);
            console.log(`[EventSub] [${this.label(channelId)}] Subscribed to channel.moderate: ${channelId}`);
        } catch (error) {
            const data = error.response?.data;
            const staleId = data?.status === 409 && !isRetry ? parseConflictId(data.message) : null;

            // 409 means a subscription with this exact type+condition already exists - almost
            // always one orphaned on a session that died before Twitch reaped it, so it delivers
            // to nobody. Deleting it and retrying is what actually restores events for this
            // channel; leaving it (the old behaviour) left the new session with no subscription.
            if (staleId) {
                console.warn(`[EventSub] [${this.label(channelId)}] Stale subscription ${staleId}, replacing it.`);
                await this.deleteSubscription(staleId);
                return this.subscribeChannel(channelId, true);
            }
            if (data?.status === 429) {
                // Should be unreachable now that the whole bot shares one socket; if it ever fires
                // again it means something else is opening EventSub connections under this token.
                console.error(`[EventSub] [${this.label(channelId)}] Transport limit hit - more than one EventSub connection is open for this token:`, data);
                return;
            }
            console.error(`[EventSub] [${this.label(channelId)}] Subscribtion Error:`, data || error.message);
        }
    }

    async deleteSubscription(subscriptionId) {
        try {
            await axios.delete('https://api.twitch.tv/helix/eventsub/subscriptions', {
                params: { id: subscriptionId },
                headers: {
                    'Authorization': `Bearer ${botInitInfo.settings['password']}`,
                    'Client-Id': botInitInfo.settings['Client_Id']
                }
            });
        } catch (err) {
            console.error(`[EventSub] Failed to delete subscription ${subscriptionId}:`, err.response?.data || err.message);
        }
    }

    handleNotification(metadata, event) {
        const action = event.action;
        if (event.ban || event.timeout || event.delete || event.warn) {
           // Twitch only gives us the timeout's expiry timestamp, not a duration directly -
           // chatStats derives the duration from this relative to the action timestamp.
           const expiresAt = event.timeout?.expires_at ? new Date(event.timeout.expires_at) : null;
           ChatStats.addModeratorAction(
            event.broadcaster_user_login,
            event.moderator_user_id,
            event[action].user_id,
            event.action,
            new Date(metadata.message_timestamp),
            event[action].reason,
            expiresAt
            ).catch(err => console.error('[EventSub] addModeratorAction error:', err));
        }
        else if (action === 'mod' || action === 'unmod') {
            // Which channel this is comes off the event itself now - one socket serves them all.
            const broadcasterId = event.broadcaster_user_id;
            const targetUserId = event[action].user_id;
            if (action === 'mod') {
                moderators.addModerator(broadcasterId, targetUserId);
            } else {
                moderators.removeModerator(broadcasterId, targetUserId);
            }
        }
        else {
            console.log("[Envent]");
            console.log(event);
            console.log(metadata.message_timestamp);
        }

    }
}

// Twitch reports the conflicting subscription only inside the human-readable message, e.g.
// "subscription already exists; id=69c40c50-9f59-41d1-9af6-72f15f118427".
function parseConflictId(message) {
    const match = /id=([0-9a-f-]{36})/i.exec(message || '');
    return match ? match[1] : null;
}

module.exports = new EventSubClient();
