# Escape from CT Hub… but need umbrella or not?

An arcade-style page that tells you what to grab before the 12pm lunch run from CT Hub (2 Kallang Avenue): 😷 mask, ☂️ umbrella, 🧴 sunscreen, or 🥡 "takeaway day". It uses live NEA data from the [data.gov.sg real-time APIs](https://guide.data.gov.sg/developer-guide/real-time-apis).

**Why it exists:** the problem isn't missing information, it's forgetting. You get caught up in conversation and only remember the umbrella or mask in the lift, when going back means making the group wait. So the page aims to reach you before you leave your desk:

- **Pinned tab:** the tab title and icon show the bring list (e.g. `😷☂️ Mask, umbrella · CT Hub`) and stay current in the background.
- **11:50 alert:** a browser notification on weekdays, only when there's something to bring.
- **Phone alert:** the same 11:50 alert pushed to your phone by a scheduled GitHub Actions job, so it works with the computer off. See [Phone alerts](#phone-alerts).

It's a static page (`index.html`, `style.css`, `rules.js`, `app.js`) with no build step, no dependencies and no backend. `rules.js` holds the fetching, parsing and bring-list rules, and is shared with `notify.js`, the phone-alert script. The APIs send `Access-Control-Allow-Origin: *` and don't require an API key at this volume, so the browser calls them directly.

## Run it

Serve the folder with any static file server, for example:

```bash
python -m http.server 5173
```

Then open http://localhost:5173 and pin the tab. Double-clicking `index.html` shows the data too, but browsers may not allow notifications from a `file://` page, so use the server if you want the 11:50 alert.

To turn on the alert, tap **11:50 ALERT** and allow notifications. It fires once per weekday between 11:50 and 12:30 SGT (in case the computer was asleep at 11:50), only while the tab is open. The on/off setting is remembered in the browser.

To check it on your phone, run the server and open `http://<your-PC's-LAN-IP>:5173` from a phone on the same Wi-Fi. You can also host the folder on GitHub Pages, Netlify or any other static host.

## What it tracks

| Metric | Endpoint | Which reading near CT Hub |
| --- | --- | --- |
| 2-hour forecast | `/two-hr-forecast` | Nearest forecast area (Kallang) |
| Rainfall (mm per 5 min) | `/rainfall` | Nearest rain gauge that is reporting |
| Air temperature | `/air-temperature` | Nearest station that is reporting |
| UV index | `/uv` | National (the only reading the API gives) |
| PM2.5 (1-hour) | `/pm25` | Nearest region, by the region's label coordinates |
| PSI (24-hour) | `/psi` | Nearest region, by the region's label coordinates |

All endpoints share the base `https://api-open.data.gov.sg/v2/real-time/api`. "Nearest" is the haversine distance from CT Hub (1.3105, 103.8638) to the coordinates each API returns, so a new or moved station is picked up automatically.

## Bring-list rules

| Bring | When |
| --- | --- |
| 😷 Mask | PSI > 100 (unhealthy) or PM2.5 > 55 µg/m³ (elevated) |
| ☂️ Umbrella | Showers, rain or thunder forecast, rain at the nearest gauge now, UV ≥ 8 or ≥ 34 °C (for shade) |
| 🧴 Sunscreen | UV ≥ 6 |
| 🥤 Water | ≥ 34 °C |

The headline is the worst case:

- **TAKEAWAY DAY**: thundery or heavy rain forecast, ≥ 1 mm in the last 5 minutes (≈ 12 mm/h) at the nearest gauge, PSI > 200 or PM2.5 > 150.
- **GEAR UP!**: anything is on the bring list.
- **GO NOW!**: nothing to bring.

Notes that don't add anything to the list are shown in grey. Bands follow NEA's 24-hour PSI, 1-hour PM2.5 and UV bands.

## Refresh, staleness and failures

- The page rescans every 5 minutes, again when you return to the tab after that, and whenever you tap **RE-SCAN**. It keeps rescanning in a background tab, so a pinned tab's title stays current. Each scan makes 6 calls, at the unauthenticated limit of 6 per 10 seconds. Failed calls retry with backoff, including after a 429.
- Each card shows its update time. A reading is marked **STALE** and left out of the verdict when it is older than 30 minutes (rainfall, temperature) or 3 hours (UV, PM2.5, PSI), or when the forecast's valid period ended more than 30 minutes ago.
- If an endpoint fails, its card shows **NO SIGNAL** and keeps the last good reading if there was one. If the forecast, rain gauge, PSI and PM2.5 are all missing, the verdict is **NO SIGNAL**.

## Tuning

Constants at the top of `rules.js`: `CT_HUB` (coordinates) and `STALE_AFTER`. The thresholds are in `decide()` and the alert window is `ALERT_FROM` / `ALERT_UNTIL`, both in `rules.js`, so a change applies to the page and the phone alert alike. `REFRESH_MS` is in `app.js`.

If you get rate-limited, the guide recommends getting an API key from data.gov.sg and sending it as `x-api-key`. The guide also says not to expose keys in client-side code, so a key would mean adding a tiny proxy.

## Phone alerts

`notify.js` pushes the 11:50 alert to your phone with [ntfy](https://ntfy.sh) (free, no account). A GitHub Actions workflow (`.github/workflows/lunch-alert.yml`) runs it on weekdays, so it works when your computer is off. It uses the same rules as the page and only sends when there's something to bring, for example:

> **😷☂️ Mask, umbrella before lunch**
> Grab it before the lift: mask, umbrella.
> 😷 Hazy: PSI 103 (unhealthy), PM2.5 53 µg/m³ (normal) in the south region. Wear a mask.

### 1. Subscribe on your phone

1. Install the **ntfy** app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy), [iOS](https://apps.apple.com/app/ntfy/id1625396347)).
2. Tap **+**, enter the topic name from `NTFY_TOPIC` in `.env`, and subscribe on the default server (ntfy.sh).

The topic name is the only secret: anyone who knows it can read and send to it. Keep it long and random, and keep it out of the page code and out of Git (`.env` is git-ignored). To change it, edit `.env`, the GitHub secret and the app subscription.

### 2. Test it from this computer

```bash
node --env-file-if-exists=.env notify.js --test
```

`--test` sends now, whatever the day, time or verdict, with `[TEST]` in the title. `--dry-run` prints the alert without sending. Without either flag the script behaves as on the schedule.

### 3. Schedule it on GitHub Actions

1. Push this folder to a GitHub repository (private is fine).
2. In the repo, go to **Settings → Secrets and variables → Actions → New repository secret**, name it `NTFY_TOPIC` and paste the topic name.
3. Go to **Actions → Lunch alert → Run workflow** (with *test* ticked) and check your phone.

The workflow runs at 11:35 SGT (03:35 UTC), Monday to Friday. GitHub's scheduled runs often start late, so `notify.js` waits until 11:50 SGT before checking the data, and skips the alert if it's already past 12:30. Public holidays aren't skipped.

Things to know:

- **Delays:** GitHub doesn't guarantee start times. A run that starts more than 15 minutes late still alerts, just after 11:50. Runs are rarely dropped at busy times.
- **Inactivity:** in a public repository, GitHub disables scheduled workflows after 60 days with no commits. Re-enable it on the Actions tab if that happens.
- **Cost:** each run takes up to about 16 minutes (mostly waiting), around 350 minutes a month. That's free in a public repo and within the 2,000 free minutes a month for a private one.

**Without GitHub:** Windows Task Scheduler can run `node --env-file-if-exists=.env notify.js` in this folder at 11:50 on weekdays, but only while the computer is on.
