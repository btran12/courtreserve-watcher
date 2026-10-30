# 🏓 CourtReserve Watcher

Automated 24/7 background scanner for CourtReserve event schedules and registrant lists. 

It tracks evening events (Monday, Wednesday, Friday after 7:00 PM), monitors registrations and waitlists, logs roster changes (joins, leaves, waitlist promotions), and uploads state updates to AWS for real-time viewing.

---

## 🏗️ Architecture

```
┌─────────────────────────┐
│ CourtReserve Web Server │ (Public calendar & details)
└───────────▲─────────────┘
            │ 1. Fetches calendar & participant tables
┌───────────┴─────────────┐
│ GitHub Actions Runner   │ (Runs watcher.js every 15 min)
└───────────┬─────────────┘
            │ 2. Computes diffs & posts updated state.json
┌───────────▼─────────────┐
│ AWS Lambda & S3 Bucket  │ (Backend storage)
└───────────┬─────────────┘
            │ 3. Serves latest data
┌───────────▼─────────────┐
│ Web Viewer UI           │ (Mobile-optimized web frontend)
└─────────────────────────┘
```

---

## 📁 Repository Structure

```
.
├── .github/
│   └── workflows/
│       └── watcher.yml    # GitHub Actions cron schedule (runs every 15 mins)
├── package.json           # Node.js dependencies
├── watcher.js             # Core Node.js scraper & diffing engine
└── README.md              # Project documentation
```

---

## ⚙️ How It Works

1. **Scheduled Runs**: GitHub Actions runs `watcher.js` every 15 minutes using Node.js.
2. **Fetch History**: The script downloads the current `state.json` from the CloudFront distribution to maintain state continuity.
3. **Scan Events**: It scans the upcoming 4 weeks of the CourtReserve calendar for organization `17397`.
4. **Scrape Registrants**: For matching slots (Mon/Wed/Fri starting at or after 7:00 PM), it extracts participant and waitlist tables.
5. **Diff & Log**: It compares current participant lists with historical snapshots to detect:
   - ➕ **Joined** / **Waitlist Joined**
   - ➖ **Left** / **Waitlist Left**
   - ⬆️ **Promoted** (Moved from waitlist to registered)
   - ⬇️ **Demoted** (Moved from registered to waitlist)
6. **Upload**: It uploads the refreshed state and change logs back to the AWS Lambda endpoint using a secure header token.
7. **Open Courts** (AWS Lambda, `aws/index.mjs`): Each run reads the booking scheduler for the next 7 days (`CONFIG.courtDaysAhead`) and stores each court's free time windows in `state.courts`. It uses the same feed the CourtReserve booking page renders (`GET /Online/Reservations/ReadConsolidated/{orgId}` with the `X-Requested-By: ReactApp` header), which returns, per slot, the courts that are still bookable. That feed already excludes public events **and other members' reservations** ("Reserved" blocks) and court closures — unlike the older `/api/scheduler/member-expanded` endpoint, which only returns public events to anonymous callers and therefore over-reported free time. Opening hours, courts and the reservation interval come from the scheduler model (`/Online/Reservations/Bookings/{orgId}?sId=...` requested as JSON). The viewer shows the windows in the Day view (per court) and Week view (combined, with number of free courts).

---

## 🚀 Setup & Installation

### 1. Local Setup
To run the script locally on your machine:

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/courtreserve-watcher.git
cd courtreserve-watcher

# 2. Install dependencies
npm install

# 3. Run the watcher manually
node watcher.js
```

### 2. GitHub Actions Automation
1. Push all files (`watcher.js`, `package.json`, and `.github/workflows/watcher.yml`) to your GitHub repository.
2. Ensure GitHub Actions is enabled under **Settings > Actions > General > Allow all actions**.
3. The workflow will run automatically every 15 minutes. You can also trigger it manually from the **Actions** tab by selecting **CourtReserve Watcher Automated Scan** and clicking **Run workflow**.

---

## ⚙️ Configuration Options

You can adjust tracking filters directly in `watcher.js` inside the `CONFIG` object:

```javascript
const CONFIG = {
  orgId: '17397',                      // CourtReserve Organization ID
  days: [1, 3, 5],                     // Target days: 0=Sun, 1=Mon, ..., 6=Sat
  startAtOrAfterMinutes: 19 * 60,      // Filter events starting at or after 7:00 PM
  weeksAhead: 4,                       // Number of weeks ahead to scan
  maxLogEntries: 3000,                 // Maximum log history retained
  concurrency: 3,                      // Parallel HTTP request limit
  stateUrl: '...',                     // Public CloudFront URL for historical state
  upload: { 
    url: '...',                        // AWS Lambda endpoint URL
    token: '...',                      // Authorization token header
    maxLog: 500 
  }
};
```

---

## 📱 Viewing Results

Access the viewer interface from any desktop or mobile browser at:

---

## 🧰 Tools

### `tools/dupr` — DUPR rating lookup
Local proxy + page for pulling DUPR ratings for a list of names (filtered to CT/MA) using your own
logged-in DUPR session: `npm run dupr` → <http://localhost:8787>. Setup and caveats:
[`tools/dupr/README.md`](tools/dupr/README.md). The session cookie lives in
`tools/dupr/cookie.txt`, which is git-ignored.
`https://d22bq7zsasshul.cloudfront.net/viewer.html`