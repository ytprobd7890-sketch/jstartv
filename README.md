# JStar Pro Premium ATV Launcher ⚡

> একদম minimal, balanced production server + premium ATV launcher — এক ক্লিকে Render / Railway-তে চলে যাবে।
> কোনো database লাগবে না, কোনো Redis লাগবে না, কোনো K8s মাথাব্যথা নাই।
>
> **v3 Final-এ সব bug fix করা হয়েছে** — channels list empty, double-proxy, DRM config, /tv.html alias, Shaka 5.2.4 CDN upgrade।

## ✅ Final-এ যা fix করা হয়েছে

1. **Channels list empty bug fix** — `DocumentFragment.outerHTML` ক্র্যাশ সরানো হয়েছে (এটাই ছিল সবচেয়ে বড় bug)
2. **`/tv.html` alias** — পুরনো bookmarked URL-ও কাজ করবে
3. **Double-proxy bug fix** — already-proxied URL আবার wrap হবে না
4. **MPD `&amp;` entity decode** — Broadpeak BkS350 MPD-এর segment URL গুলো এখন ঠিকমত parse হবে
5. **DRM license server fix** — Shaka Player এখন `/api/drm/clearkey?ch=N` relative URL ঠিকভাবে hit করে (GET + POST উভয় support)
6. **Playlist envelope handling** — `{channels:[...]}` বা raw array যাই আসুক handle করবে
7. **Shaka Player upgraded** → **v5.2.4** (jsdelivr CDN, latest stable)
8. **`Referer: jiocinema.com` headers** — CDN blocking কমানোর জন্য

## কী কী আছে এই server-এ

✅ **Stream proxy** (CORS + geo-block bypass; manifest rewrite করে client কখনো আসল URL দেখে না)
✅ **DRM key server** (ClearKeys server-side থেকে serve — playlist-এ প্লেইন কী থাকে না)
✅ **EPG endpoint** (per-category deterministic EPG; চাইলে পরে real XMLTV লাগানো যাবে)
✅ **In-memory cache** (manifest + segment cache; একই segment ১০০ জন দেখলে ১বার upstream hit)
✅ **Soft rate-limit** (per-IP 40 req/sec, abuse রোধ)
✅ **Playlist auto-refresh** (প্রতি ৫ মিনিটে remote playlist reload)
✅ **Inflight de-duplication** (same URL একসাথে ৫০ জন request করলে ১বার fetch)
✅ **Premium ATV Launcher frontend** (DPAD navigation, search, favorites, recent, EPG, OSD, quick-zap drawer, volume HUD, numeric zap, WakeLock, Shaka Player, ClearKey DRM — সব এক ফাইলে)
✅ **Free-tier compatible** — 512MB RAM-এ আরামে 100-200 concurrent viewers চলবে
✅ **Health check endpoint** for Render/Railway auto-restart

## Nick Bangla (CH 77) — DRM test
- Channel number: **77** (latest playlist অনুযায়ী)
- DRM: ClearKey (JWK `kid`/`k` base64url এ serve করা হয়)
- MPD: Broadpeak BkS350 packager থেকে আসে — Shaka 5.2.4-এ ঠিকভাবে চলবে

## File structure

```
jstar-lite/
├── README.md         ← এই ফাইল
└── server/
    ├── server.js         ← পুরো backend এক ফাইলে (~460 লাইন)
    ├── package.json
    ├── render.yaml       ← Render one-click deploy blueprint
    ├── .gitignore
    └── public/
        └── index.html    ← Premium ATV launcher (Shaka Player সহ)
```

## ⚡ Quick Deploy (30 seconds!)

### Render (Recommended — free tier available)
1. এই zip-টা extract করো → `server/` folder-টা তোমার GitHub repo-তে push করো
2. Render এ গিয়ে **New → Blueprint** → repo select করো
3. Environment variable-এ `PLAYLIST_URL` চাইলে নিজের playlist URL দিতে পারো; না দিলে default public JStar playlist (`jstartv616.onrender.com/jstarww.json`) use করবে
4. Deploy — 1 minute-এ চলবে!

