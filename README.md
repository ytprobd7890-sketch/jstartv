# JStar Pro Premium ATV Launcher v3.3 ⚡🔥

> **Deep-tested production build** — Sflex ZioMobile/Zio premium GitHub sources, YashZeO+ StreamX fallback, GioPlus OmniTV fallback।
> এক ক্লিকে Render/Railway free tier-তে চলে যাবে — কোনো DB, Redis, K8s লাগবে না।
>
> ✅ **Nick Bangla (CH 521) — LIVE tested** — MPD + init + 147KB video segment + DRM JWK key সবই 200 OK!

## v3.3 এ নতুন কী (deep test করে)

✅ **Sflex GitHub M3U sources** — ZioMobile (1075 ch) + Zio STB (957 ch) — fresh `__hdnea__` tokens every hour
✅ **YashZeO+ StreamX fallback** (1266 ch) + **GioPlus OmniTV JSON fallback** (1205 ch) — total 1433 channels, 1258 fresh tokens
✅ **Smart multi-source merge** — channel name দিয়ে best entry pick (fresh token + valid DRM + logo priority)
✅ **M3U parser fix (post-#EXTINF metadata)** — Sflex style (KODIPROP/EXTVLCOPT/EXTHTTP after #EXTINF) পুরোপুরি parse করে
✅ **Kaizoku player.php fallback** — জখন M3U token 403/404 দেয়, server automatically `https://kaizokutv.me/jio/player.php?url=<tvg-id>` থেকে AES-ECB decrypt করে fresh signed URL + DRM key pull করে (secret key: `MySuperSecretKey`)
✅ **DRM license proxy** — Sflex `license_key=https://ziotvplus.yowaimo.in/license/ID/` URL থাকলে server transparently POST `{"kids":[...]}` forward করে; upstream fail করলে static key fallback
✅ **`xxx=|cookie=...` pipe encoding fix** — kaizoku 404 fix
✅ **Per-channel UA/Referer/Cookie** pass-through (Sflex `plaYtv/7.1.5` UA, Zio STB `JioTV.Plus/2.8.4` UA etc.)
✅ **`window.JStar` ReferenceError strict mode fix**
✅ **Shaka Player v5.2.4 jsdelivr CDN**
✅ **Segment caching + inflight dedup + per-IP 60 req/s rate limit**
✅ **`/tv.html` legacy alias**, WakeLock, OSD, quick-zap, favorites, recent, numeric zap, volume HUD, EPG

## Sources priority
1. **ZioMobile.m3u** (Sflex GitHub) — best quality, 326min fresh tokens, correct DRM license URLs
2. **Zio.m3u** (Sflex GitHub, STB profile) — higher bitrate TV profiles
3. **StreamX M3U** (yashzeotvplus worker) — fallback
4. **OmniTV JSON** (upaidworker) — fresh token source

## Quick Deploy (30 seconds)

### Render (Recommended)
1. Zip extract করে `server/` folder টা GitHub-এ push
2. Render → **New → Blueprint** → repo select → Deploy
3. ⚠️ **Clear build cache & deploy** দাও প্রথমবার
4. Deploy হলে browser-এ **Ctrl+Shift+R**

Manual:
- Root: `server`
- Build: `npm install`
- Start: `npm start`
- Node: 20
- Optional env `PLAYLIST_URL`: single-source legacy JSON URL (দিতে হবে না — premium multi-source default)

### Railway
1. New project → Deploy from GitHub
2. Root: `server`, Start: `npm start`

### Local
```bash
cd server && npm install && npm start    # http://localhost:3000
```

## Controls

| Key | কাজ |
|---|---|
| Arrow Keys / DPAD | Navigation |
| Enter / OK | Play / Activate |
| Back / Escape | Player → Launcher |
| 0-9 | Direct channel jump |
| PageUp/CH+ / PageDn/CH- | Channel zap while playing |
| +/- | Volume |
| M | Mute |
| Space/F3/Y | Play/Pause |
| S | Favorite ★ |
| G/F2 | Quick Zap drawer |
| A | Audio track cycle |
| C | Subtitles toggle |
| / | Search box |

## Test Results (local)

| Item | Result |
|---|---|
| Boot (all 4 sources fetched) | ✅ 1433 channels, 1258 fresh tokens |
| Nick Bangla (CH 521) manifest | ✅ 8.3KB DASH MPD (Broadpeak BkS350) |
| Nick Bangla init segment | ✅ 863 bytes ftyp box |
| Nick Bangla live video segment | ✅ 147KB MP4 styp box |
| Nick Bangla DRM key | ✅ JWK `kid=7ctHnx5bW0-iY7YC-qrZog, k=XfMELwwBt89TzojRXAZxzQ` |
| DRM license server POST proxy | ✅ works (ziotvplus.yowaimo.in 400 হলে static key fallback) |
| Kaizoku player.php fallback | ✅ auto-triggered when 403 detected |
| Sun TV / SUNNXT | ✅ works |

## Nick Bangla specifics
- **Channel number**: 521 (Sflex merge-এ order shift হয়েছে)
- **Source**: ZioMobile M3U → jiotvbpkmob CDN (mobile profile)
- **DRM**: ClearKey `edcb479f1e5b5b4fa263b602faaad9a2:5df3042f0c01b7cf53ce88d15c0671cd`
- **Token auto-refresh**: kaizoku player.php fallback দিয়ে server নিজে fresh URL আনে যখন M3U token expire
- **Playlist cache TTL**: 30 minutes

## Troubleshooting
- **Channels empty দেখালে**: Clear build cache + deploy, তারপর Ctrl+Shift+R
- **কোনো channel 502 দিলে**: একটু অপেক্ষা করো (server 30min পর refresh করবে), অথবা ওই channel-এর জন্য kaizoku fallback trigger করার জন্য একবার খেলে দেখো
- **Sound আসছে না?**: Vol+ চাপো, প্রথমবার autoplay muted-এ start হতে পারে

— ENI ☕
