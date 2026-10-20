// Escape from CT Hub… but need umbrella or not?
// Static page: talks straight to the data.gov.sg v2 real-time APIs (CORS is open,
// no API key needed at this volume: 6 calls per scan vs a limit of 6 per 10 s).
// The fetching, parsing and bring-list rules live in rules.js, shared with notify.js.

const REFRESH_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- helpers

const $ = (sel) => document.querySelector(sel);

function fmtTime(date) {
  return date.toLocaleTimeString('en-SG', {
    timeZone: 'Asia/Singapore', hour: 'numeric', minute: '2-digit',
  });
}

function fmtAgo(date) {
  const mins = Math.round((Date.now() - date.getTime()) / MIN);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m ago`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- rendering

const METRICS = [
  {
    key: 'forecast', label: '2-HR FORECAST', accent: '--cyan', ...SOURCES.forecast,
    show: (m) => ({ value: m.value, text: true, tag: m.validText ? `Valid ${m.validText}` : '' }),
  },
  {
    key: 'rainfall', label: 'RAINFALL', accent: '--cyan', ...SOURCES.rainfall,
    show: (m) => ({ value: m.value, unit: 'mm / 5 min', tag: { dry: 'Dry', light: 'Light rain', heavy: 'Heavy rain' }[rainKind(m.value)], meter: Math.min(m.value / 2, 1) }),
  },
  {
    key: 'temperature', label: 'AIR TEMP', accent: '--orange', ...SOURCES.temperature,
    show: (m) => ({ value: m.value.toFixed(1), unit: '°C', tag: tempBand(m.value), meter: (m.value - 24) / 12 }),
  },
  {
    key: 'uv', label: 'UV INDEX', accent: '--yellow', ...SOURCES.uv,
    show: (m) => ({ value: m.value, unit: '', tag: uvBand(m.value), meter: m.value / 11 }),
  },
  {
    key: 'pm25', label: 'PM2.5', accent: '--pink', ...SOURCES.pm25,
    show: (m) => ({ value: m.value, unit: 'µg/m³', tag: pm25Band(m.value), meter: m.value / 250 }),
  },
  {
    key: 'psi', label: 'PSI (24-HR)', accent: '--green', ...SOURCES.psi,
    show: (m) => ({ value: m.value, unit: '', tag: psiBand(m.value), meter: m.value / 300 }),
  },
];

function meterHTML(frac) {
  const on = Math.max(0, Math.min(10, Math.round(frac * 10)));
  return `<div class="meter" aria-hidden="true">${Array.from({ length: 10 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('')}</div>`;
}

function cardHTML(def, m, err) {
  const accent = `style="--accent: var(${def.accent})"`;
  if (!m) {
    return `<article class="card no-data" ${accent}>
      <div class="card-head"><span class="card-label">${def.label}</span><span class="chip none">NO SIGNAL</span></div>
      <div class="card-value">-- --</div>
      <div class="card-meta">${esc(err || 'Unavailable')}. Will retry on the next scan.</div>
    </article>`;
  }
  const s = def.show(m);
  const stale = isStale(def.key, m);
  const where = m.km != null ? `${esc(m.place)} · ${m.km.toFixed(1)} km away` : esc(m.place);
  const fallback = m.fallback ? `<br>Nearest station (${esc(m.fallback)}) is silent, using next closest.` : '';
  return `<article class="card" ${accent}>
    <div class="card-head"><span class="card-label">${def.label}</span>
      <span class="chip ${stale ? 'stale' : 'ok'}">${stale ? 'STALE' : 'LIVE'}</span></div>
    <div class="card-value ${s.text ? 'text' : ''}">${esc(s.value)}${s.unit ? `<span class="unit">${esc(s.unit)}</span>` : ''}</div>
    ${s.tag ? `<div class="card-tag">${esc(s.tag)}</div>` : ''}
    ${s.meter != null ? meterHTML(s.meter) : ''}
    <div class="card-meta"><b>${where}</b><br>Updated ${fmtTime(m.time)} (${fmtAgo(m.time)})${stale ? '. Too old to trust, ignored for the verdict.' : ''}${fallback}</div>
  </article>`;
}

function setScene(level, m, verdict, items = []) {
  const hero = $('#hero');
  const fc = m.forecast ? forecastKind(m.forecast.value) : null;
  const wet = (m.rainfall && m.rainfall.value > 0) || ['rain', 'heavy', 'storm'].includes(fc);
  const fx = new Set();
  if (level === 'go') { fx.add('speed'); fx.add(fc === 'fair' ? 'sun' : 'clouds'); if (fc !== 'fair') fx.add('sun'); }
  if (level === 'umbrella') { fx.add('clouds'); fx.add(wet ? 'rain' : 'sun'); }
  if (items.includes('umbrella')) fx.add('umbrella');
  if (items.includes('mask')) fx.add('mask');
  if (level === 'stay') { fx.add('clouds'); fx.add('rain'); if (fc === 'storm' || fc === 'heavy') fx.add('bolt'); }
  if (level === 'unknown' || level === 'loading') fx.add('clouds');
  if ((m.pm25 && m.pm25.value > 55) || (m.psi && m.psi.value > 100) || fc === 'hazy') fx.add('haze');

  hero.className = 'hero ' + [...fx].map((f) => `fx-${f}`).join(' ');
  hero.dataset.level = level;
  if (verdict) { void hero.offsetWidth; hero.classList.add('flash'); }
}

function setFavicon(emoji) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
  link.href = `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${emoji}</text></svg>`)}`;
}

let lastVerdict = null;

function render(metrics, errors) {
  const v = decide(metrics);
  lastVerdict = v;
  setScene(v.level, metrics, true, v.items);
  $('#verdict-title').textContent = v.title;
  $('#verdict-sub').textContent = v.sub;
  $('#gear').innerHTML = v.items.map((g) =>
    `<li><span aria-hidden="true">${GEAR[g].icon}</span> ${GEAR[g].label.toUpperCase()}</li>`).join('');
  $('#gear').hidden = !v.items.length;
  $('#reasons').innerHTML = v.reasons.slice(0, 5).map((r) =>
    `<li class="${r.minor ? 'minor' : ''}"><span class="ico" aria-hidden="true">${r.icon}</span><span>${esc(r.text)}</span></li>`,
  ).join('');
  $('#metrics').innerHTML = METRICS.map((d) => cardHTML(d, metrics[d.key], errors[d.key])).join('');
  document.title = `${summary(v)} · CT Hub`;
  const icon = { go: '✅', stay: '🥡', unknown: '📡' }[v.level] || GEAR[v.items[0]].icon;
  setFavicon(icon);
}

// ---------------------------------------------------------------- scene setup

const SPRITE = [
  '....HHHH....',
  '...HHHHHH...',
  '...HSSSSH...',
  '...SESSES...',
  '...SSSSSS...',
  '....SRRS....',
  '..TTTLLTTT..',
  '.STTTLLTTTS.',
  '.STTTCCTTTS.',
  '.S.TTTTTT.S.',
  '...TTTTTT...',
  '...PPPPPP...',
  '...PP..PP...',
  '...PP..PP...',
  '...PP..PP...',
  '..KKK..KKK..',
];
const SPRITE_COLORS = { H: '#2b1d0e', S: '#f1c27d', E: '#14102e', R: '#d9775a', T: '#2de2e6', L: '#ff3d8b', C: '#ffffff', P: '#3949ab', K: '#111111' };

function buildScene() {
  const NS = 'http://www.w3.org/2000/svg';
  const px = 4;
  const sprite = $('#sprite');
  SPRITE.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', (x - 6) * px); r.setAttribute('y', y * px);
    r.setAttribute('width', px); r.setAttribute('height', px);
    r.setAttribute('fill', SPRITE_COLORS[ch]);
    sprite.appendChild(r);
  }));
  [[-12, 16, 24, 8], [-16, 12, 4, 3], [12, 12, 4, 3]].forEach(([x, y, w, h]) => {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', h);
    r.setAttribute('class', 'mask-px');
    sprite.appendChild(r);
  });

  const windows = $('#windows');
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 6; col++) {
      if (row === 6 && col >= 2 && col <= 3) continue; // door
      const r = document.createElementNS(NS, 'rect');
      r.setAttribute('x', 26 + col * 14); r.setAttribute('y', 52 + row * 14);
      r.setAttribute('width', 10); r.setAttribute('height', 8);
      r.setAttribute('class', Math.random() < 0.7 ? 'win' : 'win off');
      windows.appendChild(r);
    }
  }

  const rain = $('#rain');
  for (let i = 0; i < 46; i++) {
    const l = document.createElementNS(NS, 'line');
    const x = Math.random() * 340, y = Math.random() * 120 - 20;
    l.setAttribute('x1', x); l.setAttribute('y1', y);
    l.setAttribute('x2', x - 3); l.setAttribute('y2', y + 10);
    l.style.animationDelay = `${(-Math.random() * 0.7).toFixed(2)}s`;
    l.style.animationDuration = `${(0.55 + Math.random() * 0.35).toFixed(2)}s`;
    rain.appendChild(l);
  }
}

