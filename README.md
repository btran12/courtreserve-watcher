# CourtReserve Watcher

Userscript that runs on the CourtReserve calendar page, tracks registrants and waitlist for **Mon/Wed/Fri events starting at/after 7:00pm** (next 4 weeks), merges events sharing the same date + start time, and logs joins/leaves/promotions between visits. State lives in `localStorage`.

## Install
1. Install Tampermonkey (or Violentmonkey) in your browser.
2. Create a new script, paste `courtreserve-watcher.user.js`, save.
3. Open https://app.courtreserve.com/Online/Calendar/Events/17397/Day — a 🏓 **Watcher** button appears bottom-right. The first visit sets the baseline; later visits log diffs and auto-open the panel when something changed.

(No Tampermonkey? Paste the file's contents into the DevTools console on that page; it runs once per paste.)

## Why a userscript
The CourtReserve API sends no CORS headers and sits behind Cloudflare, so a standalone web page can't read it. Running on the site's own origin avoids both issues.

## Tweaks
Edit `CONFIG` at the top of the script: `days` (0=Sun), `startAtOrAfterMinutes`, `weeksAhead`.
Log types: joined, left, waitlist joined/left, promoted (waitlist → registered), demoted. Failed fetches keep the previous snapshot, so errors never show up as fake "leaves".
