// 11:50 lunch alert for your phone, via ntfy (https://ntfy.sh).
// Runs the same rules as the page (rules.js) and pushes the bring list, only on
// weekdays and only when there's something to bring.
//
//   node --env-file-if-exists=.env notify.js            scheduled run (GitHub Actions)
//   node --env-file-if-exists=.env notify.js --test     send now, whatever the day, time or verdict
//   node notify.js --dry-run                             print the alert, send nothing
//
// Settings come from the environment (or .env locally; never commit it):
//   NTFY_TOPIC   secret topic name your phone subscribes to (required to send)
//   NTFY_SERVER  defaults to https://ntfy.sh

const { MIN, SOURCES, ALERT_FROM, ALERT_UNTIL, getData, decide, summary, sgtNow, worthAlert } = require('./rules.js');

const args = new Set(process.argv.slice(2));
const TEST = args.has('--test'), DRY = args.has('--dry-run');
const TOPIC = process.env.NTFY_TOPIC, SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
// GitHub's cron often runs late, so the job is scheduled early and waits for 11:50 here.
const MAX_WAIT = 25 * MIN;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);

async function fetchMetrics() {
  const metrics = {};
  // One at a time: the job has no earlier readings to fall back on, so avoid the 6-per-10 s limit.
  for (const [key, src] of Object.entries(SOURCES)) {
    try { metrics[key] = src.parse(await getData(src.path)); }
    catch (err) { log(`${key}: ${err.message}`); }
  }
  return metrics;
}

async function waitForAlertTime() {
  const t = sgtNow();
  if (t.weekday === 'Sat' || t.weekday === 'Sun') return 'weekend';
  if (t.mins >= ALERT_UNTIL) return 'after 12:30 SGT, too late to be useful';
  const wait = (ALERT_FROM - t.mins) * MIN - new Date().getSeconds() * 1000;
  if (wait > MAX_WAIT) return 'more than 25 min before 11:50 SGT';
  if (wait > 0) { log(`Waiting ${Math.ceil(wait / MIN)} min for 11:50 SGT`); await sleep(wait); }
  return null;
}

async function send(title, message) {
  const res = await fetch(SERVER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: TOPIC, title, message, priority: 4, tags: ['ct-hub'] }),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}: ${await res.text()}`);
}

async function main() {
  if (!TOPIC && !DRY) throw new Error('NTFY_TOPIC is not set (see README: Phone alerts)');
  if (!TEST && !DRY) {
    const skip = await waitForAlertTime();
    if (skip) { log(`Skipped: ${skip}.`); return; }
  }

  const v = decide(await fetchMetrics());
  const reasons = v.reasons.filter((r) => !r.minor).map((r) => `${r.icon} ${r.text}`);
  const title = `${summary(v)} before lunch`;
  const message = [v.sub, ...reasons].join('\n');
  log(`${v.title}: ${title}\n${message}`);

  if (DRY) return;
  if (!worthAlert(v) && !TEST) { log('Nothing to bring, no alert sent.'); return; }
  await send(TEST ? `[TEST] ${title}` : title, message);
  log('Alert sent.');
}

main().catch((err) => { console.error(err.message); process.exit(1); });
