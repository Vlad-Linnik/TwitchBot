const axios = require('axios');
const describeError = require('../shared/describeError.js');

// Open-Meteo, not wttr.in.
//
// wttr.in needed no signup either, but on 2026-08-17 it served plainly wrong data worldwide -
// 6°C and overcast for Odesa (really 26.6°C and clear), snow in Moscow and a blizzard in London,
// in August. Its geocoding and its forecast dates were both correct, only the numbers were
// garbage, in every response format (j1, %t, with and without lang=ru), so there was nothing to
// work around on this side. Open-Meteo is likewise key-free but is a real forecast API rather
// than a scraper front-end, and it splits the two jobs wttr.in did in one call:
//   1. geocoding-api.open-meteo.com  - city name -> coordinates
//   2. api.open-meteo.com/v1/forecast - coordinates -> current conditions
// Its codes are WMO (0-99), NOT worldweatheronline's 113-395, so every table below is rekeyed.
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
// Fallback geocoder for the names Open-Meteo's gazetteer misses. Its Russian index has real
// holes - "мурманск" resolves to a nameless hamlet in the Astrakhan region rather than the city -
// and answering with the wrong place's weather is worse than answering nothing. Only ever
// queried when Open-Meteo produced no exact match, which is rare, so this stays well inside
// Nominatim's usage policy; that policy also requires an identifying User-Agent (its default
// block hits axios's own UA).
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const NOMINATIM_USER_AGENT = 'ChatWizardBot/1.0 (Twitch chat bot, !weather command)';

// WMO weather codes, grouped once and shared between the emoji map, the description table's
// sanity check and buildAdvice() below so the three never drift out of sync with each other.
// This is the complete set Open-Meteo emits - it does not use the smoke/haze codes (4-12) of the
// full WMO table, so the old wttr.in-only "смог" advice has no trigger anymore and is gone.
const CODE_GROUPS = {
  clear: [0],
  mainlyClear: [1],
  partlyCloudy: [2],
  cloudy: [3],
  fog: [45, 48],
  drizzle: [51, 53, 55, 56, 57],
  rain: [61, 63, 65, 66, 67, 80, 81, 82],
  snow: [71, 73, 75, 77, 85, 86],
  storm: [95, 96, 99],
};

const WEATHER_CODE_DESCRIPTION_RU = {
  0: 'Ясно',
  1: 'Преимущественно ясно',
  2: 'Переменная облачность',
  3: 'Пасмурно',
  45: 'Туман',
  48: 'Изморозь',
  51: 'Лёгкая морось',
  53: 'Морось',
  55: 'Сильная морось',
  56: 'Лёгкая ледяная морось',
  57: 'Сильная ледяная морось',
  61: 'Небольшой дождь',
  63: 'Дождь',
  65: 'Сильный дождь',
  66: 'Небольшой ледяной дождь',
  67: 'Сильный ледяной дождь',
  71: 'Небольшой снег',
  73: 'Снег',
  75: 'Сильный снег',
  77: 'Снежная крупа',
  80: 'Небольшой ливень',
  81: 'Ливень',
  82: 'Сильный ливень',
  85: 'Небольшой снегопад',
  86: 'Сильный снегопад',
  95: 'Гроза',
  96: 'Гроза с градом',
  99: 'Сильная гроза с градом',
};

const WEATHER_CODE_EMOJI = [
  { codes: CODE_GROUPS.clear, emoji: '☀️' },
  { codes: CODE_GROUPS.mainlyClear, emoji: '🌤️' },
  { codes: CODE_GROUPS.partlyCloudy, emoji: '⛅' },
  { codes: CODE_GROUPS.cloudy, emoji: '☁️' },
  { codes: CODE_GROUPS.fog, emoji: '🌫️' },
  { codes: CODE_GROUPS.drizzle, emoji: '🌦️' },
  { codes: CODE_GROUPS.storm, emoji: '⛈️' },
  { codes: CODE_GROUPS.snow, emoji: '❄️' },
  { codes: CODE_GROUPS.rain, emoji: '🌧️' },
];

