/**
 * JStar Pro Lite — minimal production streaming server
 * ----------------------------------------------------------------
 *  - Single-file Node.js server (~400 lines)
 *  - No database, no Redis — config from JSON playlist
 *  - CORS/geo-block bypass proxy for manifests & segments
 *  - Built-in m3u8 / mpd URL rewriting (so client never sees upstream)
 *  - DRM clear-key proxy (keys stay server-side)
 *  - EPG mock (per-category deterministic) with optional real XMLTV hook
 *  - Basic rate-limit + in-memory segment cache
 *  - Serves the ATV frontend from ./public
 *  - Works out of the box on Render / Railway / Vercel Edge / Fly.io
 * ----------------------------------------------------------------
 *  Deploy: set env PORT (auto-set by Render/Railway), put index.html
 *          + jstarww.json in /public, `npm install && npm start`.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { request, Agent } from 'undici';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path, { dirname, join } from 'node:path';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// ---------- boot ----------
// Minimal logger: pretty in dev, JSON in prod (no extra deps)
import util from 'node:util';
function buildLogger () {
  const isDev = process.env.NODE_ENV !== 'production';
  const fmt = (level, args) => {
    const ts = new Date().toISOString();
    if (isDev) {
      const c = { fatal:'35', error:'31', warn:'33', info:'36', debug:'90', trace:'90' }[level] || '0';
      console.log(`\x1b[${c}m[${level}]\x1b[0m ${ts}`, ...args);
    } else {
      console.log(JSON.stringify({ level, time: ts, msg: args.map(a => typeof a === 'string'?a:util.inspect(a)).join(' ') }));
    }
  };
  const log = (...a)=>fmt('info', a);
  ['fatal','error','warn','info','debug','trace'].forEach(lv => {
    log[lv] = (...a)=>fmt(lv, a);
  });
  log.child = () => buildLogger();
  return log;
}
const logInstance = buildLogger();
const app = Fastify({
  logger: logInstance,
  disableRequestLogging: true,
  trustProxy: true
});

await app.register(cors, { origin: true, credentials: true });
await app.register(fastifyStatic, {
  root: join(__dirname, 'public'),
  prefix: '/',
  decorateReply: true
});

// ---------- config ----------
const CONFIG = {
  upstreamTimeoutMs:  20_000,
  maxRetries:         2,
  // cache TTLs (seconds)
  manifestCacheSec:   15,
  segmentCacheSec:    25,
  epgCacheSec:        60,
  playlistRefreshSec: 300,   // re-download remote playlist every 5 min
  playlistUrl:
      process.env.PLAYLIST_URL || 'https://jstartv616.onrender.com/jstarww.json',
  // very soft per-IP rate limit: segments/sec
  rateLimit: { windowMs: 1000, max: 40 },
  // upstream UA/cookies (override if you have premium credentials)
  upstreamHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
  }
};

// ---------- state ----------
let playlist      = [];            // channels, loaded+refreshed from playlistUrl
let lastPlaylistFetch = 0;
const rl          = new Map();     // ip -> {hits, resetAt}
const cache       = new Map();     // key -> {buffer, ct, exp}
const inflight    = new Map();     // key -> Promise (coalesce concurrent fetches)
const httpAgent   = new Agent({ connections: 128, keepAliveTimeout: 30_000 });

// ---------- helpers ----------
const now = () => Date.now();
const enc = encodeURIComponent;

function hash (str) {
  return crypto.createHash('sha1').update(str).digest('hex');
}

async function fetchJson (url, opts = {}) {
  const r = await request(url, {
    method: 'GET',
    dispatcher: httpAgent,
    headers: { ...CONFIG.upstreamHeaders, ...(opts.headers || {}) },
    maxRedirections: 5
  });
  if (r.statusCode >= 400) throw new Error(`upstream ${r.statusCode}: ${url.slice(0, 120)}`);
  return r.body.json();
}

async function fetchRaw (url, headers = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), CONFIG.upstreamTimeoutMs);
  try {
    const r = await request(url, {
      method: 'GET',
      dispatcher: httpAgent,
      signal: ctrl.signal,
      headers: { ...CONFIG.upstreamHeaders, ...headers },
      maxRedirections: 5
    });
    if (r.statusCode >= 400) throw new Error(`upstream ${r.statusCode}: ${url.slice(0,120)}`);
    const buf = Buffer.from(await r.body.arrayBuffer());
    return {
      buffer: buf,
      ct: r.headers['content-type'] || 'application/octet-stream'
    };
  } finally {
    clearTimeout(to);
  }
}

function cacheGet (key) {
  const e = cache.get(key);
  if (!e) return null;
  if (e.exp < now()) { cache.delete(key); return null; }
  return e;
}
function cacheSet (key, val, ttlSec) {
  cache.set(key, { ...val, exp: now() + ttlSec * 1000 });
  // bound memory
  if (cache.size > 4000) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }
}

function rewriteManifest (body, ct, base) {
  const isM3U8 = /mpegurl|m3u8/i.test(ct) || /^#EXTM3U/.test(body.slice(0,64));
  const isMPD  = /dash\+xml|mpd/i.test(ct) || /^<\?xml[^>]*\n?<MPD/.test(body.slice(0,128));
  const prefix = `/api/seg?u=`;

  function abs (u) {
    try { return new URL(u, base).href; } catch { return u; }
  }

  if (isM3U8) {
    const lines = body.split('\n');
    const out = [];
    for (const line of lines) {
      const l = line.trim();
      if (!l || l.startsWith('#EXT-X-KEY') === false && l.startsWith('#') && !l.startsWith('#EXT-X-MAP')) {
        // rewrite URI attributes inside #EXT-X-MAP:URI="..."
        if (l.startsWith('#EXT-X-MAP') || l.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
          out.push(l.replace(/URI="([^"]+)"/g, (_, u) => `URI="${prefix}${enc(abs(u))}"`));
        } else {
          out.push(line);
        }
        continue;
      }
      if (l.startsWith('#EXT-X-KEY')) {
        // remove plaintext keys from manifest — our DRM endpoint will provide them
        out.push(line.replace(/URI="[^"]+"/, `URI="/api/drm/clearkey"`));
        continue;
      }
      out.push(prefix + enc(abs(l)));
    }
    return { body: out.join('\n'), ct: 'application/vnd.apple.mpegurl' };
  }

  if (isMPD) {
    // naive but effective: quote all URL references in the XML
    const rewritten = body.replace(/(URL|sourceURL|media|initialization)="([^"]+)"/g, (m, attr, u) =>
      /^https?:\/\//.test(u) || u.startsWith('/')
        ? `${attr}="${prefix}${enc(abs(u))}"`
        : m
    );
    return { body: rewritten, ct: 'application/dash+xml' };
  }

  return { body, ct };
}

// ---------- playlist loader ----------
async function loadPlaylist () {
  if (now() - lastPlaylistFetch < CONFIG.playlistRefreshSec * 1000 && playlist.length) return;
  try {
    const data = await fetchJson(CONFIG.playlistUrl);
    playlist = data.map((c, i) => ({
      id: 'ch_' + (c.tvg_id || i),
      idx: i + 1,
      name: c.name || `Channel ${i+1}`,
      logo: c.logo || '',
      group: c.group || 'Other',
      // prefer proxied_url (kaizoku proxy) if present; it already handles geo blocks
      url: c.proxied_url || c.original_url || '',
      license_key: c.license_key || '',
      clearKeys: c.clearKeys || {},
      headers: c.headers || {}
    }));
    lastPlaylistFetch = now();
    app.log.info(`playlist loaded: ${playlist.length} channels`);
    // mirror as public JSON for frontend fallback (DRM stripped!)
    const safePlaylist = playlist.map(c => ({
      id: c.id, idx: c.idx, name: c.name, logo: c.logo, group: c.group,
      url: `/api/play/${c.idx}`,         // point client at OUR proxy
      tvg_id: String(c.idx)
    }));
    await writeFile(join(__dirname, 'public', 'channels.json'),
      JSON.stringify(safePlaylist, null, 2));
  } catch (e) {
    app.log.error(e, 'playlist load failed (using last good copy if any)');
  }
}

// ---------- per-IP soft rate limit ----------
function rateLimited (ip) {
  const cur = rl.get(ip);
  const t = now();
  if (!cur || t > cur.resetAt) {
    rl.set(ip, { hits: 1, resetAt: t + CONFIG.rateLimit.windowMs });
    return false;
  }
  cur.hits++;
  return cur.hits > CONFIG.rateLimit.max;
}
setInterval(() => { for (const [k,v] of rl) if (now() > v.resetAt) rl.delete(k); }, 5000);

// ---------- routes ----------
// health
app.get('/api/health', async () => ({
  ok: true, channels: playlist.length, cacheSize: cache.size, uptime: process.uptime()|0
}));

// playlist for frontend (safe version with our proxy urls)
app.get('/api/playlist', async (_req, reply) => {
  await loadPlaylist();
  const safe = playlist.map(c => ({
    id: c.id, idx: c.idx, name: c.name, logo: c.logo, group: c.group,
    url: `/api/play/${c.idx}`, tvg_id: String(c.idx),
    drm: Object.keys(c.clearKeys).length > 0 ? 'clearkey' : 'none'
  }));
  return reply
    .header('Cache-Control', `public, max-age=${CONFIG.playlistRefreshSec}`)
    .send({ total: safe.length, channels: safe });
});

// EPG endpoint — returns deterministic mock for a channel.
// Hook up real XMLTV here later if you want — just replace the body.
const EPG_TITLES = {
  news:     ['Prime Time Bulletin','Late Night Brief','Morning Headlines','Market Watch','Breaking Now'],
  movies:   ['Blockbuster Matinee','Late Night Cinema','Romantic Classic','Action Triple','Comedy Night'],
  music:    ['Retro 90s Hits','Club Videomix','Top 40 Countdown','Indie Hour','Morning Beats'],
  sports:   ['Pre-Match Analysis','Live Match','Post-Match Wrap','Highlights','Sports Talk'],
  kids:     ['SpongeBob Special','Tom & Jerry Block','Paw Patrol','Cartoon Movie','Anime Hour'],
  devo:     ['Morning Aarti','Spiritual Talk','Bhakti Geet','Pravachan','Evening Prayers'],
  default:  ['Prime Time Show','Late Night Programming','Special Feature','Hourly Update','Mega Block']
};
app.get('/api/epg', async (req) => {
  await loadPlaylist();
  const idx = Number(req.query.ch) - 1;
  const ch = playlist[idx];
  if (!ch) return { error: 'channel not found' };
  const k = (() => {
    const g = ch.group.toLowerCase();
    if (/news|business/i.test(g)) return 'news';
    if (/movie|cinema|ktv/i.test(g)) return 'movies';
    if (/music|sangeet|surya music/i.test(g)) return 'music';
    if (/sport/i.test(g)) return 'sports';
    if (/kid|cartoon|nick|chutti|pogo/i.test(g)) return 'kids';
    if (/devot|bhakti|dharma/i.test(g)) return 'devo';
    return 'default';
  })();
  const d = new Date();
  const h = d.getHours(), m = d.getMinutes();
  const hh = (n)=>((n%12)||12)+(n>=12?' PM':' AM');
  const hash = [...ch.name].reduce((a,c)=>((a<<5)-a)+c.charCodeAt(0),0)|0;
  const lib = EPG_TITLES[k];
  const cur = lib[Math.abs(hash+h)%lib.length];
  const nxt = lib[Math.abs(hash+h+3)%lib.length];
  return {
    channel: { idx: ch.idx, name: ch.name },
    current: { title: cur, start: hh(h), end: hh((h+1)%24) },
    next:    { title: nxt, start: hh((h+1)%24), end: hh((h+2)%24) },
    progress: Math.min(100, (m/60)*100)
  };
});

// DRM clear-key endpoint (keys never leave the server in the playlist JSON!)
app.post('/api/drm/clearkey', async (req, reply) => {
  await loadPlaylist();
  // CPIX-style or Shaka clearKey request: body {"kids":["..."]} OR kids query param
  let kids = [];
  try { kids = req.body?.kids || (req.query.kids ? String(req.query.kids).split(',') : []); }
  catch { kids = []; }
  // Figure out which channel is being played via Referer / ch query.
  const refCh = Number(req.query.ch) - 1;
  const ch = playlist[refCh];
  if (!ch || Object.keys(ch.clearKeys).length === 0) {
    return reply.code(404).send({ error: 'no keys for this channel' });
  }
  const keys = [];
  for (const [kidHex, keyHex] of Object.entries(ch.clearKeys)) {
    keys.push({
      kty: 'oct',
      kid: Buffer.from(kidHex, 'hex').toString('base64url'),
      k:   Buffer.from(keyHex, 'hex').toString('base64url')
    });
  }
  return reply.type('application/json').send({ keys });
});

// play entry point: returns manifest through our proxy (no upstream URL leaked)
app.get('/api/play/:idx', async (req, reply) => {
  await loadPlaylist();
  const idx = Number(req.params.idx) - 1;
  const ch = playlist[idx];
  if (!ch || !ch.url) return reply.code(404).send({ error: 'channel not found' });
  req.log.info({ ch: ch.name, idx: ch.idx }, 'play');
  // redirect internally to segment proxy with the real URL (the URL stays
  // server-side — client only ever sees /api/play/:idx)
  req.query.u = ch.url;
  return segHandler(req, reply);
});

// generic segment/manifest proxy
async function segHandler (req, reply) {
  const ip = req.ip;
  if (rateLimited(ip)) return reply.code(429).send({ error: 'too many requests' });

  const url = String(req.query.u || '');
  if (!url) return reply.code(400).send({ error: 'missing u' });
  if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: 'bad url' });

  const cacheKey = hash(url);
  // coalesce concurrent requests for the same URL
  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const cached = cacheGet(cacheKey);
  if (cached) {
    return reply
      .header('Content-Type', cached.ct)
      .header('X-Cache', 'HIT')
      .header('Cache-Control', `public, max-age=${
        /mpegurl|dash\+xml|m3u8|mpd/i.test(cached.ct) ? CONFIG.manifestCacheSec : CONFIG.segmentCacheSec
      }`)
      .send(cached.buffer);
  }

  const doFetch = (async () => {
    let lastErr;
    for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        const { buffer, ct } = await fetchRaw(url);
        // manifest? rewrite
        let outBuf = buffer, outCt = ct;
        if (/mpegurl|dash\+xml|m3u8|mpd/i.test(ct)) {
          const { body, ct: ct2 } = rewriteManifest(buffer.toString('utf8'), ct, url);
          outBuf = Buffer.from(body, 'utf8');
          outCt  = ct2;
        }
        const isManifest = /mpegurl|dash\+xml|m3u8|mpd/i.test(outCt);
        cacheSet(cacheKey, { buffer: outBuf, ct: outCt },
          isManifest ? CONFIG.manifestCacheSec : CONFIG.segmentCacheSec);
        return reply
          .header('Content-Type', outCt)
          .header('X-Cache', 'MISS')
          .header('Cache-Control', `public, max-age=${
            isManifest ? CONFIG.manifestCacheSec : CONFIG.segmentCacheSec
          }`)
          .header('Access-Control-Allow-Origin', '*')
          .send(outBuf);
      } catch (e) { lastErr = e; }
    }
    reply.log.error({ err: lastErr, url: url.slice(0,200) }, 'upstream fetch failed');
    return reply.code(502).send({ error: 'upstream fetch failed' });
  })();

  inflight.set(cacheKey, doFetch);
  try { return await doFetch; }
  finally { inflight.delete(cacheKey); }
}
app.get('/api/seg', segHandler);

// catch-all: serve index.html for SPA navigation
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
  return reply.sendFile('index.html');
});

// ---------- start ----------
await mkdir(join(__dirname, 'public'), { recursive: true });
// If public/index.html doesn't exist, leave a placeholder (real launcher goes there)
if (!existsSync(join(__dirname, 'public', 'index.html'))) {
  await writeFile(join(__dirname, 'public', 'index.html'), `
<!doctype html><html><head><meta charset="utf-8"><title>JStar Pro Lite</title>
<style>body{background:#06070b;color:#f9fafb;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0}
code{background:#1a1f30;padding:0.25rem 0.5rem;border-radius:6px}</style></head>
<body><div style="text-align:center">
<h1>JStar Pro Lite</h1><p>Server is running ✨</p>
<p>Drop your <code>index.html</code> into /public to install the launcher.</p>
<p>API: <a href="/api/health" style="color:#a78bfa">/api/health</a> ·
<a href="/api/playlist" style="color:#a78bfa">/api/playlist</a></p>
</div></body></html>`);
}

await loadPlaylist();
// refresh playlist periodically
setInterval(loadPlaylist, CONFIG.playlistRefreshSec * 1000);

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
