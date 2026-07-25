const axios = require('axios');

// wttr.in weatherCode groups (worldweatheronline codes) mapped to a representative emoji.
const WEATHER_CODE_EMOJI = [
  { codes: ['113'], emoji: '☀️' },
  { codes: ['116'], emoji: '⛅' },
  { codes: ['119', '122'], emoji: '☁️' },
  { codes: ['143', '248', '260'], emoji: '🌫️' },
  { codes: ['200', '386', '389', '392', '395'], emoji: '⛈️' },
  { codes: ['227', '230', '323', '326', '329', '332', '335', '338', '368', '371', '374', '377'], emoji: '❄️' },
  {
    codes: [
      '176', '263', '266', '293', '296', '299', '302', '305', '308',
      '311', '314', '317', '320', '350', '353', '356', '359', '362', '365',
    ],
    emoji: '🌧️',
  },
];

function emojiForCode(code) {
  const match = WEATHER_CODE_EMOJI.find((entry) => entry.codes.includes(code));
  return match ? match.emoji : '🌡️';
}

// wttr.in needs no signup/API key - a plain city-name lookup against its j1 JSON format.
// lang=ru additionally asks it to translate the condition text into current_condition[0].lang_ru.
async function getWeather(city) {
  let data;
  try {
    ({ data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}`, {
      params: { format: 'j1', lang: 'ru' },
    }));
  } catch (err) {
    // An unrecognized city name is a 500 with a "location not found" plaintext body,
    // not a distinct 404 - treat it the same as "no data" instead of a hard failure.
    if (err.response?.status === 500 && /location not found/i.test(err.response.data)) return null;
    throw err;
  }

  const current = data?.current_condition?.[0];
  if (!current) return null;

  const description = current.lang_ru?.[0]?.value || current.weatherDesc?.[0]?.value;
  const tempC = current.temp_C;
  if (!description || tempC === undefined) return null;

  return { description, tempC, emoji: emojiForCode(current.weatherCode) };
}

module.exports = { getWeather };