// A WMO code means the same condition at any hour - 0 is "clear" whether it's noon or midnight -
// and only the sky-only codes actually look wrong without a day/night distinction: a literal sun
// at 3am. Swapped for the real moon phase rather than a single fixed 🌙, since "clear at night"
// already tells you which phase. Open-Meteo reports day/night directly as current.is_day, which
// is what the old code had to sniff out of wttr.in's icon filename.
const NIGHT_OVERRIDE_CODES = [...CODE_GROUPS.clear, ...CODE_GROUPS.mainlyClear, ...CODE_GROUPS.partlyCloudy];

// Open-Meteo has no moon phase (wttr.in carried one in its astronomy block), so it's computed
// here instead of taken from a second API: elapsed synodic months since a known new moon. Good
// to well under a day, which is all that's needed to choose between eight emoji. The phases look
// mirrored from the southern hemisphere; not worth a hemisphere check for one emoji.
const KNOWN_NEW_MOON_MS = Date.UTC(2000, 0, 6, 18, 14);
const SYNODIC_MONTH_MS = 29.530588853 * 24 * 60 * 60 * 1000;
const MOON_PHASE_EMOJI = ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'];

function moonPhaseEmoji(now = Date.now()) {
  const age = (((now - KNOWN_NEW_MOON_MS) % SYNODIC_MONTH_MS) + SYNODIC_MONTH_MS) % SYNODIC_MONTH_MS;
  const fraction = age / SYNODIC_MONTH_MS;
  // Each of the eight phases owns 1/8 of the cycle centred on its exact moment, so the half-width
  // offset is what puts "new moon" on both sides of fraction 0 rather than only after it.
  return MOON_PHASE_EMOJI[Math.floor(fraction * 8 + 0.5) % 8];
}

function pick(options) {
  return options[Math.floor(Math.random() * options.length)];
}

// Thresholds are the WHO UV scale / general meteorological convention, not tuned to any city.
// Each triggered scenario picks randomly from 2+ phrasings so repeat calls for the same
// weather don't read as a canned, identical reply every time.
function buildAdvice({ tempC, feelsLikeC, humidity, uvIndex, windspeedKmph, pressure, visibilityKm, weatherCode, isNight }) {
  const temp = Number(tempC);
  const feels = Number(feelsLikeC);
  const hum = Number(humidity);
  const uv = Number(uvIndex);
  const wind = Number(windspeedKmph);
  const pres = Number(pressure);
  const vis = Number(visibilityKm);
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
      `💨 сильный ветер (${Math.round(wind)} км/ч)`,
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
  } else if (CODE_GROUPS.rain.includes(weatherCode) || CODE_GROUPS.drizzle.includes(weatherCode)) {
    advice.push(pick([
      '☔ дождь — возьмите зонт',
      '☔ на улице мокро, не забудьте зонт',
      '🌧️ льёт — без зонта промокнете в два счёта',
    ]));
  } else if (CODE_GROUPS.fog.includes(weatherCode) || (Number.isFinite(vis) && vis <= 2)) {
    advice.push(pick([
      '🌫️ туман — видимость плохая, за рулём будьте внимательнее',
      '🌫️ видимость низкая, включайте фары даже днём',
      '🌁 туман густой — на дороге держите дистанцию побольше',
    ]));
  }

  const isClearOrPartly = CODE_GROUPS.clear.includes(weatherCode)
    || CODE_GROUPS.mainlyClear.includes(weatherCode)
    || CODE_GROUPS.partlyCloudy.includes(weatherCode);
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

