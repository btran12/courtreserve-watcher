# CourtReserve Watcher

Tracks who joins and leaves the evening open play sessions at **East Hartford
Racquet Club** (CourtReserve org `17397`), for **Mon / Wed / Fri** sessions
starting at or after **7:00 PM**.

It polls the club's public calendar, records each session's registrant and
waitlist names, diffs them against the previous poll, and tells you what moved —
via a Windows desktop toast and a local dashboard.

No CourtReserve account or login is used. Everything reads from pages the club
already serves to anonymous visitors.

---

## Quick start

```bat
cd C:\Users\baotr\GIT\courtreserve-watcher

npm test                 :: 74 unit tests, no network
npm run poll             :: one poll cycle, verbose output
npm run dashboard        :: rebuild docs/index.html from stored data
npm run pages            :: rebuild it and push to GitHub Pages now

start docs\index.html    :: open the dashboard
```

Register the scheduled task (runs every 15 min while you are signed in):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
```

Remove it again:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1 -Remove
```

Useful task commands:

```powershell
Start-ScheduledTask   -TaskName CourtReserveWatcher   # run it now
Get-ScheduledTaskInfo -TaskName CourtReserveWatcher   # last run / next run / result
```

---

## How it works

Two unauthenticated endpoints, discovered by reading the portal's own page source:

**1. Calendar feed** — the Kendo scheduler's data source. Returns one row per
event occurrence with counts and a stable occurrence key.

```
POST https://app.courtreserve.com/Online/Calendar/ReadCalendarEvents/17397
     content-type: application/x-www-form-urlencoded
     body: jsonData={"orgId":"17397","ViewType":"Month","KendoStart":{...},...}
```

Fields used: `Number`, `EventName`, `EventType`, `Start`, `End`,
`MaxMembersOnEvent`, `SignedMembers`, `WaitListCount`, `SlotsInfo`, `IsFull`.

**2. Registrant names** — the detail page mints a short-lived signed
`requestData` token, which unlocks the fragment containing the name tables:

```
GET https://app.courtreserve.com/Online/Events/Details/17397/{Number}   -> extract token
GET https://events.courtreserve.com/Online/EventsApi/ApiDetails?...&requestData={token}
```

The token is **not reusable**, so every roster read costs two requests. Names
come from two tables that are shaped *differently*:

```html
<!-- registrants --> <th scope="row" data-testid="name">Ada Lovelace</th>
<!-- waitlist    --> <th scope="col">1</th><th scope="row">Long Nguyen</th>
```

`nameFromRow()` in `src/courtreserve.js` handles both. Note that the calendar's
`WaitListCount` field is **not reliable** — it reported `0` for a session that
had one waitlisted player. The waitlist table is the source of truth.

### Flow per poll

```
read calendar (1-2 POSTs)
  -> filter: Mon/Wed/Fri + EventType == "Open Play" + local start hour >= 19
  -> for each session due for a scrape:
       fetch detail page -> extract token -> fetch ApiDetails -> parse names
       diff against stored roster -> emit change records
  -> append to data/history.jsonl, update data/state.json
  -> toast for notifiable changes
  -> rebuild docs/index.html
  -> commit + push it, only if the data actually changed  ->  GitHub Pages
```

### Request budgeting

A naive poll of every session costs ~32 requests. Two mechanisms keep that down:

- **Adaptive scraping** (`dueForScrape` in `src/index.js`) — sessions starting
  within `intensiveWindowHours` (24h) are scraped every poll; sessions further
  out only every `sparseIntervalMinutes` (180). Registrations cluster in the
  final day, so this loses little timeliness. A typical poll is now **2 requests**.
- **`monthsToFetch`** only asks for calendar months the look-ahead window
  actually reaches, instead of always fetching two.

Please do not lower `intervalMinutes` below 15. This is a small club's SaaS
tenancy, not an API you are entitled to hammer, and an IP block would break
the watcher entirely.

---

## Change types

| Type           | Meaning                                     | Toast by default |
| -------------- | ------------------------------------------- | :--------------: |
| `joined`       | new name on the roster                      |        yes       |
| `left`         | name gone from the roster                   |        yes       |
| `promoted`     | moved from waitlist onto the roster         |        yes       |
| `demoted`      | moved from roster onto the waitlist         |        yes       |
| `filled`       | session became full                         |        yes       |
| `opened`       | session has room again                      |        yes       |
| `waitlisted`   | new name on the waitlist                    |        no        |
| `leftWaitlist` | name gone from the waitlist                 |        no        |
| `capacity`     | the club changed `MaxMembersOnEvent`        |        no        |
| `baseline`     | first sighting of this occurrence           |        no        |

To toast waitlist movement too, edit `notify.toastTypes` in `config.json`.

Names are matched **case-insensitively** (`cuong le` == `Cuong Le`, because the
portal preserves whatever each member typed) but displayed using the newest
spelling.

---