**Important:** Deploy-এর সময় অবশ্যই **"Clear build cache & deploy"** দিও — পুরনো buggy code জমা থাকলে channels empty দেখাবে।
Deploy-এর পর browser-এ **Ctrl+Shift+R** দিয়ে hard refresh করো (JS cache bust করার জন্য)।

অথবা manual Web Service:
- Root directory: `server`
- Build command: `npm install`
- Start command: `npm start`
- Node version: **20**

### Railway
1. Railway-এ নতুন project → **Deploy from GitHub repo**
2. Root directory: `server`
3. Start command: `npm start`
4. Done.

### Local test
```bash
cd server
npm install
npm start
# Server running at http://localhost:3000
# → http://localhost:3000  (launcher)
# → http://localhost:3000/tv.html  (legacy alias)
# → http://localhost:3000/api/health
# → http://localhost:3000/api/playlist
```

## ATV Remote / Keyboard Controls

| Key | কাজ |
|---|---|
| Arrow Keys | Navigation (sidebar ↔ grid, grid move) |
| Enter / OK | Play channel / Activate menu |
| Back / Escape | Player → Launcher / Close drawer |
| 0–9 | Direct channel jump |
| Page Up/Down / CH± | Channel zap while playing |
| +/- or Vol± | Volume up/down |
| M | Mute |
| Space / F3 / Y | Play/Pause |
| S | Toggle favorite (★) |
| G / F2 | Quick Zap drawer |
| B / F4 | Back to launcher (video plays in background) |
| A | Cycle audio tracks |
| C | Toggle subtitles |
| / (slash) | Focus search box |
| R / F1 | Refresh OSD |

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Render/Railway auto-set করে দেবে |
| `PLAYLIST_URL` | `https://jstartv616.onrender.com/jstarww.json` | Channel JSON-এর URL |
| `NODE_ENV` | (unset) | `production` দিলে JSON logging |

## Free tier-এ কতজন দেখতে পারবে?

| Plan | Approx concurrent viewers |
|---|---|
| Render free (512MB RAM) | 80-150 |
| Railway free (512MB) | 80-150 |
| Render starter ($7/mo, 512MB + 0.1 CPU) | 150-250 |
| Render standard ($14/mo, 1CPU 2GB) | 500-1000 |
| Hetzner CX22 (€4/mo, 2vCPU 4GB) | 1500+ |

## Endpoints summary

| Method | Path | কাজ |
|---|---|---|
| GET | `/` | ATV Launcher frontend |
| GET | `/tv.html` | Legacy alias (same as `/`) |
| GET | `/api/health` | Health check (channels count, uptime) |
| GET | `/api/playlist` | Channel list (safe, DRM-stripped, proxy-pointed) |
| GET | `/api/epg?ch=N` | EPG for channel N |
| GET/POST | `/api/drm/clearkey?ch=N` | DRM ClearKey JWK license for channel N |
| GET | `/api/play/:idx` | Play channel (manifest through proxy) |
| GET | `/api/seg?u=URL` | Segment proxy (manifest-এ auto-link করা থাকে) |

## Troubleshooting

- **Channels list empty দেখালে?** → Render-এ **Clear build cache & deploy** দাও, তারপর browser-এ Ctrl+Shift+R দাও।
- **Nick Bangla (77) play হচ্ছে না?** → DevTools console-এ Shaka error code দেখো; 1001/1002 = network block (wait 30s, retry); 6001 = manifest load fail; 4012 = DRM issue (server endpoint hit হচ্ছে কিনা `/api/drm/clearkey?ch=77` check করো)।
- **Autoplay blocked?** → প্রথমবার channel play করলে browser policy-র জন্য muted-এ start হতে পারে; Vol+ চাপলে sound আসবে।

ব্যাস! শুরু করে দাও ☕ — ENI