function emojiForCode(code, isNight) {
  if (isNight && NIGHT_OVERRIDE_CODES.includes(code)) return moonPhaseEmoji();
  const match = WEATHER_CODE_EMOJI.find((entry) => entry.codes.includes(code));
  return match ? match.emoji : '🌡️';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Both endpoints occasionally reset the connection or stall past the 15s global axios timeout
// (../botInitInfo.js) under no fault of the bot's own - one retry after a short delay is enough
// to ride out that flakiness without piling up a long chain of attempts on a chat command a user
// is waiting on. Retried only when no response ever arrived (err.response is unset): a real HTTP
// response means the service is up and answering, so retrying it would just burn time
// reproducing the same result.
async function getWithRetry(url, config, label, attempt = 1) {
  try {
    return await axios.get(url, config);
  } catch (err) {
    if (!err.response && attempt === 1) {
      console.error(`[Weather] Transient failure calling ${label}, retrying once:`, describeError(err));
      await delay(1500);
      return getWithRetry(url, config, label, attempt + 1);
    }
    throw err;
  }
}

// ё/е and case are the two ways the same city gets typed; the command lowercases the message
// before it ever gets here, so the comparison has to be case-insensitive on the API's side too.
function normalizeName(name) {
  return String(name || '').trim().toLowerCase().replace(/ё/g, 'е');
}

// Coordinates don't move, so a geocoding result is cached for a day - it spares Nominatim in
// particular from being asked the same rare name on every call, and spares Open-Meteo the
// lookup half of a repeated `!weather Одесса`.
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const GEOCODE_CACHE_MAX = 500;
const geocodeCache = new Map();

function cacheGet(cache, key, ttlMs) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cacheSet(cache, key, value, max) {
  if (cache.size >= max) cache.delete(cache.keys().next().value);
  cache.set(key, { value, at: Date.now() });
}

async function searchOpenMeteo(city, language) {
  const { data } = await getWithRetry(
    GEOCODE_URL,
    { params: { name: city, count: 10, language, format: 'json' } },
    'Open-Meteo geocoding',
  );
  return data?.results || [];
}

// An exact name match wins over the API's own relevance order, and among several exact matches
// the most populous one does - "одесса" must be the Ukrainian city of 1M, not one of the four
// American villages of the same name that also come back.
function bestExactMatch(results, city) {
  const wanted = normalizeName(city);
  const exact = results.filter((r) => normalizeName(r.name) === wanted);
  if (!exact.length) return null;
  return exact.reduce((best, r) => ((r.population || 0) > (best.population || 0) ? r : best));
}

function labelFor(name, country) {
  return country ? `${name}, ${country}` : name;
}

async function geocodeViaNominatim(city) {
  const { data } = await getWithRetry(
    NOMINATIM_URL,
    {
      params: { q: city, format: 'jsonv2', limit: 1, 'accept-language': 'ru' },
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
    },
    'Nominatim geocoding',
  );
  const hit = data?.[0];
  if (!hit) return null;
  // display_name runs place -> district -> region -> ... -> country; the two useful ends are the
  // first and last parts, and everything between them is noise in a chat line.
  const parts = String(hit.display_name || '').split(',').map((p) => p.trim()).filter(Boolean);
  const name = hit.name || parts[0] || city;
  const country = parts.length > 1 ? parts[parts.length - 1] : '';
  return { latitude: Number(hit.lat), longitude: Number(hit.lon), label: labelFor(name, country) };
}

// Resolution order, and each step exists for its own reason:
//   1. Open-Meteo, exact match across BOTH of its name indexes at once. They are separate
//      indexes, so a Latin-typed name finds nothing under `language=ru` and vice versa - but
//      they can't be tried one after the other either: `language=ru` answers "london" with the
//      British city translated to "Лондон" (not an exact match) alongside an untranslated
//      "London" in Kentucky (an exact match), so stopping at the first index that yields any
//      exact hit sent every `!weather london` to a US village of 10k. Merging both first lets
//      the population tiebreak see the 9M London it should have picked.
//   2. Nominatim - covers the holes in Open-Meteo's Russian gazetteer (see NOMINATIM_URL).
//   3. Open-Meteo's own best fuzzy guess, if it returned anything at all - a typo should still
//      get an answer; the resolved place is named in the reply, so a wrong guess is visible
//      rather than silently passed off as the city that was asked for.
// Both index queries always run, rather than short-circuiting on the first: the result is cached
// for a day, so the second request is paid once per city rather than once per command.
async function geocodeCity(city) {
  const key = normalizeName(city);
  const cached = cacheGet(geocodeCache, key, GEOCODE_CACHE_TTL_MS);
  if (cached !== undefined) return cached;

  const merged = [];
  for (const language of ['ru', 'en']) {
    merged.push(...await searchOpenMeteo(city, language));
  }
  const fuzzy = merged[0] || null;
  const exact = bestExactMatch(merged, city);
  if (exact) {
    const hit = { latitude: exact.latitude, longitude: exact.longitude, label: labelFor(exact.name, exact.country) };
    cacheSet(geocodeCache, key, hit, GEOCODE_CACHE_MAX);
    return hit;
  }

  try {
    const viaOsm = await geocodeViaNominatim(city);
    if (viaOsm) {
      cacheSet(geocodeCache, key, viaOsm, GEOCODE_CACHE_MAX);
      return viaOsm;
    }
  } catch (err) {
    // The fallback geocoder failing must not lose an answer Open-Meteo already has.
    console.error(`[Weather] Nominatim fallback failed for "${city}":`, describeError(err));
  }

  const hit = fuzzy
    ? { latitude: fuzzy.latitude, longitude: fuzzy.longitude, label: labelFor(fuzzy.name, fuzzy.country) }
    : null;
  cacheSet(geocodeCache, key, hit, GEOCODE_CACHE_MAX);
  return hit;
}

// Open-Meteo refreshes its own current-conditions data every 15 minutes, so a shorter cache than
// that costs nothing in accuracy and keeps a busy multi-channel day inside the free tier's
// request budget. Keyed on rounded coordinates, since two spellings of one city resolve to
// coordinates that differ in the third decimal.
const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
const WEATHER_CACHE_MAX = 200;
const weatherCache = new Map();

async function fetchCurrent(latitude, longitude) {
  const key = `${latitude.toFixed(2)},${longitude.toFixed(2)}`;
  const cached = cacheGet(weatherCache, key, WEATHER_CACHE_TTL_MS);
  if (cached !== undefined) return cached;

  const { data } = await getWithRetry(
    FORECAST_URL,
    {
      params: {
        latitude,
        longitude,
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,pressure_msl,wind_speed_10m,visibility,uv_index',
        timezone: 'auto',
      },
    },
    'Open-Meteo forecast',
  );
  const current = data?.current || null;
  cacheSet(weatherCache, key, current, WEATHER_CACHE_MAX);
  return current;
}

async function getWeather(city) {
  const place = await geocodeCity(city);
  if (!place) return null;

  const current = await fetchCurrent(place.latitude, place.longitude);
  if (!current || current.temperature_2m === undefined || current.temperature_2m === null) return null;

  const weatherCode = Number(current.weather_code);
  const description = WEATHER_CODE_DESCRIPTION_RU[weatherCode];
  if (!description) {
    // Open-Meteo emits a fixed set of WMO codes; an unmapped one means the set grew and the
    // table above needs an entry, which is invisible otherwise - the reply would just read
    // "погода" with no condition at all.
    console.error(`[Weather] No RU description for WMO code ${current.weather_code} - add it to WEATHER_CODE_DESCRIPTION_RU`);
  }

  const isNight = current.is_day === 0;
  const isMoonEmoji = isNight && NIGHT_OVERRIDE_CODES.includes(weatherCode);

  const tempC = current.temperature_2m;
  const feelsLikeC = current.apparent_temperature;
  const humidity = current.relative_humidity_2m;
  const uvIndex = current.uv_index;
  const windspeedKmph = current.wind_speed_10m;
  const pressure = current.pressure_msl;
  // Open-Meteo reports visibility in metres; the fog threshold below is in kilometres.
  const visibilityKm = current.visibility === undefined || current.visibility === null
    ? undefined
    : current.visibility / 1000;

  return {
    place: place.label,
    description: description || 'Погода',
    // Open-Meteo answers with one decimal (26.6); the reply reads as a chat line, not a
    // measurement, and the advice thresholds below still use the unrounded values.
    tempC: Math.round(tempC),
    feelsLikeC: feelsLikeC === undefined || feelsLikeC === null ? undefined : Math.round(feelsLikeC),
    humidity: humidity === undefined || humidity === null ? undefined : Math.round(humidity),
    uvIndex,
    windspeedKmph: windspeedKmph === undefined || windspeedKmph === null ? undefined : Math.round(windspeedKmph),
    emoji: emojiForCode(weatherCode, isNight),
    isMoonEmoji,
    advice: buildAdvice({
      tempC, feelsLikeC, humidity, uvIndex, windspeedKmph, pressure, visibilityKm,
      weatherCode, isNight,
    }),
  };
}

module.exports = { getWeather };