## Configuration

All of it lives in `config.json`.

```jsonc
{
  "org": {
    "id": "17397",                  // CourtReserve organization id
    "name": "East Hartford Racquet Club",
    "timezone": "America/New_York"  // the 7pm rule is evaluated in THIS zone
  },
  "match": {
    "weekdays": ["Mon", "Wed", "Fri"],
    "startAtOrAfterHour": 19,       // 19 == 7:00 PM local
    "eventTypeEquals": "Open Play",
    "requireExactEventType": true   // false -> substring match
  },
  "poll": {
    "intervalMinutes": 15,
    "lookAheadDays": 21,
    "intensiveWindowHours": 24,     // scrape every poll inside this window
    "sparseIntervalMinutes": 180,   // otherwise scrape this often
    "requestDelayMs": 700,          // pause between detail/token calls
    "maxMonths": 3
  },
  "notify": {
    "toast": true,
    "toastBatchLimit": 4,           // max toasts per cycle
    "toastTypes": ["joined","left","promoted","demoted","filled","opened"],
    "quietHours": null              // e.g. {"start":22,"end":7}
  },
  "paths": {
    "stateFile": "data/state.json",
    "historyFile": "data/history.jsonl",
    "dashboardFile": "docs/index.html",  // /docs is what GitHub Pages serves
    "logFile": "data/watcher.log"
  },
  "publish": {
    "enabled": true,                // commit + push the page after each poll
    "remote": "origin",
    "branch": "main",
    "fingerprintFile": "data/.publish-fingerprint"
  }
}
```

`startAtOrAfterHour` is **inclusive**: a 7:00 PM start qualifies, 6:59 PM does
not. This is covered by a test.

---

## Data files

| Path                        | Contents                                                          |
| --------------------------- | ----------------------------------------------------------------- |
| `data/state.json`           | latest roster snapshot per occurrence; pruned 14 days after start  |
| `data/history.jsonl`        | append-only change log, one JSON object per line — never rewritten |
| `data/watcher.log`          | plain-text run log                                                 |
| `data/.publish-fingerprint` | hash of the two files above; gates the Pages push                  |
| `docs/index.html`           | generated dashboard; fully self-contained, opens over `file://`    |

`data/` is gitignored. `docs/index.html` is **committed and published**.

