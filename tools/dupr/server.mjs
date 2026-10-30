#!/usr/bin/env node
// DUPR player search proxy.
//
// The DUPR search API (api.dupr.com/player/v1.0/search) only answers requests that carry a
// logged-in dashboard.dupr.com session cookie, and it sends no CORS headers, so a normal web
// page cannot call it directly. This tiny server holds that cookie and proxies the lookups for
// the local UI in ./index.html.
//
// Usage:
//   1. Copy the DUPR session cookie into tools/dupr/cookie.txt (see README section in index.html)
//      or export DUPR_COOKIE="name=value; other=value".
//   2. npm run dupr      (or: node tools/dupr/server.mjs)
//   3. Open http://localhost:8787
//
// Env overrides: PORT, DUPR_COOKIE, DUPR_COOKIE_FILE, DUPR_LAT, DUPR_LNG, DUPR_STATES,
//                DUPR_MAX_PAGES, DUPR_CACHE_MINUTES, DUPR_THROTTLE_MS
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const API = 'https://api.dupr.com/player/v1.0/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Club location used to bias DUPR's proximity ordering (East Hartford Racquet Club).
const LAT = Number(process.env.DUPR_LAT) || 41.5623209;
const LNG = Number(process.env.DUPR_LNG) || -72.6506488;
const STATES = (process.env.DUPR_STATES || 'CT,MA')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const MAX_PAGES = Math.max(1, Number(process.env.DUPR_MAX_PAGES) || 3); // 10 hits per page
const PAGE_SIZE = 10; // the API rejects larger limits
const THROTTLE_MS = Number(process.env.DUPR_THROTTLE_MS) || 250;
const TTL_MS = (Number(process.env.DUPR_CACHE_MINUTES) || 360) * 60_000;

const CACHE_FILE = path.join(HERE, 'cache.json');

function loadCookie() {
  if (process.env.DUPR_COOKIE) return process.env.DUPR_COOKIE;
  const file = process.env.DUPR_COOKIE_FILE || path.join(HERE, 'cookie.txt');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Accepts "name=value; name2=value2", with or without a leading "Cookie:" and stray newlines.
// A bare JWT is also accepted and treated as the __Host-dupr_at access token.
function normalizeCookie(value) {
  let out = String(value || '').replace(/^\s*cookie:\s*/i, '').replace(/\r?\n[\s\S]*$/, '').replace(/\s{2,}/g, ' ').trim();
  if (!out) return '';
  if (!out.includes('=') && out.startsWith('eyJ')) out = `__Host-dupr_at=${out}`;
  return out;
}
const COOKIE = normalizeCookie(loadCookie());

// The dashboard keeps the DUPR access token in a __Host- cookie (api.dupr.com). If the API ever
// wants it as a bearer token instead of a cookie, we can reuse the same value.
const ACCESS_TOKEN = (/(?:^|;\s*)__Host-dupr_at=([^;]+)/.exec(COOKIE) || [])[1] || '';
let AUTH_MODE = process.env.DUPR_AUTH ? 'header' : 'cookie'; // flipped to 'header' on a 401 retry
const EXPLICIT_AUTH = process.env.DUPR_AUTH || '';

// ── cache ────────────────────────────────────────────────────────────────────
const cache = new Map();
try {
  const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  for (const [key, value] of Object.entries(raw)) cache.set(key, value);
} catch { /* first run */ }

let saveTimer = null;
function saveCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache), null, 1));
    } catch (e) {
      console.warn('cache write failed:', e.message);
    }
  }, 500);
}

// ── DUPR calls ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function searchPage(query, offset, mode = AUTH_MODE) {
  const auth = mode === 'header'
    ? { authorization: EXPLICIT_AUTH || (ACCESS_TOKEN ? `Bearer ${ACCESS_TOKEN}` : '') }
    : (COOKIE ? { cookie: COOKIE } : {});
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      expires: '0',
      origin: 'https://dashboard.dupr.com',
      referer: 'https://dashboard.dupr.com/',
      'user-agent': UA,
      'x-dupr-client-capabilities': 'totp,webauthn',
      ...auth,
    },
    body: JSON.stringify({
      limit: PAGE_SIZE,
      offset,
      query,
      exclude: [],
      includeUnclaimedPlayers: true,
      filter: { lat: LAT, lng: LNG, rating: { maxRating: null, minRating: null }, locationText: '' },
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON (e.g. Cloudflare block page) */ }
  return { status: res.status, json, text, mode };
}

// Cookie first; if DUPR rejects it, retry once with the access token as a bearer header.
async function searchWithAuth(query, offset) {
  const first = await searchPage(query, offset);
  if (first.status !== 401 && first.status !== 403) return first;
  if (AUTH_MODE !== 'cookie' || (!ACCESS_TOKEN && !EXPLICIT_AUTH)) return first;
  const second = await searchPage(query, offset, 'header');
  if (second.status === 200) {
    AUTH_MODE = 'header';
    console.log('DUPR accepted the access token as a bearer header; switching auth mode to "header".');
    return second;
  }
  return first;
}

