'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { publish, fingerprint, commitMessage } = require('../src/publish');

const ROOT = path.resolve('R');

const CONFIG = {
  paths: {
    stateFile: 'data/state.json',
    historyFile: 'data/history.jsonl',
    dashboardFile: 'docs/index.html',
  },
  publish: {
    enabled: true,
    remote: 'origin',
    branch: 'main',
    fingerprintFile: 'data/.publish-fingerprint',
  },
};

const STATE = path.resolve(ROOT, CONFIG.paths.stateFile);
const HIST = path.resolve(ROOT, CONFIG.paths.historyFile);
const STAMP = path.resolve(ROOT, CONFIG.publish.fingerprintFile);

/** In-memory stand-in for the two data files and the fingerprint stamp. */
function memFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: (f) => {
      if (!files.has(f)) throw Object.assign(new Error(`ENOENT ${f}`), { code: 'ENOENT' });
      return files.get(f);
    },
    write: (f, v) => files.set(f, v),
  };
}

/** Records every git invocation; handlers keyed by the git subcommand. */
function fakeGit(handlers = {}) {
  const calls = [];
  const fn = (cwd, args) => {
    calls.push(args.join(' '));
    const h = handlers[args[0]];
    if (h === undefined) return '';
    if (typeof h === 'function') return h(args);
    if (h instanceof Error) throw h;
    return h;
  };
  return { fn, calls };
}

const REMOTE_URL = 'https://github.com/btran12/courtreserve-watcher.git';
const remoteOk = { remote: () => REMOTE_URL };
const dataFs = () => memFs({ [STATE]: '{"v":1}', [HIST]: 'x\n' });
const gitError = (msg, stderr) => Object.assign(new Error(msg), { stderr });

const change = (name, over = {}) => ({
  type: 'joined',
  name,
  startLabel: 'Wed, Oct 21, 7:15 PM',
  eventName: 'EHPR: 4-6 Intermediate I - Open Play',
  summary: `${name} joined`,
  ...over,
});

test('the fingerprint follows data content, so an idle poll republishes nothing', () => {
  const fsx = dataFs();
  const a = fingerprint([STATE, HIST], fsx.read);
  assert.equal(a, fingerprint([STATE, HIST], fsx.read), 'stable for identical content');
  fsx.files.set(HIST, 'x\ny\n');
  assert.notEqual(a, fingerprint([STATE, HIST], fsx.read), 'sensitive to appended history');
  fsx.files.set(STATE, '{"v":2}');
  assert.notEqual(a, fingerprint([STATE, HIST], memFs({ [STATE]: '{"v":2}', [HIST]: 'x\n' }).read));
});

test('a data file that does not exist yet fingerprints instead of throwing', () => {
  const hash = fingerprint([STATE, HIST], memFs({}).read);
  assert.match(hash, /^[0-9a-f]{64}$/);
});

test('first sightings are described as tracking, never as member activity', () => {
  const m = commitMessage([{
    type: 'baseline',
    startLabel: 'Wed, Oct 21, 7:15 PM',
    eventName: 'EHPR: 4-6 Intermediate I - Open Play',
    summary: 'tracking started with 12 of 12 registered',
  }]);
  assert.equal(m.subject, 'Start tracking 1 open play session(s)');
  assert.doesNotMatch(m.subject, /joined|left|waitlist/i);
});

test('a lone change names the session and the person in the subject', () => {
  const m = commitMessage([change('Toni Strong', { type: 'waitlisted', summary: 'Toni Strong joined the waitlist' })]);
  assert.equal(m.subject, 'Wed, Oct 21, 7:15 PM: Toni Strong joined the waitlist');
});

test('several changes collapse to a count in the subject and list every one in the body', () => {
  const m = commitMessage(['a', 'b', 'c', 'd'].map((n) => change(n)));
  assert.equal(m.subject, '4 open play change(s)');
  assert.equal(m.body.split('\n').length, 4);
  assert.match(m.body, /- Wed, Oct 21, 7:15 PM {2}EHPR: 4-6 Intermediate I - Open Play {2}d joined/);
});

test('a cycle with nothing to report still gets a usable subject', () => {
  assert.equal(commitMessage([]).subject, 'Refresh open play dashboard');
  assert.equal(commitMessage().subject, 'Refresh open play dashboard');
});

test('publishing stays off when the config says so', () => {
  const g = fakeGit(remoteOk);
  const config = { ...CONFIG, publish: { ...CONFIG.publish, enabled: false } };
  const r = publish({ root: ROOT, config, log: () => {}, git: g.fn, ...dataFs() });
  assert.equal(r.reason, 'disabled');
  assert.deepEqual(g.calls, [], 'no git invocation at all');
});

