'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { timeUntil, relativeTime, timeOf, fillBar, esc, buildDashboard } = require('../src/dashboard');

const NOW = Date.parse('2026-10-20T22:00:00Z');
const iso = (ms) => new Date(NOW + ms).toISOString();

test('a future start reads as a countdown, never as "ago" or "just now"', () => {
  assert.equal(timeUntil(iso(30 * 60000), NOW), 'in 30 min');
  assert.equal(timeUntil(iso(5 * 3600000), NOW), 'in 5 hr');
  assert.equal(timeUntil(iso(3 * 86400000), NOW), 'in 3 days');
  assert.equal(timeUntil(iso(86400000), NOW), 'tomorrow');
  for (const label of ['in 30 min', 'in 5 hr', 'tomorrow', 'in 3 days']) {
    assert.ok(!label.includes('ago'));
  }
});

test('an event starting right now reads as "now"', () => {
  assert.equal(timeUntil(iso(0), NOW), 'now');
  assert.equal(timeUntil(iso(-60000), NOW), 'now');
});

test('past timestamps still use "ago" phrasing', () => {
  assert.equal(relativeTime(iso(-30 * 60000), NOW), '30 min ago');
  assert.equal(relativeTime(iso(-2 * 86400000), NOW), '2 days ago');
  assert.equal(relativeTime(iso(-86400000), NOW), 'yesterday');
  assert.equal(relativeTime(iso(-10000), NOW), 'just now');
  assert.equal(relativeTime('not a date', NOW), '');
});

test('timeOf falls back to the combined label for records saved before timeLabel existed', () => {
  assert.equal(timeOf({ timeLabel: '7:15 PM' }), '7:15 PM');
  assert.equal(timeOf({ startLabel: 'Wed, Oct 21, 7:15 PM' }), '7:15 PM');
  assert.equal(timeOf({}), '');
});

test('the fill bar is anchored at zero and states its denominator', () => {
  const bar = fillBar(22, 24);
  assert.match(bar, /width:91\.7%/, '22/24 fills 91.7% of the track');
  assert.match(bar, /22<span class="denom">\/24<\/span>/, 'denominator is visible, not hidden');
  assert.match(bar, /aria-label="22 of 24 spots taken"/);
  assert.ok(!/FULL/.test(bar), 'not full yet');
});

test('a full session is flagged with text, not color alone', () => {
  const bar = fillBar(12, 12);
  assert.match(bar, /is-full/);
  assert.match(bar, /<b>FULL<\/b>/);
  assert.match(bar, /width:100\.0%/);
});

test('an unknown capacity degrades to a plain count instead of a misleading bar', () => {
  const bar = fillBar(7, null);
  assert.match(bar, /bar-na/);
  assert.match(bar, /7 registered/);
  assert.ok(!/bar-fill/.test(bar));
});

test('fill never exceeds the track when the club overbooks', () => {
  assert.match(fillBar(30, 24), /width:100\.0%/);
});

test('member names are escaped before reaching the page', () => {
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(esc('O"Brien"'), 'O&quot;Brien&quot;');
  assert.equal(esc(null), '');
});

const CONFIG = {
  org: { id: '17397', name: 'East Hartford Racquet Club', timezone: 'America/New_York' },
  match: { weekdays: ['Mon', 'Wed', 'Fri'], startAtOrAfterHour: 19 },
  poll: { intervalMinutes: 15, lookAheadDays: 21 },
  paths: { historyFile: 'data/history.jsonl' },
};

const session = (over = {}) => ({
  number: 'N9USJAB17397466',
  name: 'EHPR: 6-8 Intermediate Bridge II Open Play',
  eventType: 'Open Play',
  startIso: iso(86400000),
  dayLabel: 'Wed, Oct 21',
  timeLabel: '7:15 PM',
  startLabel: 'Wed, Oct 21, 7:15 PM',
  max: 12,
  registrants: ['Bao Tran'],
  waitlist: [],
  scrapedAt: null,
  firstSeenAt: null,
  lastChangeAt: null,
  slotsInfo: '11 of 12 spots remaining',
  detailsUrl: 'https://app.courtreserve.com/Online/Events/Details/17397/N9USJAB17397466',
  ...over,
});

