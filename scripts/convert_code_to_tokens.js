const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const axios = require('axios');

const AUTH_CODE = process.argv[2];

if (!AUTH_CODE) {
    console.error('Usage: node convert_code_to_tokens <code>');
    process.exit(1);
}

if (!process.env.Client_Id || !process.env.client_secret) {
    console.error('Client_Id / client_secret отсутствуют в .env');
    process.exit(1);
}

async function convertCodeToTokens() {
    try {
        const params = new URLSearchParams();
        params.append('client_id', process.env.Client_Id);
        params.append('client_secret', process.env.client_secret);
        params.append('grant_type', 'authorization_code');
        params.append('code', AUTH_CODE);
        params.append('redirect_uri', 'http://localhost:3000');

        console.log('🔄 Отправляем запрос в Twitch...');
        const response = await axios.post('https://id.twitch.tv/oauth2/token', params);

        const { access_token, refresh_token, expires_in } = response.data;

        console.log('\n✅ Токены успешно получены!');
        console.log(`⏱️ Время жизни Access Token: ${expires_in} секунд`);
        console.log(`🔑 Access Token: ${access_token}`);
        console.log(`🔄 Refresh Token: ${refresh_token}`);

    } catch (error) {
        console.error('❌ Ошибка конвертации:', error.response?.data || error.message);
    }
}

convertCodeToTokens();
