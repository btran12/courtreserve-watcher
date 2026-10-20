'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { dueForScrape } = require('../src/index');
const { monthsToFetch } = require('../src/calendar');

const NOW = Date.parse('2026-10-20T22:00:00Z');
const HOUR = 3600000;
const BASE = {
  nowMs: NOW,
  intensiveWindowMs: 24 * HOUR,
  sparseIntervalMs: 180 * 60000,
  backfill: false,
};
const startsIn = (ms) => ({ startUtcMs: NOW + ms });
const scrapedAgo = (ms) => ({ scrapedAt: new Date(NOW - ms).toISOString() });

test('an event never seen before is always scraped', () => {
  assert.equal(dueForScrape({ ...BASE, ev: startsIn(20 * 24 * HOUR), stored: null }), true);
});

test('a session starting inside the intensive window is scraped every poll', () => {
  const ev = startsIn(6 * HOUR);
  assert.equal(dueForScrape({ ...BASE, ev, stored: scrapedAgo(60000) }), true);
  assert.equal(dueForScrape({ ...BASE, ev, stored: scrapedAgo(1000) }), true, 'even one second after the last scrape');
});

test('a session starting now is treated as intensive, not skipped', () => {
  assert.equal(dueForScrape({ ...BASE, ev: startsIn(0), stored: scrapedAgo(1000) }), true);
});

test('a far-out session waits for the sparse interval', () => {
  const ev = startsIn(10 * 24 * HOUR);
  assert.equal(dueForScrape({ ...BASE, ev, stored: scrapedAgo(60 * 60000) }), false, '1h ago is too soon');
  assert.equal(dueForScrape({ ...BASE, ev, stored: scrapedAgo(179 * 60000) }), false, '179m is still short of 180m');
  assert.equal(dueForScrape({ ...BASE, ev, stored: scrapedAgo(180 * 60000) }), true, '180m is due');
});

test('a stored record with no usable timestamp is scraped rather than trusted', () => {
  const ev = startsIn(10 * 24 * HOUR);
  assert.equal(dueForScrape({ ...BASE, ev, stored: {} }), true);
  assert.equal(dueForScrape({ ...BASE, ev, stored: { scrapedAt: 'nonsense' } }), true);
});

test('backfill forces every session to be scraped', () => {
  const ev = startsIn(10 * 24 * HOUR);
  assert.equal(dueForScrape({ ...BASE, ev, stored: scrapedAgo(1000), backfill: true }), true);
});

test('the intensive window boundary is exclusive of exactly-24h-out sessions', () => {
  assert.equal(dueForScrape({ ...BASE, ev: startsIn(24 * HOUR - 1), stored: scrapedAgo(1000) }), true);
  assert.equal(dueForScrape({ ...BASE, ev: startsIn(24 * HOUR), stored: scrapedAgo(1000) }), false);
});

test('monthsToFetch only asks for months the look-ahead actually reaches', () => {
  const tz = 'America/New_York';
  assert.deepEqual(monthsToFetch(new Date(NOW), tz, 3), [{ year: 2026, month: 10 }],
    'a 3-day window from Oct 20 stays inside October');
  assert.deepEqual(monthsToFetch(new Date(NOW), tz, 21), [
    { year: 2026, month: 10 }, { year: 2026, month: 11 },
  ]);
  assert.deepEqual(monthsToFetch(new Date('2026-12-15T18:00:00Z'), tz, 21), [
    { year: 2026, month: 12 }, { year: 2027, month: 1 },
  ], 'rolls the year over');
});

test('monthsToFetch is capped so a huge look-ahead cannot explode request volume', () => {
  const m = monthsToFetch(new Date(NOW), 'America/New_York', 400, 3);
  assert.equal(m.length, 3);
  assert.deepEqual(m[0], { year: 2026, month: 10 });
});
