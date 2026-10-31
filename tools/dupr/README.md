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

### Using your own cookie from the page

The cookie on the server is only a **default**. Any visitor can use their own session instead:

* click **My cookie** in the header, paste `__Host-dupr_at=eyJ…` (or just the JWT), **Save**;
* the page keeps it in `localStorage` and sends it on every call as the `x-dupr-cookie` header;
* the pill next to the title shows `my cookie` vs `server cookie`, and **Test cookie** reports
  `cookie works` / `cookie rejected (yours)` / `cookie rejected (server)`;
* **Clear both** (or saving an empty value) drops back to the server's cookie.

The override is per request — it is never written to a file and never replaces the server's cookie,
so one person's expired session can't break anyone else. When a supplied cookie is rejected the
error is explicit about it:

```json
{ "error": "cookie-rejected", "userCookie": true,
  "hint": "The cookie you supplied was rejected — it is probably expired; copy a fresh __Host-dupr_at from dashboard.dupr.com." }
```

Server-side the same thing is just a header:

```bash
curl -H "x-dupr-cookie: __Host-dupr_at=eyJ…" "http://localhost:8787/api/search?q=Kha%20Lam"
```

## Deploying it as an AWS Lambda (console, no CLI)

Two templates are **generated** from `app.mjs` + `lambda.mjs` + `index.html` (the page is inlined
as base64, the code as `Code.ZipFile`). Re-build both after any change to those files:

```bash
npm run dupr:template
#   aws/dupr-template.yaml        Lambda + public Function URL  (page at /, 60 s timeout)
#   aws/dupr-apigw-template.yaml  Lambda + API Gateway HTTP API (page hosted elsewhere, 30 s cap)
```

### Option A — API Gateway, page hosted separately (recommended for sharing)

Use `aws/dupr-apigw-template.yaml`. It creates a Lambda function, an **HTTP API** with a
`$default` route/stage, and the `lambda:InvokeFunction` permission for `apigateway.amazonaws.com`.
CORS is configured on the API (headers `content-type, x-dupr-token, x-dupr-cookie`).

1. **CloudFormation → Create stack → With new resources** → upload `aws/dupr-apigw-template.yaml`.
2. Parameters: `AllowedOrigin` = the origin that hosts your page (e.g. `https://you.github.io`) or
   `*` while testing; `DuprCookie` **may be left empty** (each visitor then supplies their own via
   the page's **My cookie** button); `ApiToken` = a long random string if you want `/api/*` locked.
3. Create, then copy the **Outputs → `ApiBaseUrl`** value, e.g.
   `https://abc123.execute-api.us-east-1.amazonaws.com`.
4. Host `tools/dupr/index.html` anywhere static (GitHub Pages, S3 + CloudFront, Netlify…). Point it
   at the API either way:
   - open it once as `https://your.site/?api=https://abc123.execute-api.us-east-1.amazonaws.com`
     (the value is saved in `localStorage` and the query string is then removed), or
   - click **My cookie** → **Endpoint** field → paste → **Use endpoint**.
   Leave the field empty when the Lambda serves the page itself (option B) — requests then go
   to the same origin.
5. If you set `ApiToken`, paste it once via **API key**.

`/api/*` paths are identical in both options, so the same page works against either.

> **30-second ceiling.** An API Gateway integration is cut off at 30 s no matter what the Lambda
> timeout is, so this template defaults `Timeout: 29`, `MaxPages: 2`. For big rosters send a few
> names per request (the page already splits long lists into batches of 8) or use option B.

### Option B — Lambda Function URL (single artifact, 60 s timeout)

Use `aws/dupr-template.yaml`:

1. **CloudFormation → Create stack → With new resources (standard)**.
2. **Template is ready → Upload a template file** → pick `aws/dupr-template.yaml`.
3. Stack name, e.g. `courtreserve-dupr`, then fill the parameters:

   | Parameter | What to put |
   |---|---|
   | `DuprCookie` | `__Host-dupr_at=eyJ…; __Host-dupr_rt=eyJ…` (or just the JWT) — stored as the function's `DUPR_COOKIE` |
   | `ApiToken` | a long random string; then `/api/*` requires it in the `x-dupr-token` header. Leave blank only if you really want an open endpoint |
   | `AllowedOrigin` | `*` for testing, or your site origin to restrict CORS |
   | `States` / `SearchLat` / `SearchLng` | defaults are CT,MA and East Hartford |
   | `MaxPages` / `CacheMinutes` / `ThrottleMs` | 3 / 360 / 250 are fine |
   | `Timeout` / `MemorySize` | 60 s / 512 MB (a 14-name bulk run takes ~15–25 s) |

4. Acknowledge the IAM capability (`AWS::IAM::Role`) and create. The **Outputs** tab gives you
   `FunctionUrl`, `SearchEndpoint`, `BulkEndpoint`, `StatusEndpoint` and whether a token is required.
5. Open `FunctionUrl` in a browser — that's the page. If you set `ApiToken`, click **API key** once
   and paste it; it's kept in `localStorage`.

If a Function URL answers `403 Forbidden` / `AccessDeniedException`, the function is missing the
`lambda:InvokeFunctionUrl` statement (Permissions tab → *Add permissions* → **Function URL**, auth
type `NONE`) or you are testing the URL of a different function.

Calling it from another app:

```bash
# one name
curl "$URL/api/search?q=John%20Doe" -H "x-dupr-token: $TOKEN"

# a roster (one request, sequential upstream calls)
curl "$URL/api/bulk" -H "x-dupr-token: $TOKEN" -H 'content-type: application/json' \
     -d '{"names":["John Doe","Jane Doe"]}'

# health / cache info
curl "$URL/api/status" -H "x-dupr-token: $TOKEN"
```

Notes for the Lambda flavour:

- The cookie lives in the function's environment (`NoEcho` parameter). Rotating it means a stack
  update with a fresh `DuprCookie` — or move it to SSM SecureString and read it at cold start.
  With the API Gateway template the cookie is optional: visitors can bring their own.
- The cache is per warm container (no shared `/tmp`), so a cold start refetches. Fine for occasional use.
- Cold start ≈ 0.5–1 s; the first bulk call after idle is the slow one.
- The stack keeps one small log group (`/aws/lambda/<stack>-dupr-lookup`, 14-day retention).

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
