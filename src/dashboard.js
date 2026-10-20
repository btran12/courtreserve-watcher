'use strict';

const { formatTime } = require('./calendar');

/**
 * Renders a self-contained static dashboard from the stored snapshot and the
 * append-only change log. Everything is inlined so the file works over file://
 * with no server, no network, and no external assets.
 */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const STATUS = {
  joined:       { glyph: '\u25B2', label: 'joined',        cls: 'up' },
  promoted:     { glyph: '\u25B2', label: 'off waitlist',  cls: 'up' },
  opened:       { glyph: '\u25B2', label: 'room opened',   cls: 'up' },
  left:         { glyph: '\u25BC', label: 'left',          cls: 'down' },
  demoted:      { glyph: '\u25BC', label: 'to waitlist',   cls: 'down' },
  filled:       { glyph: '\u25A0', label: 'now full',      cls: 'down' },
  waitlisted:   { glyph: '\u25D7', label: 'waitlisted',    cls: 'wait' },
  leftWaitlist: { glyph: '\u25D7', label: 'off waitlist',  cls: 'wait' },
  capacity:     { glyph: '\u25CB', label: 'capacity',      cls: 'wait' },
  baseline:     { glyph: '\u2022', label: 'tracking on',   cls: 'wait' },
};

function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return '1 min ago';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

/** Countdown phrasing for a future start time. */
function timeUntil(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `in ${h} hr`;
  const d = Math.round(h / 24);
  return d === 1 ? 'tomorrow' : `in ${d} days`;
}

/** Prefers the stored time label; older records only have the combined string. */
const timeOf = (ev) => ev.timeLabel ?? (ev.startLabel ?? '').split(', ').slice(-1)[0] ?? '';

const clockTime = (iso) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

function fillBar(signed, max) {
  const n = Number(signed) || 0;
  const cap = Number(max);
  if (!Number.isFinite(cap) || cap <= 0) {
    return `<div class="bar bar-na"><span class="bar-label">${n} registered</span></div>`;
  }
  const pct = Math.max(0, Math.min(100, (n / cap) * 100));
  const full = n >= cap;
  return `<div class="bar${full ? ' is-full' : ''}" role="img"
      aria-label="${n} of ${cap} spots taken">
      <span class="bar-fill" style="width:${pct.toFixed(1)}%"></span>
      <span class="bar-label">${n}<span class="denom">/${cap}</span>${full ? ' <b>FULL</b>' : ''}</span>
    </div>`;
}

function rosterList(names, emptyText) {
  if (!names?.length) return `<p class="empty">${esc(emptyText)}</p>`;
  return `<ul class="roster">${names.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`;
}

/**
 * @param {object} p
 * @param {object} p.config
 * @param {Array} p.upcoming   tracked sessions with a future start, soonest first
 * @param {Array} p.past       tracked sessions already started, most recent first
 * @param {Array} p.history    change log entries, most recent first
 * @param {string} p.generatedAt
 * @param {object} p.stats
 */
