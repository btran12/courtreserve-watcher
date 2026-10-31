// Shared DUPR search core — used by the local dev server (server.mjs), the Lambda handler
// (lambda.mjs) and the CloudFormation build (build-template.mjs, which inlines it).
//
// Keep this file free of imports so it can be concatenated into a single CommonJS Lambda source.

const API = 'https://api.dupr.com/player/v1.0/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PAGE_SIZE = 10; // DUPR rejects larger limits

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Accepts "name=value; name2=value2" with an optional leading "Cookie:"; a bare JWT becomes
// __Host-dupr_at (the access token cookie DUPR actually checks).
export function normalizeCookie(value) {
  let out = String(value || '')
    .replace(/^\s*cookie:\s*/i, '')
    .replace(/\r?\n[\s\S]*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!out) return '';
  if (!out.includes('=') && out.startsWith('eyJ')) out = `__Host-dupr_at=${out}`;
  return out;
}

const toRating = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const cookieAccessToken = (cookie) => (/(?:^|;\s*)__Host-dupr_at=([^;]+)/.exec(cookie || '') || [])[1] || '';

export function annotate(hit) {
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
    inRegion: !!state,
  };
}

export function createEngine(env = process.env) {
  const cookie = normalizeCookie(env.DUPR_COOKIE || '');
  const accessToken = (/(?:^|;\s*)__Host-dupr_at=([^;]+)/.exec(cookie) || [])[1] || '';
  const cfg = {
    cookie,
    accessToken,
    states: (env.DUPR_STATES || 'CT,MA').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    lat: Number(env.DUPR_LAT) || 41.5623209,
    lng: Number(env.DUPR_LNG) || -72.6506488,
    maxPages: Math.max(1, Number(env.DUPR_MAX_PAGES) || 3),
    throttleMs: Number(env.DUPR_THROTTLE_MS) || 250,
    ttlMs: (Number(env.DUPR_CACHE_MINUTES) || 360) * 60_000,
    explicitAuth: env.DUPR_AUTH || '',
  };

  const cache = new Map();
  let authMode = cfg.explicitAuth ? 'header' : 'cookie'; // flips to 'header' if DUPR prefers that

  // Auth context for one request: the user's own cookie when supplied, else the configured default.
  const authFrom = (cookieHeader) => {
    const supplied = normalizeCookie(cookieHeader || '');
    if (!supplied) return { cookie: cfg.cookie, accessToken: cfg.accessToken, explicitAuth: cfg.explicitAuth, supplied: false };
    return { cookie: supplied, accessToken: cookieAccessToken(supplied), explicitAuth: cfg.explicitAuth, supplied: true };
  };
  const defaultAuth = () => authFrom('');

  async function searchPage(query, offset, auth, mode = authMode) {
    const useHeader = mode === 'header';
    const authHeaders = useHeader
      ? { authorization: auth.explicitAuth || (auth.accessToken ? `Bearer ${auth.accessToken}` : '') }
      : (auth.cookie ? { cookie: auth.cookie } : {});
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
        ...authHeaders,
      },
      body: JSON.stringify({
        limit: PAGE_SIZE,
        offset,
        query,
        exclude: [],
        includeUnclaimedPlayers: true,
        filter: { lat: cfg.lat, lng: cfg.lng, rating: { maxRating: null, minRating: null }, locationText: '' },
      }),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON, e.g. a block page */ }
    return { status: res.status, json, text, mode };
  }

  // Cookie first; if DUPR rejects it, retry once with the access token as a bearer header.
  async function searchWithAuth(query, offset, auth) {
    const first = await searchPage(query, offset, auth);
    if (first.status !== 401 && first.status !== 403) return first;
    if (authMode !== 'cookie' || (!auth.accessToken && !auth.explicitAuth)) return first;
    const second = await searchPage(query, offset, auth, 'header');
    if (second.status === 200) { authMode = 'header'; return second; }
    return first;
  }

  async function lookup(query, auth = defaultAuth()) {
    const key = String(query).toLowerCase().replace(/\s+/g, ' ').trim();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cfg.ttlMs) return { ...hit, cached: true };

    const hits = [];
    let total = 0;
    let status = 0;
    for (let page = 0; page < cfg.maxPages; page += 1) {
      const res = await searchWithAuth(query, page * PAGE_SIZE, auth);
      status = res.status;
      if (res.status === 401 || res.status === 403) {
        return {
          query,
          status,
          error: 'cookie-rejected',
          message: res.json?.message || 'DUPR rejected the session cookie',
          hint: auth.supplied
            ? 'The cookie you supplied was rejected — it is probably expired; copy a fresh __Host-dupr_at from dashboard.dupr.com.'
            : (auth.accessToken
              ? 'The __Host-dupr_at access token was sent but rejected — it has probably expired; copy a fresh cookie.'
              : 'Copy the __Host-dupr_at cookie (api.dupr.com) into the DUPR_COOKIE setting.'),
          hits: [],
          total: 0,
        };
      }
      if (res.status !== 200 || !res.json) {
        return { query, status, error: 'request-failed', message: res.json?.message || `HTTP ${res.status}`, hits: [], total: 0 };
      }
      total = res.json.result?.total ?? 0;
      const pageHits = res.json.result?.hits || [];
      hits.push(...pageHits);
      if (hits.length >= total || !pageHits.length) break;
      await sleep(cfg.throttleMs);
    }

    const entry = { at: Date.now(), query, status, total, hits: hits.map(annotate), error: null };
    cache.set(key, entry);
    return entry;
  }

  return {
    cfg,
    cache,
    authFrom,
    lookup,
    get authMode() { return authMode; },
    async verify(auth = defaultAuth()) {
      if (!auth.cookie && !auth.explicitAuth) return { ok: false, reason: 'no-cookie', userCookie: auth.supplied };
      const probe = await searchWithAuth('pickleball', 0, auth);
      if (probe.status === 200) return { ok: true, authMode: probe.mode, userCookie: auth.supplied };
      return {
        ok: false,
        reason: probe.status === 401 || probe.status === 403 ? 'cookie-rejected' : `http-${probe.status}`,
        message: probe.json?.message,
        userCookie: auth.supplied,
      };
    },
    async bulk(names, auth = defaultAuth()) {
      const results = [];
      for (const name of names) {
        try {
          results.push(await lookup(name, auth));
        } catch (e) {
          results.push({ query: name, error: 'request-failed', message: e.message, hits: [], total: 0 });
        }
        if (results.at(-1).error === 'cookie-rejected') break; // no point hammering DUPR
        await sleep(cfg.throttleMs);
      }
      return results;
    },
    status() {
      return {
        cookieSet: !!cfg.cookie,
        accessTokenFound: !!cfg.accessToken,
        authMode,
        states: cfg.states,
        lat: cfg.lat,
        lng: cfg.lng,
        cached: cache.size,
        maxPages: cfg.maxPages,
      };
    },
    // optional on-disk cache for the local server; Lambda simply skips it
    loadCache(file, fs) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [k, v] of Object.entries(raw)) cache.set(k, v);
      } catch { /* first run */ }
    },
    saveCache(file, fs) {
      try {
        fs.writeFileSync(file, JSON.stringify(Object.fromEntries(cache), null, 1));
      } catch { /* read-only fs, ignore */ }
    },
  };
}