const toRating = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

function annotate(hit) {
  const address = hit.shortAddress || null;
  const state = (/([A-Z]{2}),\s*US$/i.exec(address || '') || [])[1]?.toUpperCase() || null;
  return {
    id: hit.duprId || hit.id,
    name: hit.fullName,
    image: hit.imageUrl || null,
    address,
    state,
    age: hit.age ?? null,
    gender: hit.gender ?? null,
    doubles: toRating(hit.ratings?.doubles),
    doublesReliability: hit.ratings?.doublesReliabilityScore ?? null,
    doublesProvisional: !!hit.ratings?.doublesProvisional,
    singles: toRating(hit.ratings?.singles),
    singlesReliability: hit.ratings?.singlesReliabilityScore ?? null,
    singlesProvisional: !!hit.ratings?.singlesProvisional,
    inRegion: !!state && STATES.includes(state),
  };
}

async function lookup(query) {
  const key = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return { ...cached, cached: true };

  const hits = [];
  let total = 0;
  let status = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await searchWithAuth(query, page * PAGE_SIZE);
    status = res.status;
    if (res.status === 401 || res.status === 403) {
      return {
        query,
        status: res.status,
        error: 'cookie-rejected',
        message: res.json?.message || 'DUPR rejected the session cookie',
        hint: ACCESS_TOKEN
          ? 'The __Host-dupr_at access token was sent but rejected — it has probably expired, copy a fresh __Host-dupr_at (and __Host-dupr_rt) from DevTools.'
          : 'Copy the __Host-dupr_at cookie (api.dupr.com) into tools/dupr/cookie.txt — that is the one DUPR uses as the access token.',
        hits: [],
        total: 0,
      };
    }
    if (res.status !== 200 || !res.json) {
      return { query, status: res.status, error: 'request-failed', message: res.json?.message || `HTTP ${res.status}`, hits: [], total: 0 };
    }
    total = res.json.result?.total ?? 0;
    hits.push(...(res.json.result?.hits || []));
    if (hits.length >= total || !(res.json.result?.hits || []).length) break;
    await sleep(THROTTLE_MS);
  }

  const entry = {
    at: Date.now(),
    query,
    status,
    total,
    hits: hits.map(annotate),
    error: null,
  };
  cache.set(key, entry);
  saveCache();
  return entry;
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
};

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); }
  });
  req.on('end', () => {
    if (!raw) return resolve({});
    try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('bad json')); }
  });
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(path.join(HERE, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(html);
    } catch {
      json(res, 500, { error: 'index.html missing' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    json(res, 200, {
      cookieSet: !!COOKIE,
      accessTokenFound: !!ACCESS_TOKEN,
      authMode: AUTH_MODE,
      states: STATES,
      lat: LAT,
      lng: LNG,
      cached: cache.size,
      maxPages: MAX_PAGES,
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/verify') {
    if (!COOKIE && !EXPLICIT_AUTH) return json(res, 200, { ok: false, reason: 'no-cookie' });
    const probe = await searchWithAuth('pickleball', 0);
    if (probe.status === 200) return json(res, 200, { ok: true, authMode: probe.mode });
    return json(res, 200, {
      ok: false,
      reason: probe.status === 401 || probe.status === 403 ? 'cookie-rejected' : `http-${probe.status}`,
      message: probe.json?.message,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) return json(res, 400, { error: 'missing q' });
    try {
      json(res, 200, await lookup(query));
    } catch (e) {
      json(res, 502, { error: e.message });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/bulk') {
    let body;
    try { body = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    const names = (body.names || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 200);
    if (!names.length) return json(res, 400, { error: 'missing names' });
    const results = [];
    for (const name of names) {
      try {
        results.push(await lookup(name));
      } catch (e) {
        results.push({ query: name, error: 'request-failed', message: e.message, hits: [], total: 0 });
      }
      if (results.at(-1).error === 'cookie-rejected') break; // no point hammering
      await sleep(THROTTLE_MS);
    }
    json(res, 200, { results });
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`DUPR search proxy → http://localhost:${PORT}`);
  console.log(`  cookie: ${COOKIE ? 'loaded' : 'MISSING (put it in tools/dupr/cookie.txt or DUPR_COOKIE)'}`);
  console.log(`  __Host-dupr_at: ${ACCESS_TOKEN ? 'found' : 'not found in cookie'}`);
  console.log(`  auth mode: ${AUTH_MODE} · states: ${STATES.join(', ') || '(none)'} · origin: ${LAT},${LNG} · cache: ${cache.size} queries`);
});