function buildDashboard({ config, upcoming, past, history, generatedAt, stats }) {
  const tzLabel = config.org.timezone.replace('_', ' ');
  const rule =
    `${config.match.weekdays.join('/')} open play starting at or after ` +
    `${formatTime(config.match.startAtOrAfterHour, 0)}`;

  const next = upcoming[0];
  const headline = next
    ? `Next: ${esc(next.dayLabel)} at ${esc(timeOf(next))} &mdash; ${esc(next.name)}`
    : 'No upcoming Mon/Wed/Fri evening open play in range';
  const subline = next
    ? `${next.registrants.length}${next.max != null ? ` of ${next.max}` : ''} registered` +
      `${next.waitlist.length ? ` &middot; ${next.waitlist.length} waiting` : ''}` +
      ` &middot; starts ${esc(timeUntil(next.startIso, Date.parse(generatedAt)))}`
    : `Watching ${rule}`;

  const activityRows = history.slice(0, 120).map((h) => {
    const st = STATUS[h.type] ?? { glyph: '\u2022', label: h.type, cls: 'wait' };
    return `<tr>
        <td class="when"><span title="${esc(h.at)}">${esc(clockTime(h.at))}</span><span class="ago">${esc(relativeTime(h.at, Date.parse(generatedAt)))}</span></td>
        <td class="mark ${st.cls}"><span class="glyph" aria-hidden="true">${st.glyph}</span> ${esc(st.label)}</td>
        <td class="who">${esc(h.name ?? '')}</td>
        <td class="what">${esc(h.summary)}</td>
        <td class="sess">${esc(h.startLabel ?? '')}<span class="sessname">${esc(h.eventName ?? '')}</span></td>
      </tr>`;
  }).join('');

  const sessionCards = (list, { empty, showRoster = true }) =>
    list.length
      ? list.map((ev) => `
      <details class="session"${showRoster ? '' : ''}>
        <summary>
          <span class="s-when">${esc(ev.startLabel)}</span>
          <span class="s-name">${esc(ev.name)}</span>
          <span class="s-fill">${fillBar(ev.registrants.length, ev.max)}</span>
          ${ev.waitlist.length ? `<span class="s-wait">${ev.waitlist.length} waiting</span>` : ''}
          ${ev.scrapedAt ? `<span class="s-asof">as of ${esc(relativeTime(ev.scrapedAt, Date.parse(generatedAt)))}</span>` : ''}
        </summary>
        <div class="s-body">
          <div class="s-col">
            <h4>Registered (${ev.registrants.length})</h4>
            ${rosterList(ev.registrants, 'No one registered yet.')}
          </div>
          <div class="s-col">
            <h4>Waitlist (${ev.waitlist.length})</h4>
            ${rosterList(ev.waitlist, 'Waitlist empty.')}
          </div>
          <div class="s-col s-meta">
            <h4>Session</h4>
            <dl>
              <dt>Type</dt><dd>${esc(ev.eventType)}</dd>
              <dt>Key</dt><dd class="mono">${esc(ev.number)}</dd>
              <dt>First seen</dt><dd>${esc(ev.firstSeenAt ? clockTime(ev.firstSeenAt) : '\u2014')}</dd>
              <dt>Last change</dt><dd>${esc(ev.lastChangeAt ? relativeTime(ev.lastChangeAt, Date.parse(generatedAt)) : '\u2014')}</dd>
              ${ev.slotsInfo ? `<dt>Portal says</dt><dd>${esc(ev.slotsInfo)}</dd>` : ''}
              <dt>Details</dt><dd><a href="${esc(ev.detailsUrl)}" rel="noopener">open in CourtReserve</a></dd>
            </dl>
          </div>
        </div>
      </details>`).join('\n')
      : `<p class="empty">${esc(empty)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(config.org.name)} &mdash; Open Play Watcher</title>
<style>
  :root{
    --bg:#ffffff; --surface:#f8fafc; --line:#e2e8f0; --ink:#0f172a; --muted:#64748b;
    --bar:#1d4ed8; --bar-track:#e2e8f0;
    --up:#166534; --down:#be123c; --wait:#64748b;
  }
  @media (prefers-color-scheme:dark){
    :root{ --bg:#0b1120; --surface:#131c2e; --line:#24304a; --ink:#e6edf7; --muted:#93a3b8;
           --bar:#60a5fa; --bar-track:#24304a; --up:#4ade80; --down:#fb7185; --wait:#93a3b8; }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
       font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;}
  .wrap{max-width:1080px;margin:0 auto;padding:28px 20px 72px}
  header h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}
  header .org{color:var(--muted);font-size:13px;margin:0}
  .lede{margin:20px 0 6px;padding:16px 18px;background:var(--surface);border:1px solid var(--line);border-radius:10px}
  .lede .h{font-size:17px;font-weight:650;margin:0 0 3px}
  .lede .s{color:var(--muted);font-size:13.5px;margin:0}
  .stats{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 0}
  .stat{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:118px}
  .stat b{display:block;font-size:19px;line-height:1.2}
  .stat span{color:var(--muted);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em}
  h2{font-size:15px;margin:34px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line);
     text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}
  .bar{position:relative;height:20px;min-width:96px;background:var(--bar-track);border-radius:4px;overflow:hidden;display:inline-block;vertical-align:middle}
  .bar-fill{position:absolute;inset:0 auto 0 0;background:var(--bar);display:block}
  .bar-label{position:relative;display:block;padding:0 7px;font-size:12px;font-weight:650;line-height:20px;color:var(--ink);mix-blend-mode:normal}
  .bar.is-full .bar-fill{background:var(--down)}
  .bar.is-full .bar-label{color:#fff}
  .bar-na{background:transparent;border:1px dashed var(--line)}
  .denom{color:var(--muted);font-weight:500}
  .bar.is-full .denom{color:#fecdd3}
  details.session{border:1px solid var(--line);border-radius:10px;margin:0 0 8px;background:var(--bg)}
  details.session>summary{list-style:none;cursor:pointer;padding:11px 14px;display:grid;
     grid-template-columns:190px minmax(0,1fr) 150px auto auto;gap:12px;align-items:center}
  details.session>summary::-webkit-details-marker{display:none}
  .s-when{font-weight:650;font-size:13.5px}
  .s-name{color:var(--muted);font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .s-wait,.s-asof{color:var(--muted);font-size:12px;white-space:nowrap}
  .s-body{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;padding:4px 16px 16px;border-top:1px solid var(--line)}
  .s-body h4{margin:12px 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  ul.roster{margin:0;padding:0;list-style:none;columns:2;column-gap:14px}
  ul.roster li{break-inside:avoid;padding:2px 0;font-size:13.5px;border-bottom:1px dotted var(--line)}
  .s-meta dl{margin:0;font-size:13px;display:grid;grid-template-columns:78px 1fr;gap:2px 8px}
  .s-meta dt{color:var(--muted)}
  .s-meta dd{margin:0;overflow-wrap:anywhere}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px}
  table.log{width:100%;border-collapse:collapse;font-size:13.5px}
  table.log th{text-align:left;font-size:11.5px;text-transform:uppercase;letter-spacing:.06em;
     color:var(--muted);padding:6px 10px;border-bottom:1px solid var(--line);font-weight:600}
  table.log td{padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  table.log tr:hover td{background:var(--surface)}
  td.when{white-space:nowrap;color:var(--muted)}
  td.when .ago{display:block;font-size:11.5px}
  td.mark{white-space:nowrap;font-weight:600}
  td.mark .glyph{font-size:11px}
  td.mark.up{color:var(--up)} td.mark.down{color:var(--down)} td.mark.wait{color:var(--wait)}
  td.who{font-weight:600;white-space:nowrap}
  td.sess{text-align:right;color:var(--muted);white-space:nowrap}
  td.sess .sessname{display:block;font-size:11.5px}
  .empty{color:var(--muted);font-size:13.5px;padding:10px 0}
  footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
  footer code{background:var(--surface);padding:1px 5px;border-radius:4px;font-size:11.5px}
  @media (max-width:860px){
    details.session>summary{grid-template-columns:1fr;gap:6px}
    .s-body{grid-template-columns:1fr}
    ul.roster{columns:1}
    td.what{display:none}
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Open Play Watcher</h1>
    <p class="org">${esc(config.org.name)} &middot; org ${esc(config.org.id)} &middot; ${esc(tzLabel)}</p>
  </header>

  <div class="lede">
    <p class="h">${headline}</p>
    <p class="s">${subline}</p>
    <div class="stats">
      <div class="stat"><b>${stats.changes24h}</b><span>changes 24h</span></div>
      <div class="stat"><b>${stats.joined24h}</b><span>joined 24h</span></div>
      <div class="stat"><b>${stats.left24h}</b><span>left 24h</span></div>
      <div class="stat"><b>${upcoming.length}</b><span>sessions ahead</span></div>
      <div class="stat"><b>${stats.totalLogged}</b><span>events logged</span></div>
    </div>
  </div>

  <h2>Upcoming sessions</h2>
  ${sessionCards(upcoming, { empty: 'No upcoming sessions in range.' })}

  <h2>Recent activity</h2>
  ${activityRows ? `<div style="overflow-x:auto"><table class="log">
      <thead><tr><th>When</th><th>Change</th><th>Who</th><th>Detail</th><th>Session</th></tr></thead>
      <tbody>${activityRows}</tbody></table></div>`
    : `<p class="empty">No changes recorded yet. The first poll establishes a baseline; joins and leaves appear here after that.</p>`}

  <h2>Recent sessions</h2>
  ${sessionCards(past.slice(0, 10), { empty: 'Nothing tracked yet.' })}

  <footer>
    <p>Rule: ${esc(rule)}. Polling every ${esc(config.poll.intervalMinutes)} min, looking ${esc(config.poll.lookAheadDays)} days ahead.</p>
    <p>Generated ${esc(clockTime(generatedAt))} (${esc(relativeTime(generatedAt))}).
       Source: the club's public CourtReserve calendar &mdash; counts and registrant names are whatever the portal
       exposed at each poll. A member who joins <em>and</em> leaves between two polls is never seen.</p>
    <p>Regenerate with <code>npm run dashboard</code>. Raw log: <code>${esc(config.paths.historyFile)}</code>.</p>
  </footer>
</div>
</body>
</html>
`;
}

module.exports = { buildDashboard, relativeTime, timeUntil, timeOf, clockTime, fillBar, STATUS, esc };
