'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { namesInTbody, nameFromRow, sliceTbody, unescapeHtml } = require('../src/courtreserve');

// Markup shapes copied from a live ApiDetails response, names invented.
// NOTE the two tables are NOT shaped alike: the registrants table tags the name
// cell with data-testid="name", the waitlist table does not and instead prefixes
// an ordinal column marked scope="col".
const FRAGMENT = `
<div>
  <span class="k-link" data-testid="registrants-tab">REGISTRANTS (3)</span>
  <table class="table" data-testid="registrants-table">
    <thead class="thead-light"><tr><th scope="col">Name</th><th scope="col" class="hide">Court</th></tr></thead>
    <tbody data-testid="registrants-table-body">
      <tr>
        <th scope="row" style="min-width: 200px" data-testid="name">
              Ada Lovelace
          </th>
        <td class="hide" data-testid="court-name"></td>
      </tr>
      <tr>
        <th scope="row" style="min-width: 200px" data-testid="name">
              grace&nbsp;hopper
          </th>
        <td class="hide" data-testid="court-name">Court 2</td>
      </tr>
      <tr>
        <th scope="row" style="min-width: 200px" data-testid="name">
              <a href="/member/9">Katherine Johnson</a>
          </th>
      </tr>
    </tbody>
  </table>
  <h4 class="fz20 mb10" data-testid="waitlist-title">Waitlist</h4>
  <table class="table" data-testid="waitlisted-table">
    <thead class="thead-light"><tr><th style="width: 50px" scope="col">#</th><th scope="col">Name</th></tr></thead>
    <tbody data-testid="waitlisted-table-body">
      <tr>
        <th style="width: 50px" scope="col">1</th>
        <th scope="row" style="min-width: 200px">
              Long Nguyen
          </th>
      </tr>
      <tr>
        <th style="width: 50px" scope="col">2</th>
        <th scope="row" style="min-width: 200px">
              Alan Turing
          </th>
      </tr>
    </tbody>
  </table>
</div>`;

test('extracts registrant names and trims the portal whitespace', () => {
  assert.deepEqual(namesInTbody(FRAGMENT, 'registrants-table-body'), [
    'Ada Lovelace',
    'grace hopper',
    'Katherine Johnson',
  ]);
});

test('reads the waitlist even though those rows carry no data-testid="name"', () => {
  assert.deepEqual(namesInTbody(FRAGMENT, 'waitlisted-table-body'), ['Long Nguyen', 'Alan Turing']);
});

test('the waitlist ordinal column is never mistaken for a name', () => {
  const names = namesInTbody(FRAGMENT, 'waitlisted-table-body');
  assert.ok(!names.some((n) => /^\d+$/.test(n)), `got ${JSON.stringify(names)}`);
});

test('falls back to scope="row" when the test hook is absent', () => {
  const row = '<th style="width: 50px" scope="col">7</th><th scope="row">Grace H</th>';
  assert.equal(nameFromRow(row), 'Grace H');
});

test('falls back to the last non-numeric cell when there is no scope="row" either', () => {
  assert.equal(nameFromRow('<td>3</td><td>Someone Else</td>'), 'Someone Else');
  assert.equal(nameFromRow('<td>12</td>'), '');
});

test('a missing table yields an empty list rather than throwing', () => {
  assert.deepEqual(namesInTbody(FRAGMENT, 'nope-table-body'), []);
  assert.equal(sliceTbody(FRAGMENT, 'nope-table-body'), '');
  assert.equal(sliceTbody('no testids here', 'registrants-table-body'), '');
  assert.deepEqual(namesInTbody('<tbody data-testid="x-table-body"></tbody>', 'x-table-body'), []);
});

test('names never leak across tbody boundaries', () => {
  assert.ok(!namesInTbody(FRAGMENT, 'registrants-table-body').includes('Long Nguyen'));
  assert.ok(!namesInTbody(FRAGMENT, 'waitlisted-table-body').includes('Ada Lovelace'));
});

test('entities are unescaped so the token URL is fetchable', () => {
  assert.equal(unescapeHtml('a&amp;b&#39;c&quot;d'), 'a&b\'c"d');
});