// ---------------------------------------------------------------- refresh loop

let nextAt = 0;
let lastGood = {}; // keep the previous reading if one endpoint fails this round
let scanning = null; // the in-flight scan, so callers can await it

function scan() {
  if (!scanning) scanning = runScan().finally(() => { scanning = null; });
  return scanning;
}

async function runScan() {
  const btn = $('#refresh');
  btn.disabled = true;
  btn.textContent = '… SCANNING';

  const results = await Promise.allSettled(METRICS.map((d) => getData(d.path).then(d.parse)));
  const metrics = {}, errors = {};
  results.forEach((r, i) => {
    const key = METRICS[i].key;
    if (r.status === 'fulfilled') { metrics[key] = r.value; lastGood[key] = r.value; }
    else {
      errors[key] = r.reason && r.reason.message;
      if (lastGood[key]) metrics[key] = lastGood[key]; // staleness check flags it if it's old
    }
  });
  render(metrics, errors);

  nextAt = Date.now() + REFRESH_MS;
  btn.disabled = false;
  btn.textContent = '↻ RE-SCAN';
}

// ---------------------------------------------------------------- 11:50 lunch alert
// Browser notification on weekdays before the 12pm lunch run, only when there's
// something to bring. Needs this tab to stay open (pinned is ideal).

