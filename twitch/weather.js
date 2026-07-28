const axios = require('axios');
const describeError = require('../shared/describeError.js');

// wttr.in weatherCode groups (worldweatheronline codes), shared between the emoji map and
// buildAdvice() below so the two never drift out of sync with each other.
const CODE_GROUPS = {
  clear: ['113'],
  partlyCloudy: ['116'],
  cloudy: ['119', '122'],
  fog: ['143', '248', '260'],
  // Not a standard worldweatheronline code (those top out at 395), but wttr.in returns it for
  // smoke/smog conditions - kept separate from fog since "туман" is the wrong description for it.
  haze: ['149'],
  storm: ['200', '386', '389', '392', '395'],
  snow: ['227', '230', '323', '326', '329', '332', '335', '338', '368', '371', '374', '377'],
  rain: [
    '176', '263', '266', '293', '296', '299', '302', '305', '308',
    '311', '314', '317', '320', '350', '353', '356', '359', '362', '365',
  ],
};

const WEATHER_CODE_EMOJI = [
  { codes: CODE_GROUPS.clear, emoji: '☀️' },
  { codes: CODE_GROUPS.partlyCloudy, emoji: '⛅' },
  { codes: CODE_GROUPS.cloudy, emoji: '☁️' },
  { codes: CODE_GROUPS.fog, emoji: '🌫️' },
  { codes: CODE_GROUPS.haze, emoji: '😷' },
  { codes: CODE_GROUPS.storm, emoji: '⛈️' },
  { codes: CODE_GROUPS.snow, emoji: '❄️' },
  { codes: CODE_GROUPS.rain, emoji: '🌧️' },
];

// worldweatheronline uses the same numeric code for a condition at any hour - "clear" is 113
// whether it's noon or midnight - so day/night only shows up in the icon filename
// (e.g. "..._night.png"). Only the two sky-only codes actually look wrong without that: a
// literal sun at 3am - swapped for the real moon phase (from the same response's astronomy
// block) rather than a single fixed 🌙, since "clear at night" already tells you which phase.
const NIGHT_OVERRIDE_CODES = [...CODE_GROUPS.clear, ...CODE_GROUPS.partlyCloudy];

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

function pick(options) {
  return options[Math.floor(Math.random() * options.length)];
}

