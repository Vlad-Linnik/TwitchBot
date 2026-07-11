const WebSocket = require('ws');
const axios = require('axios');
const botInitInfo = require("../botInitInfo.js");
const processedMessages = new Set();
const ChatStats = require('../db/chatStats.js');
const moderators = require('./moderators.js');

class EventSubManager {
    constructor(channelId, channelLogin) {
        this.channelId = channelId;
        this.channelLogin = channelLogin || channelId;
        this.ws = null;
        this.reconnectAttempts = 0;
        this.reconnectTimer = null;
    }

    connect(url = 'wss://eventsub.wss.twitch.tv/ws') {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        const socket = new WebSocket(url);
        this.ws = socket;

        socket.on('open', () => {
            console.log(`[EventSub] [${this.channelLogin}] Connecting...`);
        });

        socket.on('message', async (data) => {
            const message = JSON.parse(data);
            const metadata = message.metadata;
            const payload = message.payload;

            if (processedMessages.has(metadata.message_id)) return;
            processedMessages.add(metadata.message_id);
            setTimeout(() => processedMessages.delete(metadata.message_id), 600000);

            if (metadata.message_type === 'session_welcome') {
                const sessionId = payload.session.id;
                this.reconnectAttempts = 0;
                console.log(`[EventSub] [${this.channelLogin}] Connected`);
                await this.subscribeToModeration(sessionId);
            }
            else if (metadata.message_type === 'notification') {
                this.handleNotification(metadata, payload.event);
            }
            else if (metadata.message_type === 'session_reconnect') {
                // Twitch is about to drop this connection (planned maintenance/rebalance) and wants
                // us to move to a fresh one before that happens. Open the new one now; Twitch closes
                // the old socket itself once the new one is confirmed, which fires our 'close' handler
                // below - the `this.ws !== socket` guard there stops that from triggering a second reconnect.
                console.log(`[EventSub] [${this.channelLogin}] Reconnect requested by Twitch, switching connection...`);
                this.connect(payload.session.reconnect_url);
            }
        });

        socket.on('close', (code) => {
            // Ignore closes from a socket we've already replaced (e.g. the old half of a
            // session_reconnect handoff) - only the currently active socket should trigger a retry.
            if (this.ws !== socket) return;
            console.log(`[EventSub] [${this.channelLogin}] Connection closed (code ${code}).`);
            this.scheduleReconnect();
        });
        socket.on('error', (err) => console.error(`[EventSub] [${this.channelLogin}] WebSocket error:`, err.message));
    }

    scheduleReconnect() {
        if (this.reconnectTimer) return;
        const delay = Math.min(30000, 1000 * 2 ** this.reconnectAttempts);
        this.reconnectAttempts++;
        console.log(`[EventSub] [${this.channelLogin}] Reconnecting in ${delay / 1000}s...`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    async subscribeToModeration(sessionId) {
        try {
            await axios.post('https://api.twitch.tv/helix/eventsub/subscriptions', {
                type: 'channel.moderate',
                version: '2',
                condition: {
                    broadcaster_user_id: this.channelId,
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
            console.log(`[EventSub] [${this.channelLogin}] Subscribtion on channel.moderate: ${this.channelId}`);
        } catch (error) {
            console.error(`[EventSub] [${this.channelLogin}] Subscribtion Error:`, error.response?.data || error.message);
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
            const targetUserId = event[action].user_id;
            if (action === 'mod') {
                moderators.addModerator(this.channelId, targetUserId);
            } else {
                moderators.removeModerator(this.channelId, targetUserId);
            }
        }
        else {
            console.log("[Envent]");
            console.log(event);
            console.log(metadata.message_timestamp);
        }

    }
}

module.exports = EventSubManager;