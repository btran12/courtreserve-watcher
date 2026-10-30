# DUPR lookup proxy

Small local server + page that looks up DUPR ratings for a list of names, using your own
logged-in `dashboard.dupr.com` session.

## Why a proxy

`POST https://api.dupr.com/player/v1.0/search` is the endpoint the DUPR dashboard itself uses.

- It answers **only** when the request carries a logged-in session cookie (anonymous requests get
  `401 "Authentication error. Please provide a valid API key."`).
- It sends **no CORS headers** (preflight from `http://localhost:8787` → `403`), so a browser page
  on another origin cannot call it directly.

So this server keeps the cookie and does the calls; the page in `index.html` talks to the server.

## Setup

1. Sign in at <https://dashboard.dupr.com>.
2. DevTools → **Application** → **Cookies**. Copy the two cookies whose **domain is `api.dupr.com`**:

   | Cookie | What it is |
   |---|---|
   | `__Host-dupr_at` | JWT **access token** — this is the one that authenticates the API |
   | `__Host-dupr_rt` | refresh token (include it, the proxy doesn't refresh on its own) |

   Everything else in that list is noise: `_ga*`, `_fbp`, `_gcl_au`, `ab.storage.*`, `__stripe_mid`,
   `__stripe_sid`, `_s` (app.link), `NID`, `JSESSIONID` / `action.mediadegrees.com`, Facebook `fr`/`_acl`,
   `SEARCH_SAMESITE`, `test cookie`, … None of those are sent to `api.dupr.com`.

   `__Host-` cookies are **HttpOnly**, so they can't be read from page JavaScript — copy the values from DevTools.
3. Save them as a single line to `tools/dupr/cookie.txt` (git-ignored):

   ```
   __Host-dupr_at=eyJraWQiOi...; __Host-dupr_rt=eyJraWQiOi...
   ```

   or set `DUPR_COOKIE` in the environment.
4. Run the proxy and open the page:

   ```bash
   npm run dupr          # → http://localhost:8787
   ```

The proxy sends the cookie on each request; if DUPR instead wants the access token as a bearer
header it retries once with `Authorization: Bearer <__Host-dupr_at>` and keeps using that mode
(you can force it with `DUPR_AUTH="Bearer …"`).

## Using the page

Styled after the DUPR dashboard (navy `#05155E`, accent `#3A79E0`, white cards, pill controls).

- **One name** — type a full name and press Enter. Every same-name DUPR profile comes back as a list
  row (photo/initials, name, DUPR ID, city-state · age · gender, doubles/singles chips with
  reliability). Click a row to select it (selection drives the CSV export).
- **Multiple names** — paste a roster (one per line, the box shows placeholder examples such as
  `John Doe` / `Jane Doe` and starts empty), **Look up all**. Each name gets its own group with its
  candidate profiles; unmatched names show why (`no match in "CT, MA" — 3 same-name profiles elsewhere`).
  Whatever you type is remembered locally (`localStorage`), nothing is baked into the page.
- **Location filter** — matched against the address text DUPR returns for each profile
  (`shortAddress`, e.g. `Granby, CT, US`), not against any geocoding or radius. Format:
  - comma-separated tokens, any match passes (`CT, MA`);
  - a **2-character** token must equal the state code exactly (`CT` → only Connecticut, so it no longer
    matches "Vi**ct**oria");
  - anything **longer** is a case-insensitive substring of the address (`Quincy`, `Hartford`, `Connecticut`);
  - empty = no filter (every hit); defaults to `CT, MA`.
  Filtering runs client-side because DUPR's own `filter.locationText` parameter is ignored server-side
  (verified: identical totals for `""`, `"CT"`, `"Connecticut"`). Only the first 30 hits per name are
  fetched (`DUPR_MAX_PAGES`), so for very common names widen that if the local match is not in the top 3 pages.
- **Sort by doubles** re-orders rows; **Export CSV** downloads the selected profile per requested name.

## Notes

- DUPR sorts by proximity, so the club's coordinates (`DUPR_LAT`/`DUPR_LNG`, default East Hartford)
  are sent with each query. Only the first 3 pages (30 hits) are scanned per name.
- `limit` must be ≤ 10 — larger values return `400`.
- Ratings carry `doublesReliabilityScore` / `singlesReliabilityScore` (0–100). The page colours them:
  green ≥ 80, amber ≥ 50, red below that. A high rating with low reliability (e.g. rel 10) is weak.
- Results are cached in `tools/dupr/cache.json` for 6 h (`DUPR_CACHE_MINUTES`), so re-running a
  roster costs no extra DUPR requests.
- The cookie expires when DUPR logs the session out; copy a fresh one and restart the proxy.

## Env vars

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | HTTP port for the local page |
| `DUPR_COOKIE` / `DUPR_COOKIE_FILE` | `tools/dupr/cookie.txt` | `__Host-dupr_at` (+ `__Host-dupr_rt`) cookie string |
| `DUPR_AUTH` | – | send this verbatim as `Authorization` instead of a cookie (e.g. `Bearer eyJ…`) |
| `DUPR_LAT` / `DUPR_LNG` | `41.5623209` / `-72.6506488` | search bias location (East Hartford) |
| `DUPR_STATES` | `CT,MA` | comma-separated states treated as "local" |
| `DUPR_MAX_PAGES` | `3` | pages of 10 hits scanned per name |
| `DUPR_CACHE_MINUTES` | `360` | cache TTL |
| `DUPR_THROTTLE_MS` | `250` | pause between DUPR requests |

## About the partner API key

`api.dupr.gg` (the documented API) rejects anonymous calls with
`401 "Authentication error. Please provide a valid API key."`. Per <https://api.dupr.gg/docs>:

- **Public APIs** — "endpoints accessible with external read-only tokens", i.e. tokens **issued by DUPR**;
- **Internal APIs** — swagger login restricted to `@dupr.com` / `@mydupr.com` accounts.

There is no self-serve key page — a partner token is provisioned through DUPR's partner/integration
program (contact via <https://www.dupr.com/partners> or your DUPR account manager). That is why this
tool reuses your own dashboard session instead.

Automated querying may be restricted by DUPR's terms — this is intended for occasional lookups of
your own league rosters against your own account.