// Thresholds are the WHO UV scale / general meteorological convention, not tuned to any city.
// Each triggered scenario picks randomly from 2+ phrasings so repeat calls for the same
// weather don't read as a canned, identical reply every time.
function buildAdvice({ tempC, feelsLikeC, humidity, uvIndex, windspeedKmph, pressure, visibility, weatherCode, isNight }) {
  const temp = Number(tempC);
  const feels = Number(feelsLikeC);
  const hum = Number(humidity);
  const uv = Number(uvIndex);
  const wind = Number(windspeedKmph);
  const pres = Number(pressure);
  const vis = Number(visibility);
  const advice = [];

  if (Number.isFinite(uv) && uv >= 8) {
    advice.push(pick([
      '🕶️ экстремальный УФ-индекс — обязательно очки и крем от загара!',
      '🔥 солнце сегодня максимально агрессивное — прячьтесь в тень в полдень',
      '☀️ УФ зашкаливает — на прямом солнце лучше подолгу не задерживаться',
    ]));
  } else if (Number.isFinite(uv) && uv >= 6) {
    advice.push(pick([
      '🕶️ высокий УФ-индекс — не забудьте очки и крем от загара',
      '🕶️ солнце сегодня злое, солнцезащитный крем не помешает',
      '😎 УФ повышенный — панамка и крем будут не лишними',
    ]));
  }

  if (Number.isFinite(feels) && Number.isFinite(temp)) {
    if (feels - temp <= -5 && temp <= 20) {
      advice.push(pick([
        '🥶 ощущается холоднее, чем есть — одевайтесь теплее',
        '💨 ветер выдувает всё тепло, кутайтесь получше',
        '🧣 по ощущениям холоднее термометра — шарф и шапку в довесок',
      ]));
    } else if (feels - temp >= 5) {
      advice.push(pick([
        '🥵 ощущается жарче, чем есть, из-за влажности',
        '🥵 влажность делает жару тяжелее переносимой',
        '😓 по ощущениям жарче термометра — влажность добавляет духоты',
      ]));
    }
  }

  if (Number.isFinite(temp) && temp >= 35) {
    advice.push(pick([
      '🔥 сильная жара — избегайте солнца в полдень и пейте больше воды',
      '🥵 настоящее пекло на улице, поберегите себя',
      '🌡️ температура зашкаливает — почаще прячьтесь в тень',
    ]));
  } else if (Number.isFinite(temp) && temp <= -10) {
    advice.push(pick([
      '🧊 сильный мороз — прикройте открытые участки кожи',
      '🥶 колотун на улице, одевайтесь в несколько слоёв',
      '❄️ трещат морозы — подолгу на улице лучше не находиться',
    ]));
  }

  if (Number.isFinite(wind) && wind >= 40) {
    advice.push(pick([
      `💨 сильный ветер (${windspeedKmph} км/ч)`,
      '💨 держите шапку — ветер разгулялся не на шутку',
      '🌬️ ветер валит с ног — лишний раз на улицу лучше не соваться',
      '🍃 порывы будь здоров — зонт лучше не открывать, вывернет',
      '🌪️ ветрено настолько, что мелкий мусор и ветки может носить по воздуху — осторожнее',
    ]));
  }

  if (Number.isFinite(hum) && hum >= 85 && Number.isFinite(temp) && temp >= 20) {
    advice.push(pick([
      '💧 очень высокая влажность — на улице может быть душно',
      '💧 воздух сегодня как в бане, дышать тяжеловато',
      '💦 влажность зашкаливает — дышится тяжело, ищите тень с ветерком',
    ]));
  } else if (Number.isFinite(hum) && hum >= 85 && Number.isFinite(temp) && temp < 20) {
    advice.push(pick([
      '💧 очень высокая влажность — на улице сыро и промозгло',
      '💧 воздух сырой, холод ощущается сильнее обычного',
      '🌫️ сырость пробирает — одевайтесь теплее, чем кажется нужным',
    ]));
  } else if (Number.isFinite(hum) && hum <= 20) {
    advice.push(pick([
      '🏜️ низкая влажность — не забудьте попить воды',
      '🏜️ воздух сухой, увлажните кожу и губы',
      '🐫 воздух суше пустыни — губы и кожа скажут спасибо за увлажнение',
    ]));
  }

  if (Number.isFinite(pres) && pres < 1000) {
    advice.push(pick([
      '🤕 низкое давление — метеочувствительным может быть тяжеловато',
      '📉 давление понижено, если голова побаливает — не удивляйтесь',
      '😵 давление ниже нормы — метеозависимым лучше поберечься',
    ]));
  } else if (Number.isFinite(pres) && pres > 1025) {
    advice.push(pick([
      '📈 давление повышенное — погода стабильная',
      '☀️ высокое давление — ждём ясную устойчивую погоду',
      '🌤️ давление выше нормы — погода в ближайшее время не подведёт',
    ]));
  }

  if (CODE_GROUPS.storm.includes(weatherCode)) {
    advice.push(pick([
      '⛈️ гроза — лучше переждать дома',
      '⛈️ молнии рядом — отключите технику из розетки на всякий случай',
      '🌩️ гремит не на шутку — на улицу лучше не соваться',
    ]));
  } else if (CODE_GROUPS.snow.includes(weatherCode)) {
    advice.push(pick([
      '❄️ снег — дороги скользкие, будьте осторожны',
      '☃️ самое время для снежков, но одевайтесь теплее',
      '🌨️ снегопад — если за рулём, притормозите заранее',
    ]));
  } else if (CODE_GROUPS.rain.includes(weatherCode)) {
    advice.push(pick([
      '☔ дождь — возьмите зонт',
      '☔ на улице мокро, не забудьте зонт',
      '🌧️ льёт — без зонта промокнете в два счёта',
    ]));
  } else if (CODE_GROUPS.haze.includes(weatherCode)) {
    advice.push(pick([
      '😷 смог — воздух грязный, лучше меньше времени проводить на улице',
      '😷 дымка от смога, людям с астмой/аллергией лучше выйти в маске',
      '🌫️ воздух заметно грязный — форточку лучше закрыть',
    ]));
  } else if (CODE_GROUPS.fog.includes(weatherCode) || (Number.isFinite(vis) && vis <= 2)) {
    advice.push(pick([
      '🌫️ туман — видимость плохая, за рулём будьте внимательнее',
      '🌫️ видимость низкая, включайте фары даже днём',
      '🌁 туман густой — на дороге держите дистанцию побольше',
    ]));
  }

  const isClearOrPartly = CODE_GROUPS.clear.includes(weatherCode) || CODE_GROUPS.partlyCloudy.includes(weatherCode);
  // Pooled into one pick() (rather than a separate push per tip) so two similar "nice day"
  // suggestions don't stack in one reply.
  if (!isNight && isClearOrPartly && Number.isFinite(hum) && hum <= 45 && Number.isFinite(wind) && wind >= 5 && wind <= 25) {
    advice.push(pick([
      '🧺 отличный день, чтобы посушить бельё на улице',
      '👕 солнце и ветерок — идеально для сушки белья на улице',
      '🚶 отличная погода, чтобы прогуляться на улице',
      '🌤️ грех сидеть дома в такую погоду — сходите погуляйте',
      '🏊 отличный повод сходить поплавать',
    ]));
  }

  if (isNight && CODE_GROUPS.clear.includes(weatherCode)) {
    advice.push(pick([
      '🔭 небо чистое — хороший вечер для звёзд',
      '✨ ясное небо ночью, гляньте наверх — звёзды сегодня видны отлично',
      '🌌 небо без единой тучки — отличный повод погулять под звёздами',
    ]));
  }

  return advice;
}

