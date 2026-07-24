const path = require('path');
const axios = require('axios');
const botInitInfo = require("../botInitInfo.js");
const describeError = require('../shared/describeError.js');
const fs = require('fs');

function updateEnvVariable(key, value) {
    const envPath = path.join(__dirname, '..', '.env');
    
    if (!fs.existsSync(envPath)) {
        fs.writeFileSync(envPath, '');
    }

    const envContent = fs.readFileSync(envPath, 'utf8');
    const lines = envContent.split('\n');
    let targetIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith(`${key}=`)) {
            targetIndex = i;
            break;
        }
    }
    const newLine = `${key}=${value}`;
    if (targetIndex !== -1) {
        lines[targetIndex] = newLine;
    } else {
        lines.push(newLine);
    }
    fs.writeFileSync(envPath, lines.join('\n').trim() + '\n', 'utf8');
    process.env[key] = value;
}


class TokenManager {
    constructor() {
        this.timer = {
            "UserToken": null,
            "AppToken": null
        };

        // The tmi.js client, so a token refreshed mid-run reaches the IRC connection too - see
        // refreshUserToken. start() used to be handed this and drop it on the floor.
        this.client = null;

        this.func_list = {
            "UserToken": this.refreshUserToken.bind(this),
            "AppToken": this.getAppAccessToken.bind(this)
        };
    }

    async start(client) {
        this.client = client || null;
        await this.execFunction("UserToken");
        await this.execFunction("AppToken");
    }

    async refreshUserToken() {
        try {
            const response = await axios.post('https://id.twitch.tv/oauth2/token', null, {
                params: {
                    client_id: botInitInfo.settings['Client_Id'],
                    client_secret: botInitInfo.settings['client_secret'],
                    grant_type: 'refresh_token',
                    refresh_token: botInitInfo.settings['refresh_token']
                }
            });
            
            if (botInitInfo.settings['refresh_token'] !== response.data.refresh_token) {
                updateEnvVariable('refresh_token', response.data.refresh_token);
                botInitInfo.settings['refresh_token'] = response.data.refresh_token;
            }
            
            botInitInfo.settings['password'] = response.data.access_token;
            updateEnvVariable('password', response.data.access_token);

            // tmi.js re-reads opts.identity.password on every connection attempt (_getToken, see
            // node_modules/tmi.js/lib/client.js:1209), so keeping this current means a reconnect
            // after a refresh authenticates with the NEW token. Without it the client kept
            // whatever password was copied in at boot - and once that expired, tmi.js's "Login
            // unsuccessful" path sets its own `reconnect = false` PERMANENTLY (client.js:662-664),
            // so it stops retrying entirely and the process idles until the watchdog kills it.
            if (this.client) this.client.opts.identity.password = response.data.access_token;

            this.timer.UserToken = response.data.expires_in * 1000; // convert to milisec
            console.log(`[TokenManager] User Token updated!`);
        } catch (error) {
            console.error('[TokenManager] Error User Token:', describeError(error));
            this.timer.UserToken = 60000;
        }
    }

    async getAppAccessToken() {
        try {
            const params = new URLSearchParams();
            params.append('client_id', botInitInfo.settings['Client_Id']);
            params.append('client_secret', botInitInfo.settings['client_secret']);
            params.append('grant_type', 'client_credentials');
    
            const response = await axios.post('https://id.twitch.tv/oauth2/token', params);
            
            botInitInfo.settings['appAccessToken'] = response.data.access_token;
            this.timer.AppToken = response.data.expires_in * 1000;
            console.log(`[TokenManager] App Token updeted!`);
        } catch (error) {
            console.error('[TokenManager] Error App token:', describeError(error));
            this.timer.AppToken = 60000;
        }
    }

    async execFunction(funcName) {
        try {
            await this.func_list[funcName]();
        } catch (error) {
            console.error(`[TokenManager] [Error] ${funcName}:`, describeError(error));
        }
        let delay = this.timer[funcName] - 60000;
        const MAX_TIMEOUT = 20 * 24 * 60 * 60 * 1000; // 20 Days in milsec
        delay = Math.min(delay, MAX_TIMEOUT);
        setTimeout(() => {
            this.execFunction(funcName);
        }, delay > 0 ? delay : 60000);
    }
}

module.exports = new TokenManager();