> **Privacy.** All of these files contain real members' names. The raw state and
> history stay local, but the dashboard renders the same names into
> `docs/index.html`, which is pushed to a **public** GitHub Pages site by
> design — see [Publishing](#publishing-to-github-pages). Because git history is
> permanent, retracting a name later means rewriting history and force-pushing,
> not merely deleting the file.

Inspect the log by hand:

```powershell
Get-Content data\history.jsonl -Tail 20
```

---

## Dashboard

`docs/index.html` is regenerated on every poll (and by `npm run dashboard`).

- **Headline** — the next session, its fill level, and how long until it starts
- **Stat tiles** — changes / joins / leaves in the last 24h, sessions ahead
- **Upcoming sessions** — expandable rows with a zero-anchored fill bar, the
  full roster, the waitlist, and a link back to CourtReserve
- **Recent activity** — reverse-chronological change log
- **Recent sessions** — the last 10 that already started

Two layout rules are pinned by tests, because both regressed once already:

- **White theme only.** `color-scheme:light` on `:root` and no
  `prefers-color-scheme` block anywhere, so the page never follows the OS into
  dark mode.
- **Every row renders every column.** The summary grid is
  `170px minmax(0,1fr) 158px 88px 104px` — one flexible track, four fixed — and
  the waitlist and as-of cells always exist, holding an em dash when empty. CSS
  grid places children positionally, so a conditional cell used to slide every
  later cell one track to the left on any session with no waitlist.

The fill bar's `22/24` count sits **beside** the track, not on top of it. Inside
the bar the digits straddled the fill boundary, where dark ink on `#1d4ed8`
measured 2.66:1 — unreadable at any partial fill, and only rescued at 100% by a
white-label special case. Outside it, ink-on-white is 17.85:1 at every level. A
full session still carries an explicit red `FULL` badge, so it is flagged by
text and not by colour alone. Status marks likewise pair colour with a glyph and
a word (`▲ joined`, `▼ left`, `◗ waitlisted`) so the page is readable without
colour vision.

---

## Publishing to GitHub Pages

The dashboard is one self-contained HTML file — no server, no build step, no
external assets — so Pages serves it as-is.

**One-time setup**

1. Create an **empty** repo `courtreserve-watcher` under your account: no
   README, no `.gitignore`, no licence. The local repo already has history.
2. Point the local repo at it and push:

   ```bat
   git remote add origin https://github.com/btran12/courtreserve-watcher.git
   git push -u origin main
   ```

3. In the repo's **Settings → Pages**, set *Source* to `Deploy from a branch`,
   *Branch* to `main`, *Folder* to `/docs`.
4. Push the current page: `npm run pages`.

The site lands at `https://btran12.github.io/courtreserve-watcher/`. Pages
rebuilds on each push, usually within a minute.

**How the automatic push works**

`src/publish.js` runs at the end of every poll, gated by `publish.enabled` in
`config.json`. It needs no Task Scheduler change — the already-registered
`CourtReserveWatcher` task picks it up on its next run.

- **Gated on data, not on HTML.** The page embeds relative timestamps
  (`as of 12 min ago`), so it differs on every rebuild even when nobody joined
  or left. Publishing compares a SHA-256 of `data/state.json` +
  `data/history.jsonl` against `data/.publish-fingerprint` and skips when they
  match. Idle polls commit nothing; real movement yields a handful of commits a
  day instead of ~96 commits and ~96 Pages rebuilds.
- **Commit messages describe the change** — `Wed, Oct 21, 7:15 PM: Toni Strong
  joined the waitlist` for one, `4 open play change(s)` with a per-change body
  for several. First sightings read `Start tracking N open play session(s)`, so
  baselines are never mistaken for member activity.
- **The fingerprint is written only after a successful push**, so a failure
  (offline, rejected, auth) leaves the gap intact and the next poll retries it.
  Publish errors are logged and never fatal — a failed push must not break
  scraping.
- **Only `docs/index.html` is staged.** `data/` stays gitignored.
- **Credentials** come from Git Credential Manager over HTTPS. The task runs
  `LogonType=Interactive` as you, so cached credentials work without prompting.

`npm run pages` forces a rebuild and push at any time, ignoring the fingerprint.
Set `publish.enabled: false` to stop automatic publishing.

---

## Limitations

- **Unofficial endpoints.** These are private internals of the CourtReserve
  member portal, not the documented API (which needs a Scale/Enterprise club
  plan and Basic Auth credentials). They can change without notice. If a poll
  starts failing, `npm run poll` will print which step broke.
- **Polling has a blind spot.** A member who joins *and* leaves between two
  polls is never observed. Shorter intervals shrink the gap at the cost of more
  requests against someone else's server.
- **Visibility depends on club settings.** Names appear because EHRC has public
  registrant display enabled. If they turn it off you fall back to counts only —
  the roster lists will simply come back empty.
- **Runs only while you are signed in.** The task uses `LogonType=Interactive`
  so toasts can render. Nothing is collected while you are logged out.
- **Cloudflare.** The portal sits behind Cloudflare. Plain `fetch` with a normal
  browser User-Agent currently passes; a tightened challenge would need a real
  browser, which is out of scope here.

---

## Layout

```
src/
  courtreserve.js  portal client: cookie jar, calendar POST, token+roster scrape
  calendar.js      /Date(ms)/ parsing, timezone-correct local parts, match rule
  diff.js          roster comparison -> change records
  store.js         state.json + history.jsonl + run log
  notify.js        Windows toasts, quiet hours, batching
  dashboard.js     static HTML renderer
  publish.js       fingerprint-gated commit + push to GitHub Pages
  index.js         poll cycle
scripts/
  register-task.ps1  Task Scheduler registration / removal
  toast.ps1          balloon notification helper
docs/
  index.html         the published dashboard (generated, committed)
test/                74 tests over the pure logic (no network)
```

Tests cover the parts that are easy to get subtly wrong: timezone arithmetic,
the inclusive 7 PM boundary, case-insensitive name matching, waitlist-vs-roster
movement not double-counting as a join plus a leave, the two different name-cell
markup shapes, the dashboard's fixed column grid and light-only theme, the
fill-bar label contrast, and the publish fingerprint gate (including that a
failed push is retried rather than forgotten).

```bat
npm test
```

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| `no ApiDetails token in detail page` | portal markup changed, or the club disabled public event details |
| `ReadCalendarEvents returned no Data array` | request shape changed, or Cloudflare blocked the call |
| every roster fetch fails | check `data/watcher.log`; likely rate-limited or blocked — widen `requestDelayMs` |
| rosters come back empty but counts are right | club turned off public registrant display |
| no toast appears | Windows Focus Assist is on, or notifications are disabled for the app |
| task never runs | `Get-ScheduledTaskInfo -TaskName CourtReserveWatcher` and check `LastTaskResult` |
| `publish skipped: no git remote 'origin' configured` | the GitHub repo does not exist yet, or `git remote add origin …` was never run |
| `ERROR publish: …` in `data/watcher.log` | push failed (auth, rejected, offline). The fingerprint stays unwritten, so the next poll retries on its own |
| page pushed but the live site is stale | Pages source is not `main` / `/docs`, or the rebuild is still running — check the repo's Actions tab |
| a commit every 15 min with no member changes | `data/.publish-fingerprint` is missing or unwritable, so the gate cannot see the previous run |

To debug a failing run with a stack trace:

```bat
set WATCHER_DEBUG=1 && npm run poll
```
