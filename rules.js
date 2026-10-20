// Shared bring-list rules: fetching, parsing and the verdict.
// Loaded by the page as a plain <script> (before app.js) and by notify.js in Node,
// so the 11:50 phone alert and the page always agree.

const API_BASE = 'https://api-open.data.gov.sg/v2/real-time/api';
const CT_HUB = { lat: 1.3105, lon: 103.8638, name: 'CT Hub, 2 Kallang Ave' };

const MIN = 60 * 1000;
// A reading older than this is shown as STALE and left out of the verdict.
const STALE_AFTER = {
  rainfall: 30 * MIN,     // published every 5 min
  temperature: 30 * MIN,  // published every minute
  uv: 3 * 60 * MIN,       // hourly
  pm25: 3 * 60 * MIN,     // hourly
  psi: 3 * 60 * MIN,      // hourly
};

// ---------------------------------------------------------------- helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function distanceKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function getData(path, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API_BASE + path, { cache: 'no-store' });
      if (res.status === 429) throw new Error('Rate limited (429)');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.code !== 0 || !body.data) throw new Error(body.errorMsg || 'Bad response');
      return body.data;
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(2500 * (i + 1)); // rate limit window is 10 s
    }
  }
  throw lastErr;
}

// Sort {lat, lon} places by distance from CT Hub.
function byDistance(places) {
  return places
    .map((p) => ({ ...p, km: distanceKm(CT_HUB, p) }))
    .sort((a, b) => a.km - b.km);
}

// ---------------------------------------------------------------- parsers
// Each returns { value, place, km, time, ... } or throws when there is nothing usable.

function parseForecast(data) {
  const item = data.items && data.items[0];
  if (!item || !item.forecasts || !item.forecasts.length) throw new Error('No forecast published');
  const byArea = new Map(item.forecasts.map((f) => [f.area, f.forecast]));
  const areas = byDistance((data.area_metadata || []).map((a) => ({
    name: a.name, lat: a.label_location.latitude, lon: a.label_location.longitude,
  }))).filter((a) => byArea.has(a.name));
  if (!areas.length) throw new Error('No forecast near CT Hub');
  const area = areas[0];
  const vp = item.valid_period || {};
  return {
    value: byArea.get(area.name),
    place: area.name,
    km: area.km,
    time: new Date(item.update_timestamp || item.timestamp),
    validEnd: vp.end ? new Date(vp.end) : null,
    validText: vp.text || '',
  };
}

// Rainfall and air temperature share one shape: stations[] + readings[0].data[].
function parseStations(data) {
  const reading = data.readings && data.readings[0];
  if (!reading || !reading.data || !reading.data.length) throw new Error('No readings published');
  const values = new Map(
    reading.data.filter((d) => typeof d.value === 'number').map((d) => [d.stationId, d.value]),
  );
  const stations = byDistance((data.stations || []).map((s) => ({
    id: s.id, name: s.name, lat: s.location.latitude, lon: s.location.longitude,
  })));
  const nearest = stations[0];
  const station = stations.find((s) => values.has(s.id));
  if (!station) throw new Error('No station reporting');
  return {
    value: values.get(station.id),
    place: station.name,
    km: station.km,
    fallback: nearest && nearest.id !== station.id ? nearest.name : null,
    time: new Date(reading.timestamp),
    unit: data.readingUnit,
  };
}

function parseUV(data) {
  const rec = data.records && data.records[0];
  const hours = rec && rec.index ? [...rec.index].sort((a, b) => b.hour.localeCompare(a.hour)) : [];
  if (!hours.length) throw new Error('No UV reading yet today');
  return { value: hours[0].value, place: 'Singapore (national)', km: null, time: new Date(hours[0].hour) };
}

// PM2.5 and PSI share one shape: regionMetadata[] + items[0].readings[field] per region.
const parseRegional = (field, label) => (data) => {
  const item = data.items && data.items[0];
  const readings = item && item.readings && item.readings[field];
  if (!readings) throw new Error(`No ${label} reading`);
  const regions = byDistance((data.regionMetadata || []).map((r) => ({
    name: r.name, lat: r.labelLocation.latitude, lon: r.labelLocation.longitude,
  }))).filter((r) => typeof readings[r.name] === 'number');
  if (regions.length) {
    const r = regions[0];
    return { value: readings[r.name], place: `${r.name[0].toUpperCase()}${r.name.slice(1)} region`, km: r.km, time: new Date(item.timestamp) };
  }
  if (typeof readings.national === 'number') {
    return { value: readings.national, place: 'National', km: null, time: new Date(item.timestamp) };
  }
  throw new Error(`No ${label} reading`);
};
const parsePM25 = parseRegional('pm25_one_hourly', 'PM2.5');
const parsePSI = parseRegional('psi_twenty_four_hourly', 'PSI');

