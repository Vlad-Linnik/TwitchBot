const axios = require('axios');
const botInitInfo = require('./botInitInfo');
const ChatStats = require('./msgHandlerDependencies/chatStats.js');


class ModActivityTracker {
    constructor(broadcasterId, checkIntervalMs = 300000) {
        this.broadcasterId = broadcasterId;
        this.intervalMs = checkIntervalMs;
        this.timer = null;
        this.moderatorsList = null;
        this.activityData = {}; //  { mod_id: { user_id: '...', totalMinutes: 0, lastSeen: Date } }
        this.isLive = true;
    }

    async isStreamLive() {
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
            if (response.data && response.data.data && response.data.data.length > 0) {
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('[ModTracker] Error Stream status:', error.response?.data || error.message);
            return false; 
        }
    }

    async getMods() {
        let res = new Set();
        const BD_answer = await ChatStats.getModeratorsList(`${this.broadcasterId}`);
        BD_answer.moderators.forEach(id => {
            res.add(id);
        });
        return res;
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
        let isLive = await this.isStreamLive();
        if(!isLive) {
            if(this.isLive) {
                console.log('[ModTracker] Stream is offline');
                this.isLive = false;
            }
            return;
        }
        this.isLive = true;
        console.log('[ModTracker] Scanning ...');
        const currentChatters = await this.getAllChatters();
        const minutesAdded = this.intervalMs / 60000; 
        currentChatters.forEach(chatter => {
            if (this.moderatorsList.has(chatter.user_id)) {
                if (!this.activityData[chatter.user_id]) {
                    this.activityData[chatter.user_id] = { totalMinutes: 0, lastSeen: null };
                }
                this.activityData[chatter.user_id].totalMinutes += minutesAdded;
                this.activityData[chatter.user_id].lastSeen = new Date();
            }
        });
        console.log(this.activityData);
        this.saveToDatabase();
    }

    saveToDatabase() {
        ChatStats.updateModUpTime(this.broadcasterId, this.activityData);
    }

    async start() {
        this.moderatorsList = await this.getMods();
        await this.checkActivity();
        this.timer = setInterval(() => this.checkActivity(), this.intervalMs);
        console.log(`[ModTracker] ${this.broadcasterId} running... Interval = ${this.intervalMs / 1000} seconds.`);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        if (this.modUpdateTimer) clearInterval(this.modUpdateTimer);
        console.log('[ModTracker] Stopt.');
    }
}

module.exports = ModActivityTracker;