const render = (upcoming, past = []) => buildDashboard({
  config: CONFIG,
  upcoming,
  past,
  history: [],
  generatedAt: new Date(NOW).toISOString(),
  stats: { changes24h: 0, joined24h: 0, left24h: 0, totalLogged: 0 },
});

const count = (html, cls) => (html.match(new RegExp(`class="${cls}"`, 'g')) ?? []).length;

test('every session row renders all five summary columns, waitlist or not', () => {
  const rows = [
    session({ waitlist: ['Long Nguyen'], scrapedAt: iso(-1800000) }),
    session({ waitlist: [], scrapedAt: iso(-1800000) }),
    session({ waitlist: ['Toni Strong', 'Trieu Nguyen', 'Binh Tran'], scrapedAt: null }),
    session({ waitlist: [], scrapedAt: null }),
  ];
  const html = render(rows);
  for (const cls of ['s-when', 's-name', 's-fill', 's-wait', 's-asof']) {
    assert.equal(count(html, cls), rows.length, `${cls} must appear once per row`);
  }
});

test('an empty waitlist holds its column with a dash instead of dropping the cell', () => {
  const html = render([session({ waitlist: [] })]);
  assert.match(html, /class="s-wait">\u2014</, 'no waitlist still occupies the waitlist column');
  assert.match(html, /class="s-asof">\u2014</, 'an unscraped session still occupies the as-of column');
  assert.doesNotMatch(html, /class="s-wait">\s*<\/span>/, 'never an empty cell');
});

test('a waitlist count is reported in the row, not only behind the disclosure', () => {
  const html = render([session({ waitlist: ['Long Nguyen', 'Toni Strong'] })]);
  assert.match(html, /class="s-wait">2 waiting</);
});

test('the summary grid reserves five fixed tracks so columns line up across rows', () => {
  const html = render([session()]);
  const track = /grid-template-columns:([^;}]+)[;}]/.exec(
    /details\.session>summary\{[^}]*\}/.exec(html)[0],
  )[1];
  const widths = track.split(/\s+/).filter(Boolean);
  assert.equal(widths.length, 5, 'one track per summary column');
  assert.equal(widths[1], 'minmax(0,1fr)', 'only the event name is flexible');
  for (const w of [widths[0], ...widths.slice(2)]) {
    assert.match(w, /^\d+px$/, `track ${w} must be fixed, not auto or content-sized`);
  }
});

test('the dashboard is light-only and ignores the OS dark theme', () => {
  const html = render([session()]);
  assert.doesNotMatch(html, /prefers-color-scheme/, 'no dark-theme override to switch off');
  assert.match(html, /color-scheme:light/);
  assert.match(html, /--bg:#ffffff/);
  assert.match(html, /--ink:#0f172a/);
});

test('the count label is never painted on top of the fill', () => {
  for (const [n, cap] of [[0, 12], [1, 12], [11, 12], [12, 12]]) {
    const html = fillBar(n, cap);
    const trackCloses = html.indexOf('</span>', html.indexOf('class="bar-fill"'));
    const label = html.indexOf('class="bar-label"');
    assert.ok(trackCloses !== -1 && label !== -1, `expected both a track and a label: ${html}`);
    assert.ok(label > trackCloses, `label must sit outside the closed track: ${html}`);
  }
});

test('the capacity label keeps ink-on-white contrast at every fill level', () => {
  const html = render([
    session({ registrants: ['a'] }),
    session({ registrants: Array.from({ length: 12 }, (_, i) => `p${i}`) }),
  ]);
  assert.match(html, /\.bar-label\{[^}]*color:var\(--ink\)/, 'label uses the page ink colour');
  assert.doesNotMatch(html, /\.bar\.is-full \.bar-label\{/, 'no fill-dependent label colour to fall back on');
  assert.match(html, /\.bar-label b\{color:var\(--down\)/, 'FULL stays flagged by text');
});


