const WebSocket = require('ws');
const axios = require('axios');
const botInitInfo = require("../botInitInfo.js");
const processedMessages = new Set();
const ChatStats = require('../db/chatStats.js');
const moderators = require('./moderators.js');

class EventSubManager {
    constructor(channelId) {
        this.channelId = channelId;
        this.ws = null;
    }

    connect() {
        this.ws = new WebSocket('wss://eventsub.wss.twitch.tv/ws');

        this.ws.on('open', () => {
            console.log('[EventSub] Connecting...');
        });

        this.ws.on('message', async (data) => {
            const message = JSON.parse(data);
            const metadata = message.metadata;
            const payload = message.payload;

            if (processedMessages.has(metadata.message_id)) return;
            processedMessages.add(metadata.message_id);
            setTimeout(() => processedMessages.delete(metadata.message_id), 600000);

            if (metadata.message_type === 'session_welcome') {
                const sessionId = payload.session.id;
                console.log(`[EventSub] Connected`);
                await this.subscribeToModeration(sessionId);
            } 
            else if (metadata.message_type === 'notification') {
                this.handleNotification(metadata, payload.event);
            } 
            else if (metadata.message_type === 'session_reconnect') {
                console.log('[EventSub] Требуется переподключение...');
            }
        });

        this.ws.on('close', () => console.log('[EventSub] Conncection is cloased.'));
        this.ws.on('error', (err) => console.error('[EventSub] Error WebSocket:', err));
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
            console.log(`[EventSub] Subscribtion on channel.moderate: ${this.channelId}`);
        } catch (error) {
            console.error('[EventSub] Subscribtion Error:', error.response?.data || error.message);
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