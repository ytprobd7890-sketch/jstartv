# JStar Pro Lite ⚡

> একদম minimal, balanced production server — এক ক্লিকে Render / Railway-তে চলে যাবে।
> কোনো database লাগবে না, কোনো Redis লাগবে না, কোনো K8s মাথাব্যথা নাই।

## কী কী আছে এই server-এ

✅ **Stream proxy** (CORS + geo-block bypass; manifest rewrite করে client কখনো আসল URL দেখে না)
✅ **DRM key server** (ClearKeys server-side থেকে serve — playlist-এ প্লেইন কী থাকে না)
✅ **EPG endpoint** (per-category deterministic EPG; চাইলে পরে real XMLTV লাগানো যাবে)
✅ **In-memory cache** (manifest + segment cache; একই segment ১০০ জন দেখলে ১বার upstream hit)
✅ **Soft rate-limit** (per-IP 40 req/sec, abuse রোধ)
✅ **Playlist auto-refresh** (প্রতি ৫ মিনিটে remote playlist reload)
✅ **Inflight de-duplication** (same URL একসাথে ৫০ জন request করলে ১বার fetch)
✅ **Frontend static serving** (public/ folder-এ ATV launcher serve করবে)
✅ **Free-tier compatible** — 512MB RAM-এ আরামে 100-200 concurrent viewers চলবে
✅ **Health check endpoint** for Render/Railway auto-restart

## File structure

```
jstar-lite/
└── server/
    ├── server.js         ← পুরো backend এক ফাইলে (~400 লাইন)
    ├── package.json
    ├── render.yaml       ← Render one-click deploy blueprint
    ├── .gitignore
    └── public/
        ├── index.html    ← তোমার ATV launcher ফাইল (আগেরটা কপি করে দিবো)
        └── (channels.json server auto-generates here)
```

## ⚡ Quick Deploy (30 seconds!)

### Render (Recommended — free tier available)
1. GitHub-এ এই repo-টা push করো
2. Render এ গিয়ে **New → Blueprint** → repo select
3. (Optional) Environment variable-এ `PLAYLIST_URL` দিয়ে দাও নিজের playlist JSON-এর URL; না দিলে default public JStar playlist use করবে
4. Deploy — 1 minute-এ চলবে!

অথবা manual:
- New → **Web Service** → repo টা সিলেক্ট
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
npm run dev
# Server running at http://localhost:3000
```

## ATV Launcher frontend install করা
আগের দিনের বানানো premium `index.html` ফাইলটা `server/public/index.html`-তে কপি করে দাও।
**একটা জিনিস পরিবর্তন করতে হবে frontend-এ:**
```js
// আগে ছিল:
const PLAYLIST_URL = 'jstarww.json';
// এখন হবে (server-এর endpoint):
const PLAYLIST_URL = '/api/playlist';
```

তাহলে client automatically:
- `GET /api/playlist` → safe channel list (সব URL `/api/play/:idx` pointed)
- `GET /api/play/42` → manifest proxy through server
- `GET /api/seg?u=...` → segments (manifest rewrite automatically routes these)
- `POST /api/drm/clearkey?ch=42` → DRM keys (server-side)
- `GET /api/epg?ch=42` → EPG

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 3000 | Render/Railway auto-set করে দেবে |
| `PLAYLIST_URL` | jstartv616.onrender.com/jstarww.json | তোমার channel JSON URL |

## Free tier-এ কতজন দেখতে পারবে?

| Plan | Approx concurrent viewers |
|---|---|
| Render free (512MB RAM) | 80-150 |
| Railway free (512MB) | 80-150 |
| Render starter ($7/mo, 512MB + 0.1 CPU) | 150-250 |
| Render standard ($14/mo, 1CPU 2GB) | 500-1000 |
| Hetzner CX22 (€4/mo, 2vCPU 4GB) | 1500+ |

## Scale করার সময় যা যা যোগ করবে

যখন 1000+ concurrent viewers হবে তখন একে একে যোগ করো:
1. **Cloudflare DNS** front-এ → CDN থেকে static + segment cache (free!)
2. **Bun runtime** switch করো → Node-এর চেয়ে 2-3x faster, drop-in replace
3. যখন 5000+ CCU হবে → Redis যোগ করে cache share করো multiple server-এর মাঝে
4. Premimum feature আসলে auth + subscription (Phone OTP + Stripe) দিবে

## Endpoints summary

| Method | Path | কাজ |
|---|---|---|
| GET | `/` | Frontend serve |
| GET | `/api/health` | Health check (Render/Railway monitor) |
| GET | `/api/playlist` | Channel list (safe, DRM-free, proxy-pointed) |
| GET | `/api/epg?ch=N` | EPG for channel N |
| POST | `/api/drm/clearkey?ch=N` | DRM ClearKey license for channel N |
| GET | `/api/play/:idx` | Play channel (manifest through proxy) |
| GET | `/api/seg?u=URL` | Segment proxy (manifest-এ auto-link করা থাকে) |

ব্যাস! শুরু করে দাও ☕