test('an absent remote is reported as a skipped publish, not a git failure', () => {
  const logs = [];
  const g = fakeGit({ remote: () => { throw gitError('no remote', "error: No such remote 'origin'"); } });
  const r = publish({ root: ROOT, config: CONFIG, log: (m) => logs.push(m), git: g.fn, ...dataFs() });
  assert.equal(r.reason, 'no-remote');
  assert.equal(r.published, false);
  assert.deepEqual(g.calls, ['remote get-url origin']);
  assert.match(logs.join('\n'), /publish skipped: no git remote 'origin' configured/);
});

test('unchanged data skips the commit and the push', () => {
  const fsx = dataFs();
  fsx.files.set(STAMP, `${fingerprint([STATE, HIST], fsx.read)}\n`);
  const g = fakeGit(remoteOk);
  const r = publish({ root: ROOT, config: CONFIG, log: () => {}, git: g.fn, ...fsx });
  assert.equal(r.reason, 'unchanged');
  assert.deepEqual(g.calls, ['remote get-url origin']);
});

test('changed data stages only the page, commits it, and pushes', () => {
  const fsx = dataFs();
  const g = fakeGit({ ...remoteOk, diff: () => 'docs/index.html' });
  const r = publish({
    root: ROOT,
    config: CONFIG,
    log: () => {},
    git: g.fn,
    historyEntries: [change('Toni Strong')],
    ...fsx,
  });
  assert.equal(r.published, true);
  assert.deepEqual(g.calls, [
    'remote get-url origin',
    'add -- docs/index.html',
    'diff --cached --name-only',
    'commit -m Wed, Oct 21, 7:15 PM: Toni Strong joined',
    'pull --rebase origin main',
    'push origin HEAD:main',
  ]);
  assert.match(fsx.files.get(STAMP).trim(), /^[0-9a-f]{64}$/, 'fingerprint recorded only on success');
});

test('a cycle with no page diff pushes without creating an empty commit', () => {
  const fsx = dataFs();
  const g = fakeGit({ ...remoteOk, diff: () => '' });
  const r = publish({ root: ROOT, config: CONFIG, log: () => {}, git: g.fn, ...fsx });
  assert.equal(r.published, true);
  assert.ok(!g.calls.some((c) => c.startsWith('commit')), 'nothing staged, nothing committed');
  assert.ok(g.calls.some((c) => c.startsWith('push ')), 'an earlier failed push can still be retried');
});

test('a failed push leaves the fingerprint unwritten so the next poll retries', () => {
  const fsx = dataFs();
  const logs = [];
  const g = fakeGit({
    ...remoteOk,
    diff: () => 'docs/index.html',
    push: () => { throw gitError('push failed', 'remote: Permission denied\n'); },
  });
  const r = publish({ root: ROOT, config: CONFIG, log: (m) => logs.push(m), git: g.fn, ...fsx });
  assert.equal(r.published, false);
  assert.equal(r.reason, 'error');
  assert.equal(fsx.files.has(STAMP), false, 'the gap must survive to the next cycle');
  assert.match(logs.join('\n'), /ERROR publish: remote: Permission denied/);
});

test('a remote branch that does not exist yet does not abort the first push', () => {
  const fsx = dataFs();
  const logs = [];
  const g = fakeGit({
    ...remoteOk,
    diff: () => 'docs/index.html',
    pull: () => { throw gitError('pull failed', "fatal: couldn't find remote ref main"); },
  });
  const r = publish({ root: ROOT, config: CONFIG, log: (m) => logs.push(m), git: g.fn, ...fsx });
  assert.equal(r.published, true);
  assert.match(logs.join('\n'), /rebase skipped/);
  assert.ok(g.calls.some((c) => c.startsWith('push ')));
});

test('force republishes even when the data has not moved', () => {
  const fsx = dataFs();
  fsx.files.set(STAMP, `${fingerprint([STATE, HIST], fsx.read)}\n`);
  const g = fakeGit({ ...remoteOk, diff: () => 'docs/index.html' });
  const r = publish({ root: ROOT, config: CONFIG, log: () => {}, git: g.fn, force: true, ...fsx });
  assert.equal(r.published, true);
  assert.ok(g.calls.some((c) => c.startsWith('push ')));
});

test('dry-run announces the intent and mutates nothing', () => {
  const fsx = dataFs();
  const logs = [];
  const g = fakeGit(remoteOk);
  const r = publish({
    root: ROOT, config: CONFIG, log: (m) => logs.push(m), git: g.fn, dryRun: true,
    historyEntries: [change('Toni Strong')], ...fsx,
  });
  assert.equal(r.reason, 'dry-run');
  assert.deepEqual(g.calls, ['remote get-url origin']);
  assert.equal(fsx.files.has(STAMP), false);
  assert.match(logs.join('\n'), /would push to https:\/\/github\.com\/btran12\/courtreserve-watcher\.git/);
});
