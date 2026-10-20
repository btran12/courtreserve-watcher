'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffEvent, isNotifiable, DEFAULT_TOAST_TYPES } = require('../src/diff');

const ev = (over = {}) => ({
  number: 'X1', name: 'Open Play', startLabel: 'Wed, Oct 21, 7:15 PM',
  startIso: '2026-10-21T23:15:00.000Z', startUtcMs: Date.parse('2026-10-21T23:15:00.000Z'),
  max: 12, registrants: [], waitlist: [], scrapedAt: '2026-10-20T18:00:00.000Z',
  isFull: false, ...over,
});

test('first sighting records a baseline and nothing else', () => {
  const changes = diffEvent(null, ev({ registrants: ['Bao Tran'], max: 12 }));
  assert.equal(changes.length, 1);
  assert.equal(changes[0].type, 'baseline');
  assert.equal(isNotifiable(changes[0]), false, 'baseline must not fire a toast');
});

test('a new name is a join', () => {
  const prev = ev({ registrants: ['Bao Tran'] });
  const next = ev({ registrants: ['Bao Tran', 'Huy Dang'], scrapedAt: '2026-10-20T19:00:00.000Z' });
  const changes = diffEvent(prev, next);
  assert.deepEqual(changes.map((c) => c.type), ['joined']);
  assert.equal(changes[0].name, 'Huy Dang');
  assert.match(changes[0].summary, /Huy Dang joined/);
});

test('a removed name is a leave', () => {
  const prev = ev({ registrants: ['Bao Tran', 'Huy Dang'] });
  const next = ev({ registrants: ['Bao Tran'] });
  const changes = diffEvent(prev, next);
  assert.deepEqual(changes.map((c) => [c.type, c.name]), [['left', 'Huy Dang']]);
});

test('name matching ignores the capitalization the portal typed', () => {
  const prev = ev({ registrants: ['cuong le'] });
  const next = ev({ registrants: ['Cuong Le'] });
  assert.deepEqual(diffEvent(prev, next), [], 'same person, different case, is not a change');
});

test('display spelling comes from the newer scrape', () => {
  const prev = ev({ registrants: ['cuong le'] });
  const next = ev({ registrants: ['cuong le', 'Vi Nguyen'] });
  const changes = diffEvent(prev, next);
  assert.equal(changes[0].name, 'Vi Nguyen');
});

test('moving between roster and waitlist is not reported as a join plus a leave', () => {
  const prev = ev({ registrants: ['Bao Tran'], waitlist: [] });
  const next = ev({ registrants: [], waitlist: ['Bao Tran'] });
  const changes = diffEvent(prev, next);
  assert.deepEqual(changes.map((c) => c.type), ['demoted']);
});

test('promoting off the waitlist is its own type', () => {
  const prev = ev({ registrants: [], waitlist: ['Bao Tran'] });
  const next = ev({ registrants: ['Bao Tran'], waitlist: [] });
  const changes = diffEvent(prev, next);
  assert.deepEqual(changes.map((c) => c.type), ['promoted']);
  assert.equal(isNotifiable(changes[0]), true);
});

test('waitlist additions are tracked separately from the roster', () => {
  const prev = ev({ registrants: ['A'], waitlist: [] });
  const next = ev({ registrants: ['A'], waitlist: ['B'] });
  assert.deepEqual(diffEvent(prev, next).map((c) => c.type), ['waitlisted']);
});

test('filling to capacity reports a state change once', () => {
  const prev = ev({ registrants: ['A'], max: 2, isFull: false });
  const next = ev({ registrants: ['A', 'B'], max: 2, isFull: true });
  const types = diffEvent(prev, next).map((c) => c.type);
  assert.ok(types.includes('joined'));
  assert.ok(types.includes('filled'));
  assert.equal(types.filter((t) => t === 'filled').length, 1);
});

test('a capacity edit by the club is recorded', () => {
  const prev = ev({ registrants: ['A'], max: 12 });
  const next = ev({ registrants: ['A'], max: 16 });
  const changes = diffEvent(prev, next);
  assert.deepEqual(changes.map((c) => c.type), ['capacity']);
  assert.equal(changes[0].to, 16);
});

test('an unchanged roster produces no changes', () => {
  const a = ev({ registrants: ['A', 'B'], waitlist: ['C'] });
  assert.deepEqual(diffEvent(a, ev({ registrants: ['A', 'B'], waitlist: ['C'] })), []);
});

test('a join and a leave in the same poll both surface', () => {
  const prev = ev({ registrants: ['A', 'B'] });
  const next = ev({ registrants: ['B', 'C'] });
  const types = diffEvent(prev, next).map((c) => c.type).sort();
  assert.deepEqual(types, ['joined', 'left']);
});

test('roster movement toasts by default; waitlist movement stays log-only', () => {
  assert.equal(isNotifiable({ type: 'joined' }), true);
  assert.equal(isNotifiable({ type: 'left' }), true);
  assert.equal(isNotifiable({ type: 'filled' }), true);
  assert.equal(isNotifiable({ type: 'waitlisted' }), false);
  assert.equal(isNotifiable({ type: 'baseline' }), false);
});

test('the toast trigger set can be widened without touching code', () => {
  assert.equal(isNotifiable({ type: 'waitlisted' }, [...DEFAULT_TOAST_TYPES, 'waitlisted']), true);
  assert.equal(isNotifiable({ type: 'joined' }, ['left']), false, 'can also be narrowed');
});