// ---------------------------------------------------------------- classification

function forecastKind(text) {
  const t = text.toLowerCase();
  if (t.includes('thunder')) return 'storm';
  if (t.includes('heavy') && /(rain|shower)/.test(t)) return 'heavy';
  if (/(rain|shower|drizzle)/.test(t)) return 'rain';
  if (t.includes('haz')) return 'hazy';
  if (/(fair|sunny)/.test(t)) return 'fair';
  return 'cloudy'; // cloudy, partly cloudy, windy, mist, fog
}

// Rain gauge: mm in the last 5 minutes. 1 mm / 5 min ≈ 12 mm/h, which is heavy.
function rainKind(mm) {
  if (mm <= 0) return 'dry';
  if (mm < 1) return 'light';
  return 'heavy';
}

// NEA UV index bands.
function uvBand(v) {
  if (v <= 2) return 'Low';
  if (v <= 5) return 'Moderate';
  if (v <= 7) return 'High';
  if (v <= 10) return 'Very high';
  return 'Extreme';
}

// NEA 1-hour PM2.5 bands (µg/m³).
function pm25Band(v) {
  if (v <= 55) return 'Normal';
  if (v <= 150) return 'Elevated';
  if (v <= 250) return 'High';
  return 'Very high';
}

// NEA 24-hour PSI bands.
function psiBand(v) {
  if (v <= 50) return 'Good';
  if (v <= 100) return 'Moderate';
  if (v <= 200) return 'Unhealthy';
  if (v <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

function tempBand(v) {
  if (v >= 34) return 'Scorching';
  if (v >= 32) return 'Hot';
  if (v >= 27) return 'Warm';
  return 'Pleasant';
}

function isStale(key, m) {
  if (!m) return false;
  if (key === 'forecast') return m.validEnd ? Date.now() > m.validEnd.getTime() + 30 * MIN : false;
  return Date.now() - m.time.getTime() > STALE_AFTER[key];
}

// ---------------------------------------------------------------- verdict

// Levels: go = nothing to bring, umbrella = bring gear, stay = takeaway day.
const RANK = { go: 0, umbrella: 1, stay: 2 };

// Things to grab before the lift, in display order.
const GEAR = {
  mask: { icon: '😷', label: 'Mask' },
  umbrella: { icon: '☂️', label: 'Umbrella' },
  sunscreen: { icon: '🧴', label: 'Sunscreen' },
  water: { icon: '🥤', label: 'Water' },
};

function decide(m) {
  const fresh = (k) => (m[k] && !isStale(k, m[k]) ? m[k] : null);
  const fc = fresh('forecast'), rain = fresh('rainfall'), temp = fresh('temperature'),
    uv = fresh('uv'), pm = fresh('pm25'), psi = fresh('psi');

  let level = 'go';
  const gear = new Set();
  const reasons = []; // { level, icon, text, minor }
  const push = (lvl, icon, text, minor = false) => {
    if (!minor && RANK[lvl] > RANK[level]) level = lvl;
    reasons.push({ level: lvl, icon, text, minor });
  };

  if (fc) {
    const k = forecastKind(fc.value);
    const where = `${fc.place}${fc.validText ? `, ${fc.validText}` : ''}`;
    if (k === 'storm') { gear.add('umbrella'); push('stay', '⛈️', `${fc.value} forecast for ${where}. Lightning risk, so wait it out.`); }
    else if (k === 'heavy') { gear.add('umbrella'); push('stay', '🌧️', `${fc.value} forecast for ${where}.`); }
    else if (k === 'rain') { gear.add('umbrella'); push('umbrella', '🌦️', `${fc.value} forecast for ${where}.`); }
    else push('go', k === 'fair' ? '☀️' : '⛅', `${fc.value} in ${where}.`, true);
  }

  if (rain) {
    const k = rainKind(rain.value);
    if (k === 'heavy') { gear.add('umbrella'); push('stay', '💦', `Pouring at ${rain.place}: ${rain.value} mm in the last 5 min.`); }
    else if (k === 'light') { gear.add('umbrella'); push('umbrella', '💧', `Raining lightly at ${rain.place} (${rain.value} mm in 5 min).`); }
    else push('go', '🌂', `Rain gauge at ${rain.place} is dry.`, true);
  }

  // Haze: PSI (24-h) and PM2.5 (1-h); whichever is worse decides.
  if (psi || pm) {
    const bits = [];
    if (psi) bits.push(`PSI ${psi.value} (${psiBand(psi.value).toLowerCase()})`);
    if (pm) bits.push(`PM2.5 ${pm.value} µg/m³ (${pm25Band(pm.value).toLowerCase()})`);
    const where = (psi || pm).place;
    const severe = (psi && psi.value > 200) || (pm && pm.value > 150);
    const hazy = (psi && psi.value > 100) || (pm && pm.value > 55);
    if (severe) { gear.add('mask'); push('stay', '😷', `Heavy haze: ${bits.join(', ')} in the ${where.toLowerCase()}. Takeaway, and mask up if you go out.`); }
    else if (hazy) { gear.add('mask'); push('umbrella', '😷', `Hazy: ${bits.join(', ')} in the ${where.toLowerCase()}. Wear a mask.`); }
    else push('go', '🍃', `Air is fine: ${bits.join(', ')}.`, true);
  }

  if (uv) {
    if (uv.value >= 8) { gear.add('sunscreen'); gear.add('umbrella'); push('umbrella', '🕶️', `UV is ${uvBand(uv.value).toLowerCase()} (${uv.value}). Sunscreen, and the umbrella doubles as shade.`); }
    else if (uv.value >= 6) { gear.add('sunscreen'); push('umbrella', '🧴', `UV is high (${uv.value}). Sunscreen up.`); }
  }

  if (temp) {
    if (temp.value >= 34) { gear.add('water'); gear.add('umbrella'); push('umbrella', '🥵', `${temp.value}°C at ${temp.place}. Bring water and use the umbrella for shade.`); }
    else if (temp.value >= 32) push('go', '🥤', `${temp.value}°C at ${temp.place}. Hot, so grab water.`, true);
  }

  const items = Object.keys(GEAR).filter((g) => gear.has(g));
  const list = items.map((g) => GEAR[g].label.toLowerCase()).join(', ');

  if (!fc && !rain && !psi && !pm) {
    return { level: 'unknown', title: 'NO SIGNAL', sub: 'Weather and air data are unavailable. Peek out the window.', reasons, items };
  }
  if (!fc && !rain) reasons.push({ level: 'go', icon: '📡', text: 'Rain data is unavailable. Peek outside before you go.', minor: true });

  const titles = {
    go: ['GO NOW!', 'Nothing to bring. Make your escape.'],
    umbrella: ['GEAR UP!', `Grab it before the lift: ${list}.`],
    stay: ['TAKEAWAY DAY', `Get takeaway and eat in the office.${items.length ? ` If you go out: ${list}.` : ''}`],
  };

  // Biggest problems first, minor notes last.
  reasons.sort((a, b) => (a.minor - b.minor) || (RANK[b.level] - RANK[a.level]));
  return { level, title: titles[level][0], sub: titles[level][1], reasons, items };
}

// One line for the tab title and the 11:50 alert, e.g. "😷☂️ Mask, umbrella".
function summary(v) {
  if (v.level === 'unknown') return '📡 No signal';
  const icons = v.items.map((g) => GEAR[g].icon).join('');
  const labels = v.items.map((g) => GEAR[g].label.toLowerCase()).join(', ');
  if (v.level === 'stay') return `🥡 Takeaway day${labels ? ` · ${icons}` : ''}`;
  if (v.level === 'umbrella') return `${icons} ${labels[0].toUpperCase()}${labels.slice(1)}`;
  return '✅ Go now';
}


// ---------------------------------------------------------------- endpoints and lunch window

// What to fetch for a verdict; the page adds labels and display rules on top.
const SOURCES = {
  forecast: { path: '/two-hr-forecast', parse: parseForecast },
  rainfall: { path: '/rainfall', parse: parseStations },
  temperature: { path: '/air-temperature', parse: parseStations },
  uv: { path: '/uv', parse: parseUV },
  pm25: { path: '/pm25', parse: parsePM25 },
  psi: { path: '/psi', parse: parsePSI },
};

const ALERT_FROM = 11 * 60 + 50, ALERT_UNTIL = 12 * 60 + 30; // minutes after midnight, SGT

function sgtNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Singapore', weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, mins: +parts.hour * 60 + +parts.minute };
}

// Something to bring (or a takeaway day), so worth an alert.
const worthAlert = (v) => v.level === 'umbrella' || v.level === 'stay';

if (typeof module !== 'undefined') {
  module.exports = { API_BASE, CT_HUB, MIN, SOURCES, ALERT_FROM, ALERT_UNTIL, getData, decide, summary, sgtNow, worthAlert };
}
