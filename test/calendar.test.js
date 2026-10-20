'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAspNetDate, localParts, selectEvents, normalizeRow } = require('../src/calendar');

const TZ = 'America/New_York';
const MATCH = {
  weekdays: ['Mon', 'Wed', 'Fri'],
  startAtOrAfterHour: 19,
  eventTypeEquals: 'Open Play',
  requireExactEventType: true,
};
const NOW = new Date('2026-10-20T18:00:00Z'); // Tue Oct 20, 2026 2:00 PM ET

const row = (startIso, over = {}) => ({
  Title: 't', Number: 'N' + startIso, EventId: 1, ReservationId: 2,
  Start: `/Date(${Date.parse(startIso)})/`,
  End: `/Date(${Date.parse(startIso) + 7200000})/`,
  EventName: 'EHPR: 5-7 - Intermediate II - Open Play',
  EventType: 'Open Play ',
  MaxMembersOnEvent: 24, SignedMembers: 0, WaitListCount: 0,
  SlotsInfo: '24 of 24 spots remaining', IsFull: false, InPast: false,
  RegistrationOpen: true,
  ...over,
});

test('parses the /Date(ms)/ wrapper the portal uses', () => {
  assert.equal(parseAspNetDate('/Date(1790866800000)/').getTime(), 1790866800000);
  assert.equal(parseAspNetDate('/Date(-1000)/').getTime(), -1000);
  assert.equal(parseAspNetDate(null), null);
  assert.equal(parseAspNetDate('garbage'), null);
});

test('wall-clock parts are resolved in the club timezone, not the machine zone', () => {
  // 23:15 UTC on Oct 21 == 7:15 PM EDT
  const p = localParts(new Date('2026-10-21T23:15:00Z'), TZ);
  assert.equal(p.weekday, 'Wed');
  assert.equal(p.hour, 19);
  assert.equal(p.minute, 15);
  assert.equal(p.timeLabel, '7:15 PM');
  assert.equal(p.dayLabel, 'Wed, Oct 21');
});

test('midnight is hour 0, not 24', () => {
  assert.equal(localParts(new Date('2026-10-21T04:00:00Z'), TZ).hour, 0);
});

test('normalizes a raw row into the persisted shape', () => {
  const ev = normalizeRow(row('2026-10-21T23:15:00Z'), TZ);
  assert.equal(ev.startLabel, 'Wed, Oct 21, 7:15 PM');
  assert.equal(ev.timeLabel, '7:15 PM');
  assert.equal(ev.dayLabel, 'Wed, Oct 21');
  assert.equal(ev.eventType, 'Open Play', 'trailing space trimmed');
  assert.equal(ev.max, 24);
  assert.equal(ev.weekday, 'Wed');
});

test('drops a row with no parseable start', () => {
  assert.equal(normalizeRow({ Number: 'x', Start: 'nope' }, TZ), null);
});

test('keeps Mon/Wed/Fri sessions starting at or after 7pm', () => {
  const rows = [
    row('2026-10-19T23:15:00Z'), // Mon 7:15 PM  -> keep
    row('2026-10-21T23:15:00Z'), // Wed 7:15 PM  -> keep
    row('2026-10-23T23:15:00Z'), // Fri 7:15 PM  -> keep
  ];
  const out = selectEvents(rows, { timezone: TZ, match: MATCH, now: NOW });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((e) => e.weekday), ['Mon', 'Wed', 'Fri'], 'sorted chronologically');
});

test('excludes other weekdays', () => {
  const rows = [
    row('2026-10-20T23:15:00Z'), // Tue
    row('2026-10-22T23:15:00Z'), // Thu
    row('2026-10-24T23:15:00Z'), // Sat
    row('2026-10-25T23:15:00Z'), // Sun
  ];
  assert.deepEqual(selectEvents(rows, { timezone: TZ, match: MATCH, now: NOW }), []);
});

test('a 7:00 PM start qualifies; 6:59 PM does not', () => {
  // 23:00Z == 7:00 PM EDT, 22:59Z == 6:59 PM EDT
  const keep = selectEvents([row('2026-10-21T23:00:00Z')], { timezone: TZ, match: MATCH, now: NOW });
  const drop = selectEvents([row('2026-10-21T22:59:00Z')], { timezone: TZ, match: MATCH, now: NOW });
  assert.equal(keep.length, 1);
  assert.equal(keep[0].hour, 19);
  assert.equal(drop.length, 0, '6:59 PM is before the cutoff');
});

test('excludes non-Open-Play event types', () => {
  const rows = [
    row('2026-10-21T23:15:00Z', { EventType: 'MLP League' }),
    row('2026-10-21T23:15:00Z', { EventType: 'Clinics' }),
    row('2026-10-21T23:15:00Z', { EventType: 'Open Play' }),
  ];
  const out = selectEvents(rows, { timezone: TZ, match: MATCH, now: NOW });
  assert.equal(out.length, 1);
});

test('exact type matching rejects "Open Play Social" when required', () => {
  const r = [row('2026-10-21T23:15:00Z', { EventType: 'Open Play Social' })];
  assert.equal(selectEvents(r, { timezone: TZ, match: MATCH, now: NOW }).length, 0);
  const loose = { ...MATCH, requireExactEventType: false };
  assert.equal(selectEvents(r, { timezone: TZ, match: loose, now: NOW }).length, 1);
});

test('duplicate occurrence keys collapse to one', () => {
  const a = row('2026-10-21T23:15:00Z');
  const dup = { ...a };
  assert.equal(selectEvents([a, dup], { timezone: TZ, match: MATCH, now: NOW }).length, 1);
});

test('InPast is recomputed from the clock, not trusted blindly', () => {
  const stale = row('2026-10-19T23:15:00Z', { InPast: false }); // Mon, already gone
  const out = selectEvents([stale], { timezone: TZ, match: MATCH, now: NOW });
  assert.equal(out[0].inPast, true);
});

// monthsToFetch coverage lives in schedule.test.js alongside dueForScrape.