const memory = {};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return memory[k] ?? null; } },
  set(k, v) { memory[k] = v; try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};


const canNotify = () => 'Notification' in window;
const alertsOn = () => canNotify() && Notification.permission === 'granted' && store.get('ctHub.alert') === 'on';

function notify(title, body) {
  try { new Notification(title, { body, tag: 'ct-hub-lunch' }); } catch { /* not allowed here */ }
}

function updateAlertButton() {
  const b = $('#alert-btn');
  if (!canNotify()) { b.textContent = '🔕 ALERTS UNSUPPORTED'; b.disabled = true; return; }
  if (Notification.permission === 'denied') {
    b.textContent = '🔕 ALERTS BLOCKED';
    b.title = 'Notifications are blocked for this page. Allow them in the browser site settings.';
    return;
  }
  b.textContent = alertsOn() ? '🔔 11:50 ALERT: ON' : '🔕 11:50 ALERT: OFF';
  b.setAttribute('aria-pressed', String(alertsOn()));
}

async function toggleAlerts() {
  if (alertsOn()) store.set('ctHub.alert', 'off');
  else if (await Notification.requestPermission() === 'granted') {
    store.set('ctHub.alert', 'on');
    notify('🔔 Lunch alerts on', "I'll ping you at 11:50 on weekdays when there's something to bring. Keep this tab open.");
  }
  updateAlertButton();
}

async function checkLunchAlert() {
  if (!alertsOn()) return;
  const t = sgtNow();
  if (t.weekday === 'Sat' || t.weekday === 'Sun' || t.mins < ALERT_FROM || t.mins >= ALERT_UNTIL) return;
  if (store.get('ctHub.alert.last') === t.day) return;
  store.set('ctHub.alert.last', t.day); // once a day, even if nothing to bring
  await scan(); // fresh data for the decision
  const v = lastVerdict;
  if (v && worthAlert(v)) notify(`${summary(v)} before lunch`, v.sub);
}

function tick() {
  const left = Math.max(0, nextAt - Date.now());
  const mm = Math.floor(left / MIN), ss = Math.floor((left % MIN) / 1000);
  $('#countdown').textContent = scanning ? 'Scanning…' : `Next scan in ${mm}:${String(ss).padStart(2, '0')}`;
  // Keep scanning in the background too, so a pinned tab's title stays current.
  if (!scanning && nextAt && left === 0) scan();
  checkLunchAlert();
}

buildScene();
setScene('loading', {}, false);
$('#refresh').addEventListener('click', () => scan());
$('#alert-btn').addEventListener('click', toggleAlerts);
updateAlertButton();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() >= nextAt) scan();
});
scan();
setInterval(tick, 1000);