function emojiForCode(code, isNight, moonPhase) {
  if (isNight && NIGHT_OVERRIDE_CODES.includes(code)) return moonPhaseEmoji(moonPhase);
  const match = WEATHER_CODE_EMOJI.find((entry) => entry.codes.includes(code));
  return match ? match.emoji : '🌡️';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// wttr.in needs no signup/API key - a plain city-name lookup against its j1 JSON format.
// lang=ru additionally asks it to translate the condition text into current_condition[0].lang_ru.
//
// wttr.in occasionally resets the connection or stalls past the 15s global axios timeout
// (../botInitInfo.js) under no fault of the bot's own - one retry after a short delay is enough
// to ride out that flakiness without piling up a long chain of attempts on a chat command a user
// is waiting on. Retried only when no response ever arrived (err.response is unset): a real HTTP
// response - e.g. the 500 "location not found" case below - means wttr.in is up and answering, so
// retrying it would just burn time reproducing the same result.
async function fetchWeatherJson(city, attempt = 1) {
  try {
    const { data } = await axios.get(`https://wttr.in/${encodeURIComponent(city)}`, {
      params: { format: 'j1', lang: 'ru' },
    });
    return data;
  } catch (err) {
    // An unrecognized city name is a 500 with a "location not found" plaintext body,
    // not a distinct 404 - treat it the same as "no data" instead of a hard failure.
    if (err.response?.status === 500 && /location not found/i.test(err.response.data)) return null;
    if (!err.response && attempt === 1) {
      console.error(`[Weather] Transient failure fetching "${city}", retrying once:`, describeError(err));
      await delay(1500);
      return fetchWeatherJson(city, attempt + 1);
    }
    throw err;
  }
}

async function getWeather(city) {
  const data = await fetchWeatherJson(city);

  const current = data?.current_condition?.[0];
  if (!current) return null;

  const description = current.lang_ru?.[0]?.value || current.weatherDesc?.[0]?.value;
  const tempC = current.temp_C;
  if (!description || tempC === undefined) return null;

  const isNight = /night/i.test(current.weatherIconUrl?.[0]?.value || '');
  const moonPhase = data.weather?.[0]?.astronomy?.[0]?.moon_phase;
  const isMoonEmoji = isNight && NIGHT_OVERRIDE_CODES.includes(current.weatherCode);

  const feelsLikeC = current.FeelsLikeC;
  const humidity = current.humidity;
  const uvIndex = current.uvIndex;
  const windspeedKmph = current.windspeedKmph;
  const pressure = current.pressure;
  const visibility = current.visibility;

  return {
    description,
    tempC,
    feelsLikeC,
    humidity,
    uvIndex,
    windspeedKmph,
    emoji: emojiForCode(current.weatherCode, isNight, moonPhase),
    isMoonEmoji,
    advice: buildAdvice({
      tempC, feelsLikeC, humidity, uvIndex, windspeedKmph, pressure, visibility,
      weatherCode: current.weatherCode, isNight,
    }),
  };
}

module.exports = { getWeather };
