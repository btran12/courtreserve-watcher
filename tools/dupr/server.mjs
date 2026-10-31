// Local dev server: `npm run dupr` → http://localhost:8787
// All the logic lives in app.mjs; this file is only the Node HTTP wrapper.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine, createRouter } from './app.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;

function loadCookieFile() {
  if (process.env.DUPR_COOKIE) return process.env.DUPR_COOKIE;
  try {
    return fs.readFileSync(process.env.DUPR_COOKIE_FILE || path.join(HERE, 'cookie.txt'), 'utf8');
  } catch {
    return '';
  }
}

const engine = createEngine({ ...process.env, DUPR_COOKIE: loadCookieFile() });
engine.loadCache(path.join(HERE, 'cache.json'), fs);

const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
const route = createRouter(engine, {
  html,
  token: process.env.DUPR_API_TOKEN || '',
  origin: process.env.ALLOWED_ORIGIN || '*',
});

const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) { reject(new Error('body too large')); req.destroy(); }
  });
  req.on('end', () => resolve(raw));
  req.on('error', reject);
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  let body = '';
  try {
    body = await readBody(req);
  } catch (e) {
    res.writeHead(413, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
    return;
  }

  const query = Object.fromEntries(url.searchParams.entries());
  const out = await route(req.method || 'GET', pathname, query, body, req.headers);
  res.writeHead(out.statusCode, out.headers || {});
  res.end(out.body);

  if (req.method !== 'GET' || pathname.includes('/api/')) {
    engine.saveCache(path.join(HERE, 'cache.json'), fs);
  }
});

server.listen(PORT, () => {
  const s = engine.status();
  console.log(`DUPR search proxy → http://localhost:${PORT}`);
  console.log(`  cookie: ${s.cookieSet ? 'loaded' : 'MISSING (put it in tools/dupr/cookie.txt or DUPR_COOKIE)'}`);
  console.log(`  __Host-dupr_at: ${s.accessTokenFound ? 'found' : 'not found in cookie'}`);
  console.log(`  auth mode: ${s.authMode} · states: ${s.states.join(', ') || '(none)'} · origin: ${s.lat},${s.lng} · cache: ${s.cached} queries`);
  if (process.env.DUPR_API_TOKEN) console.log('  api token: required on /api/* (x-dupr-token)');
});
