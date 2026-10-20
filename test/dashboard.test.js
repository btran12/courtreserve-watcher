'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { timeUntil, relativeTime, timeOf, fillBar, esc } = require('../src/dashboard');

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
