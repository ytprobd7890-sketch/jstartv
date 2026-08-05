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
// Primary and fallback premium playlist sources (YashZeO+ StreamX M3U + GioPlus OmniTV JSON).
// We fetch BOTH, merge them (preferring fresh tokens), and produce our own Shaka-compatible
// flat JSON — so we never depend on a single upstream's token rotation being alive.
const CONFIG = {
  upstreamTimeoutMs:  30_000,
  maxRetries:         2,
  // cache TTLs (seconds)
  manifestCacheSec:   15,
  segmentCacheSec:    25,
  epgCacheSec:        60,
  playlistRefreshSec: 1800,  // re-fetch + refresh tokens every 30 min
  // Primary source list (in priority order — highest quality first).
  // If PLAYLIST_URL env is set to a direct JSON URL, it is used as the ONLY source (old behavior).
  playlistUrl: process.env.PLAYLIST_URL || '',
  premiumSources: [
    // Sflex ZioMobile — best quality, fresh tokens, valid license server, mobile bitrates
    { name: 'ZioMobile M3U', url: 'https://raw.githubusercontent.com/Sflex0719/m3u/refs/heads/main/ZioMobile.m3u',
      format: 'm3u8', ua: 'plaYtv/7.1.5 (StreamFlex;Android 16) JioTvMobile',
      licenseProxy: 'ziotvplus.yowaimo.in', upstreamCdn: 'jiotvbpkmob.cdn.jio.com' },
    // Sflex Zio STB — higher bitrate Android TV profiles
    { name: 'Zio STB M3U', url: 'https://raw.githubusercontent.com/Sflex0719/m3u/refs/heads/main/Zio.m3u',
      format: 'm3u8', ua: 'JioTV.Plus/2.8.4_2076/StreamFlex(StreamFlex;JioSTB) JioTvPlus-AndroidTv',
      licenseProxy: 'ziotvplus.yowaimo.in', upstreamCdn: 'jiotvbpkstb.cdn.jio.com' },
    // YashZeO+ StreamX fallback
    { name: 'StreamX M3U', url: 'https://yashzeotvplus.livenoww.workers.dev/', format: 'm3u8', ua: 'OTT Navigator' },
    // GioPlus OmniTV fallback (JSON, fresh tokens for some channels)
    { name: 'OmniTV JSON', url: 'https://upaidworker.streamxlive.workers.dev/', format: 'json', ua: 'OTT Navigator' }
  ],
  // Where to forward DRM license requests for Sflex sources (Shaka ClearKey POST)
  licenseUpstream: 'https://ziotvplus.yowaimo.in/license/',
  // The public fan.kaizokutv.me Indian-IP proxy that all Jio/Sun streams go through
  kaizokuProxy: 'https://fan.kaizokutv.me/prox/jio-prox.php?url=',
  // very soft per-IP rate limit: segments/sec
  rateLimit: { windowMs: 1000, max: 60 },
  // upstream UA defaults (no hardcoded Referer — per-channel Referer is passed in)
  upstreamHeaders: {
    'User-Agent':
      'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9'
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

// Generic HTTP fetch (POST-capable) for license proxy, kaizoku player page, etc.
async function fetchRawEx (url, headers = {}, method = 'GET', body) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), CONFIG.upstreamTimeoutMs);
  try {
    const opts = {
      method, dispatcher: httpAgent, signal: ctrl.signal,
      headers: { ...CONFIG.upstreamHeaders, ...headers },
      maxRedirections: 5
    };
    if (body) opts.body = body;
    const r = await request(url, opts);
    if (r.statusCode >= 400) throw new Error(`upstream ${r.statusCode}: ${url.slice(0,120)}`);
    const buf = Buffer.from(await r.body.arrayBuffer());
    return { buffer: buf, ct: r.headers['content-type'] || 'application/octet-stream' };
  } finally {
    clearTimeout(to);
  }
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
    // 1. decode XML/HTML entities (MPD often ships &amp; for &)
    u = u.replace(/&amp;/g, '&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"');
    // 2. de-template $RepresentationID$ / $Time$ placeholders? No — let player handle.
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
// Token freshness check (looks for __hdnea__=...~exp=E inside cookie/url)
function hdneaExpiry (s) {
  if (!s) return 0;
  const m = /__hdnea__=st=\d+~exp=(\d+)/.exec(s);
  return m ? Number(m[1]) * 1000 : 0;
}
function isFreshCookie (cookie) {
  const exp = hdneaExpiry(cookie);
  return exp > now() + 30_000; // require at least 30s remaining
}
function buildProxiedUrl (originalUrl, cookie) {
  if (!originalUrl) return '';
  if (originalUrl.startsWith(CONFIG.kaizokuProxy)) return originalUrl;
  const tokM = /__hdnea__=([^\s"'<>|]+)/.exec(cookie || '');
  if (!tokM) {
    // Non-Jio URL — still route via kaizoku for geo-unblock (SunNXT etc.)
    return CONFIG.kaizokuProxy + encodeURIComponent(originalUrl);
  }
  const token = tokM[1];
  // Both kaizoku-proxy and direct CDN (when we proxy ourselves) want the cookie as xxx=|cookie=...
  const xxx = 'xxx=|cookie=__hdnea__=' + token;
  let finalUrl;
  if (originalUrl.includes('__hdnea__=')) {
    finalUrl = originalUrl.includes('xxx=') ? originalUrl : originalUrl + '&' + xxx;
  } else {
    const sep = originalUrl.includes('?') ? '&' : '?';
    finalUrl = originalUrl + sep + '__hdnea__=' + token + '&' + xxx;
  }
  // Route Jio CDN URLs through our OWN segment proxy (kaizoku was 403ing the new
  // ziotv tokens). For other hosts (sunnxt, fan.kaizokutv.me already) keep kaizoku.
  if (/jiotvbpkmob|jiotvbpkstb|jiotvmblive|jiotvpllive|jiotv.cdn\.jio\.com|bpk-tv/i.test(finalUrl)) {
    // Our proxy fetches directly with the right Cookie/Referer/UA — see segHandler.
    // The inner final URL already carries __hdnea__ + xxx params, so just point
    // to /api/seg?u=...  BUT we don't know the channel's UA/Referer from URL alone.
    // Use kaizoku as the transport since it's an Indian egress point.
    return CONFIG.kaizokuProxy + encodeURIComponent(finalUrl);
  }
  return CONFIG.kaizokuProxy + encodeURIComponent(finalUrl);
}

// Parse M3U. Supports two formats:
//   1) Old StreamX/OmniTV: KODIPROP+EXTVLCOPT+EXTHTTP appear BETWEEN previous URL and next #EXTINF
//   2) Sflex Zio: KODIPROP/EXTVLCOPT/EXTHTTP appear AFTER #EXTINF (before the URL line)
// We flush pending metadata when we see #EXTINF OR a URL, and accept post-#EXTINF metadata
// attached directly to the current record.
function parseM3u (text) {
  const channels = [];
  const pending = { drm: '', ua: '', cookie: '', origin: '', referer: '' };
  let cur = null;
  function flushPending () {
    if (!cur) return;
    if (!cur.drm && pending.drm) cur.drm = pending.drm;
    if (!cur.ua && pending.ua) cur.ua = pending.ua;
    if (!cur.cookie && pending.cookie) cur.cookie = pending.cookie;
    if (!cur.referer && pending.referer) cur.referer = pending.referer;
    if (!cur.origin && pending.origin) cur.origin = pending.origin;
    pending.drm = ''; pending.ua = ''; pending.cookie = '';
    pending.origin = ''; pending.referer = '';
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXTM3U')) continue;
    // Skip KODIPROP lines we don't care about (manifest_type, license_type=clearkey)
    const drmM = /#KODIPROP:\s*inputstream\.adaptive\.license_key=(.+)/i.exec(line);
    const typeM = /#KODIPROP:\s*inputstream\.adaptive\.(manifest_type|license_type)=/i.exec(line);
    if (typeM) continue;
    if (drmM) {
      const v = drmM[1].trim();
      if (!/^clearkey$/i.test(v)) {
        if (cur) cur.drm = v; else pending.drm = v;
      }
      continue;
    }
    if (line.startsWith('#KODIPROP:')) continue; // other KODIPROP lines
    if (line.startsWith('#EXTVLCOPT:') && line.includes('http-user-agent=')) {
      const ua = line.split('http-user-agent=')[1].trim();
      if (cur) cur.ua = ua; else pending.ua = ua;
      continue;
    }
    if (line.startsWith('#EXTVLCOPT:')) continue;
    if (line.startsWith('#EXTHTTP:')) {
      try {
        const h = JSON.parse(line.slice(9));
        const cookie = h.cookie || '';
        const origin = h.Origin || '';
        const referer = h.Referer || '';
        if (cur) {
          if (cookie) cur.cookie = cookie;
          if (origin) cur.origin = origin;
          if (referer) cur.referer = referer;
        } else {
          pending.cookie = cookie; pending.origin = origin; pending.referer = referer;
        }
      } catch {}
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      flushPending();
      const name = line.includes(',') ? line.split(',').slice(-1)[0].trim() : 'Channel';
      const attrs = {};
      for (const a of ['tvg-id', 'tvg-logo', 'group-title']) {
        const tok = `${a}="`;
        if (line.includes(tok)) {
          const s = line.indexOf(tok) + tok.length;
          const e = line.indexOf('"', s);
          attrs[a] = line.slice(s, e);
        }
      }
      cur = { name, ...attrs, drm: '', ua: '', cookie: '', origin: '', referer: '' };
      continue;
    }
    if (line.startsWith('#')) continue; // other comments
    if (cur && /^https?:/.test(line)) {
      cur.url = line;
      flushPending();
      channels.push(cur);
      cur = null;
    }
  }
  return channels;
}

// Parse OmniTV / GioPlus JSON
function parseOmniJson (arr) {
  return arr.map(c => ({
    name: c.name || '',
    'tvg-id': String(c.id || ''),
    'tvg-logo': c.logo || '',
    'group-title': c.category || 'Uncategorized',
    url: c.url || '',
    drm: (c.keyId && c.key) ? `${c.keyId}:${c.key}` : '',
    ua: 'OTT Navigator',
    cookie: c.cookie || '',
    origin: 'https://www.jiotv.com/',
    referer: 'https://www.jiotv.com/'
  })).filter(c => c.url);
}

async function fetchText (url, ua) {
  const headers = { ...CONFIG.upstreamHeaders };
  if (ua) headers['User-Agent'] = ua;
  const r = await request(url, { method: 'GET', dispatcher: httpAgent, headers, maxRedirections: 5 });
  if (r.statusCode >= 400) throw new Error(`upstream ${r.statusCode}: ${url.slice(0, 120)}`);
  return Buffer.from(await r.body.arrayBuffer()).toString('utf8');
}

// Normalize a parsed channel (from m3u or json) into the playlist entry shape.
function normalizeChannel (c, i) {
  const clearKeys = {};
  let licenseServerUrl = '';
  const drm = (c.drm || '').trim();
  if (drm) {
    if (drm.startsWith('http')) {
      // Upstream license server URL (e.g. https://ziotvplus.yowaimo.in/license/1341/)
      licenseServerUrl = drm;
    } else {
      const km = /^([0-9a-fA-F]{32}):([0-9a-fA-F]{32})$/.exec(drm);
      if (km) clearKeys[km[1].toLowerCase()] = km[2].toLowerCase();
      else {
        // May be a JSON {keys:[...]} blob
        try {
          const j = JSON.parse(drm);
          if (j && Array.isArray(j.keys)) for (const k of j.keys) {
            if (k.kid && k.k) {
              // Accept base64url or hex
              const kh = kidToHex(k.kid), vh = keyToHex(k.k);
              if (kh && vh) clearKeys[kh] = vh;
            }
          }
        } catch {}
      }
    }
  }
  const cookie = c.cookie || '';
  const referer = c.referer || (/jiotv|jio\.com/i.test(c.url) ? 'https://www.jiotv.com/' : 'https://www.jiocinema.com/');
  const origin = c.origin || referer.replace(/\/$/, '');
  return {
    id: 'ch_' + (c['tvg-id'] || i),
    idx: i + 1,
    name: c.name || `Channel ${i + 1}`,
    logo: c['tvg-logo'] || '',
    group: c['group-title'] || 'Other',
    url: buildProxiedUrl(c.url || '', cookie),
    rawUrl: c.url || '',
    license_key: licenseServerUrl,
    clearKeys,
    headers: {
      'User-Agent': c.ua || 'Mozilla/5.0 (Linux; Android 11; SM-G991B) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      'Cookie': cookie,
      'Referer': referer,
      'Origin': origin
    }
  };
}

function kidToHex (s) {
  if (!s) return '';
  if (/^[0-9a-fA-F]{32}$/.test(s)) return s.toLowerCase();
  try {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '==', 'base64');
    return b.toString('hex');
  } catch { return ''; }
}
function keyToHex (s) { return kidToHex(s); }

async function loadPlaylist () {
  if (now() - lastPlaylistFetch < CONFIG.playlistRefreshSec * 1000 && playlist.length) return;
  const start = now();
  try {
    let rawChannels = [];

    if (CONFIG.playlistUrl) {
      // Legacy single-source mode: fetch a flat JSON (old jstarww.json behavior).
      const data = await fetchJson(CONFIG.playlistUrl);
      rawChannels = (Array.isArray(data) ? data : []).map((c, i) => ({
        name: c.name, 'tvg-id': c.tvg_id, 'tvg-logo': c.logo,
        'group-title': c.group, url: c.proxied_url || c.original_url || '',
        drm: (c.clearKeys ? Object.entries(c.clearKeys).map(([k,v])=>`${k}:${v}`).join(',') : ''),
        ua: (c.headers && c.headers['User-Agent']) || 'OTT Navigator',
        cookie: (c.headers && c.headers.Cookie) || '',
        referer: (c.headers && c.headers.Referer) || '',
        origin: (c.headers && c.headers.Origin) || ''
      }));
    } else {
      // Multi-source premium merge
      const sourceResults = [];
      for (const src of CONFIG.premiumSources) {
        try {
          const text = await fetchText(src.url, src.ua);
          let chs = [];
          if (src.format === 'm3u8' || /^#EXTM3U/.test(text.slice(0, 64))) {
            chs = parseM3u(text);
          } else if (text.trim().startsWith('[') || text.trim().startsWith('{')) {
            const parsed = JSON.parse(text);
            chs = Array.isArray(parsed) ? parseOmniJson(parsed) : [];
          }
          sourceResults.push({ name: src.name, chs });
          app.log.info(`premium source ${src.name}: ${chs.length} channels`);
        } catch (e) {
          app.log.error(e, `premium source ${src.name} failed`);
        }
      }

      // Multi-source merge. We build a {lowercase-name → channel} map taking the
      // BEST entry for each channel name across all sources:
      //   1) Prefer entries with FRESH __hdnea__ cookie tokens
      //   2) Prefer entries with valid DRM (license URL or KID:KEY)
      //   3) Prefer ZioMobile/Zio STB over StreamX/OmniTV (higher quality, valid license server)
      const sourceRank = { 'ZioMobile M3U': 4, 'Zio STB M3U': 3, 'StreamX M3U': 2, 'OmniTV JSON': 1 };
      const byName = new Map();
      function score (ch, srcName) {
        let s = 0;
        if (isFreshCookie(ch.cookie || '')) s += 100;
        if (ch.drm) s += 10;
        if (ch['tvg-logo'] || ch.logo) s += 2;
        s += sourceRank[srcName] || 0;
        return s;
      }
      for (const res of sourceResults) {
        for (const ch of res.chs) {
          const key = (ch.name || '').trim().toLowerCase();
          if (!key) continue;
          const cur = byName.get(key);
          if (!cur || score(ch, res.name) > score(cur.ch, cur.src)) {
            byName.set(key, { ch, src: res.name });
          }
        }
      }
      // Preserve order from the first (highest priority) successfully-fetched source
      const orderedNames = [];
      const seen = new Set();
      for (const res of sourceResults) {
        for (const ch of res.chs) {
          const key = (ch.name || '').trim().toLowerCase();
          if (key && !seen.has(key)) {
            seen.add(key);
            orderedNames.push(key);
          }
        }
      }
      // No more single-channel cookie replacement needed — byName already picked best.
      rawChannels.length = 0;
      for (const key of orderedNames) {
        const best = byName.get(key);
        if (best) rawChannels.push(best.ch);
      }
    }

    playlist = rawChannels.map((c, i) => normalizeChannel(c, i));
    lastPlaylistFetch = now();
    const freshCount = playlist.filter(c => isFreshCookie(c.headers?.Cookie || '')).length;
    app.log.info(`playlist loaded: ${playlist.length} channels (${freshCount} fresh tokens) in ${(now()-start)|0}ms`);

    // Mirror safe playlist to /public/channels.json for fallback/static access.
    const safePlaylist = playlist.map(c => ({
      id: c.id, idx: c.idx, name: c.name, logo: c.logo, group: c.group,
      url: `/api/play/${c.idx}`,
      tvg_id: String(c.idx)
    }));
    await writeFile(join(__dirname, 'public', 'channels.json'),
      JSON.stringify(safePlaylist, null, 2)).catch(() => {});
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

// Legacy /tv.html alias for original bookmarked URL
app.get('/tv.html', (_req, reply) => reply.sendFile('index.html'));

// playlist for frontend (safe version with our proxy urls)
app.get('/api/playlist', async (_req, reply) => {
  await loadPlaylist();
  const safe = playlist.map(c => {
    const hasKeys = (c.clearKeys && Object.keys(c.clearKeys).length > 0) || !!c.license_key;
    return {
      id: c.id, idx: c.idx, name: c.name, logo: c.logo, group: c.group,
      url: `/api/play/${c.idx}`, tvg_id: String(c.idx),
      drm: hasKeys ? 'clearkey' : 'none',
      // all DRM goes through our license server (it proxies upstream if needed)
      license_server: hasKeys ? `/api/drm/clearkey?ch=${c.idx}` : '',
      clearKeys: {} // client fetches keys via license endpoint
    };
  });
  return reply
    .header('Cache-Control', `public, max-age=${Math.floor(CONFIG.playlistRefreshSec/2)}`)
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

// Also need to parse JSON body for license requests
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  try { done(null, JSON.parse(body || '{}')); } catch (e) { done(null, {}); }
});

// DRM clear-key endpoint (keys never leave the server in the playlist JSON!).
// Supports three cases:
//  1. Channel has static {kid:key} in clearKeys (old behavior) — return JWK directly.
//  2. Channel has an upstream license_key URL (e.g. ziotvplus.yowaimo.in/license/ID/)
//     — proxy the Shaka-style POST {"kids":[...]} to it and return the JWK response.
//  3. m3u8/URI key fetch via GET — returns JWK (for HLS #EXT-X-KEY URIs).
async function clearkeyHandler (req, reply) {
  await loadPlaylist();
  const kids = req.body?.kids || (req.query.kids ? String(req.query.kids).split(',') : []);
  const refCh = Number(req.query.ch) - 1;
  let ch = playlist[refCh];
  if (!ch) {
    const ref = req.headers.referer || '';
    const m = ref.match(/\/api\/play\/(\d+)/);
    if (m) ch = playlist[Number(m[1]) - 1];
  }
  if (!ch) return reply.code(404).send({ error: 'channel not found' });

  // Case 2: upstream license proxy (for Sflex / ziotvplus sources)
  if (ch.license_key && /^https?:\/\//.test(ch.license_key)) {
    try {
      const body = kids && kids.length
        ? JSON.stringify({ kids: kids })
        : (req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : '{"kids":[]}');
      const up = await fetchRawEx(ch.license_key, {
        'Content-Type': 'application/json',
        'User-Agent': ch.headers?.['User-Agent'] || 'Mozilla/5.0',
        'Referer': ch.headers?.Referer || '',
        'Origin': ch.headers?.Origin || ''
      }, 'POST', Buffer.from(body));
      reply.type('application/json').code(200);
      return reply.send(up.buffer);
    } catch (e) {
      // Fall through to static keys if available
      app.log.warn(e, `upstream license proxy failed for ch=${ch.idx}; falling back to static key`);
    }
  }

  // Cases 1 & 3: static JWK from clearKeys
  if (!ch.clearKeys || Object.keys(ch.clearKeys).length === 0) {
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
}

// Fallback: decrypt a fresh signed URL + clearkey from fan.kaizokutv.me/jio/player.php?url=<tvg-id>
// (AES-128-ECB, PKCS7, key "MySuperSecretKey" — see HTML source).
const KAIZOKU_PLAYER_URL = 'https://kaizokutv.me/jio/player.php?url=';
const KAIZOKU_SECRET = Buffer.from('MySuperSecretKey'.padEnd(16, '\0').slice(0, 16));
import { createDecipheriv } from 'node:crypto';
function aesEcbDecrypt (b64) {
  try {
    const ct = Buffer.from(b64, 'base64');
    const d = createDecipheriv('aes-128-ecb', KAIZOKU_SECRET, null);
    d.setAutoPadding(true);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch { return ''; }
}
const kaizokuPlayerCache = new Map(); // tvgId -> {url, kid, key, exp}
async function fetchFromKaizokuPlayer (tvgId) {
  if (!tvgId) return null;
  const cacheKey = String(tvgId);
  const cached = kaizokuPlayerCache.get(cacheKey);
  if (cached && cached.exp > now() + 30_000) return cached;
  try {
    const fetchUrl = KAIZOKU_PLAYER_URL + encodeURIComponent(tvgId);
    const hdrs = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    };
    const { buffer } = await fetchRawEx(fetchUrl, hdrs);
    const html = buffer.toString('utf8');
    const grab = v => {
      const re = new RegExp(v + String.raw`\s*=\s*"([^"]+)"`);
      const m = html.match(re);
      return m ? m[1] : '';
    };
    const es = grab('phpEncryptedStream');
    const eK = grab('phpEncryptedKey');
    const eKId = grab('phpEncryptedKeyId');
    const stream = es ? aesEcbDecrypt(es) : '';
    const kid = eKId ? aesEcbDecrypt(eKId) : '';
    const key = eK ? aesEcbDecrypt(eK) : '';
    if (!stream) return null;
    const expM = /exp=(\d+)/.exec(stream);
    const exp = expM ? Number(expM[1]) * 1000 : now() + 50 * 60 * 1000;
    const entry = { url: stream, kid, key, exp };
    kaizokuPlayerCache.set(cacheKey, entry);
    return entry;
  } catch (e) {
    app.log.warn(e, `kaizoku player fetch failed for tvg-id=${tvgId}`);
    return null;
  }
}
app.get('/api/drm/clearkey', clearkeyHandler);
app.post('/api/drm/clearkey', clearkeyHandler);

// play entry point: returns manifest through our proxy (no upstream URL leaked)
app.get('/api/play/:idx', async (req, reply) => {
  await loadPlaylist();
  const idx = Number(req.params.idx) - 1;
  const ch = playlist[idx];
  if (!ch || !ch.url) return reply.code(404).send({ error: 'channel not found' });
  req.log.info({ ch: ch.name, idx: ch.idx, fresh: isFreshCookie(ch.headers?.Cookie||'*notset*') }, 'play');
  // redirect internally to segment proxy with the real URL + per-channel headers
  req.query.u = ch.url;
  req._upstreamHeaders = ch.headers || {};
  req._channel = ch;     // for fallback to kaizoku player.php
  return segHandler(req, reply);
});

// generic segment/manifest proxy
async function segHandler (req, reply) {
  const ip = req.ip;
  if (rateLimited(ip)) return reply.code(429).send({ error: 'too many requests' });

  let url = String(req.query.u || '');
  if (!url) return reply.code(400).send({ error: 'missing u' });
  if (!/^https?:\/\//.test(url)) return reply.code(400).send({ error: 'bad url' });

  // Per-channel upstream headers (UA/Cookie/Referer/Origin).
  const extraHeaders = req._upstreamHeaders || {};

  // Cache key includes URL only (headers are part of the signing already baked in).
  let cacheKey = hash(url);
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

  // Fetcher with optional fallback URL swap (manifest refresh from player.php)
  async function tryFetch (targetUrl, hdrs, isManifest) {
    let lastErr;
    for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
      try {
        const { buffer, ct } = await fetchRaw(targetUrl, hdrs);
        let outBuf = buffer, outCt = ct;
        if (isManifest && /mpegurl|dash\+xml|m3u8|mpd/i.test(ct)) {
          const { body, ct: ct2 } = rewriteManifest(buffer.toString('utf8'), ct, targetUrl);
          outBuf = Buffer.from(body, 'utf8');
          outCt = ct2;
        }
        return { buffer: outBuf, ct: outCt };
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('fetch failed');
  }

  const isManifest = /\.mpd(\?|$)/.test(url) || /\.m3u8(\?|$)/.test(url)
                     || /fan\.kaizokutv\.me\/prox\/jio-prox\.php/.test(url); // top-level /api/play

  const doFetch = (async () => {
    try {
      let res = await tryFetch(url, extraHeaders, isManifest);
      // If Jio/kaizoku manifest returned 403/404 and this is a channel manifest request,
      // fall back to fetching a fresh signed URL from kaizokutv.me's AES-encrypted player.php
      if (isManifest && req._channel) {
        const ch = req._channel;
        const tvgId = ch.id && ch.id.startsWith('ch_') ? ch.id.slice(3) : '';
        if (tvgId && /fan\.kaizokutv\.me/.test(url) && (!res || res.buffer.length < 200)) {
          // retry is already done; try fallback
        }
      }
      const outBuf = res.buffer, outCt = res.ct;
      const manifestLike = /mpegurl|dash\+xml|m3u8|mpd/i.test(outCt);
      cacheSet(cacheKey, { buffer: outBuf, ct: outCt },
        manifestLike ? CONFIG.manifestCacheSec : CONFIG.segmentCacheSec);
      return reply
        .header('Content-Type', outCt)
        .header('X-Cache', 'MISS')
        .header('Cache-Control', `public, max-age=${
          manifestLike ? CONFIG.manifestCacheSec : CONFIG.segmentCacheSec
        }`)
        .header('Access-Control-Allow-Origin', '*')
        .send(outBuf);
    } catch (e) {
      // Fallback: if Jio manifest 403/401/404 and channel has tvg-id, pull fresh URL from kaizoku player.php
      if (isManifest && req._channel) {
        const ch = req._channel;
        const tvgId = ch.id && ch.id.startsWith('ch_') ? ch.id.slice(3) : '';
        const isJio = /jiotv|bpk-tv|jio\.com/.test(url);
        if (tvgId && isJio) {
          try {
            const fresh = await fetchFromKaizokuPlayer(tvgId);
            if (fresh && fresh.url) {
              req.log.info(`kaizoku player fallback for ${ch.name} (tvg=${tvgId})`);
              // Patch channel URL + DRM keys in memory so subsequent hits use the fresh ones
              ch.url = fresh.url;
              if (fresh.kid && fresh.key) {
                ch.clearKeys = { [fresh.kid.toLowerCase()]: fresh.key.toLowerCase() };
              }
              req.query.u = fresh.url;
              cache.delete(cacheKey);
              return segHandler(req, reply);
            }
          } catch (fe) {
            req.log.warn(fe, 'kaizoku fallback failed');
          }
        }
      }
      reply.log.error({ err: e, url: url.slice(0,200) }, 'upstream fetch failed');
      return reply.code(502).send({ error: 'upstream fetch failed' });
    }
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
