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

// worldweatheronline uses the same numeric code for a condition at any hour - "clear" is 113
// whether it's noon or midnight - so day/night only shows up in the icon filename
// (e.g. "..._night.png"). Only the two sky-only codes actually look wrong without that: a
// literal sun at 3am - swapped for the real moon phase (from the same response's astronomy
// block) rather than a single fixed 🌙, since "clear at night" already tells you which phase.
const NIGHT_OVERRIDE_CODES = ['113', '116'];

const MOON_PHASE_EMOJI = {
  'new moon': '🌑',
  'waxing crescent': '🌒',
  'first quarter': '🌓',
  'waxing gibbous': '🌔',
  'full moon': '🌕',
  'waning gibbous': '🌖',
  'last quarter': '🌗',
  'waning crescent': '🌘',
};

function moonPhaseEmoji(phase) {
  return MOON_PHASE_EMOJI[(phase || '').toLowerCase()] || '🌙';
}

function emojiForCode(code, isNight, moonPhase) {
  if (isNight && NIGHT_OVERRIDE_CODES.includes(code)) return moonPhaseEmoji(moonPhase);
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

  const isNight = /night/i.test(current.weatherIconUrl?.[0]?.value || '');
  const moonPhase = data.weather?.[0]?.astronomy?.[0]?.moon_phase;
  const isMoonEmoji = isNight && NIGHT_OVERRIDE_CODES.includes(current.weatherCode);

  return {
    description,
    tempC,
    emoji: emojiForCode(current.weatherCode, isNight, moonPhase),
    isMoonEmoji,
  };
}

module.exports = { getWeather };