// One router shared by the HTTP server and the Lambda adapter.
export function createRouter(engine, { html = '', token = '', origin = '*' } = {}) {
  const cors = {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-headers': 'content-type,x-dupr-token,x-dupr-cookie',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
  const json = (statusCode, body, extra = {}) => ({
    statusCode,
    headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
    body: JSON.stringify(body),
  });

  return async function route(method, pathname, params = {}, bodyText = '', headers = {}) {
    if (method === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      if (!html) return json(404, { error: 'page-not-bundled' });
      return { statusCode: 200, headers: { ...cors, 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: html };
    }

    if (pathname.startsWith('/api/') && token) {
      const sent = headers['x-dupr-token'] || headers['X-Dupr-Token'] || '';
      if (sent !== token) {
        return json(401, { error: 'bad-token', message: 'Missing or wrong x-dupr-token header' });
      }
    }

    // A caller may send their own DUPR cookie for this request; otherwise the configured default is used.
    const auth = engine.authFrom(headers['x-dupr-cookie'] || headers['X-Dupr-Cookie'] || '');

    if (method === 'GET' && pathname === '/api/status') return json(200, { ...engine.status(), userCookie: auth.supplied });
    if (method === 'GET' && pathname === '/api/verify') return json(200, await engine.verify(auth));

    if (method === 'GET' && pathname === '/api/search') {
      const q = String(params.q || '').trim();
      if (!q) return json(400, { error: 'missing q' });
      try {
        return json(200, { ...(await engine.lookup(q, auth)), userCookie: auth.supplied });
      } catch (e) {
        return json(502, { error: 'request-failed', message: e.message });
      }
    }

    if (method === 'POST' && pathname === '/api/bulk') {
      let body;
      try {
        body = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        return json(400, { error: 'bad json' });
      }
      const names = (body.names || []).map((n) => String(n).trim()).filter(Boolean).slice(0, 200);
      if (!names.length) return json(400, { error: 'missing names' });
      try {
        return json(200, { results: await engine.bulk(names, auth), userCookie: auth.supplied });
      } catch (e) {
        return json(502, { error: 'request-failed', message: e.message });
      }
    }

    return json(404, { error: 'not found' });
  };
}
