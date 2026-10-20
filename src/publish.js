'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

/**
 * Commits the rendered dashboard and pushes it, so GitHub Pages republishes.
 *
 * Publishing is gated on a fingerprint of the *data*, not the rendered HTML:
 * the page embeds relative timestamps ("as of 12 min ago"), so it differs on
 * every rebuild even when nobody joined or left. Gating on the HTML would mean
 * a commit and a Pages rebuild every 15 minutes for no new information.
 *
 * The fingerprint is written only after a push succeeds, so a failed push is
 * retried on the next poll instead of being silently forgotten.
 */

const defaultGit = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();

const defaultRead = (f) => fs.readFileSync(f, 'utf8');
const defaultWrite = (f, v) => fs.writeFileSync(f, v, 'utf8');

/** Last meaningful line of a git failure, which is where the reason usually is. */
function explain(err) {
  const text = String(err?.stderr || err?.message || err || '');
  const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
  return lines[lines.length - 1] || 'unknown git failure';
}

/**
 * Stable hash over a set of files. A missing file contributes a sentinel rather
 * than throwing, so the first run before any data exists still fingerprints.
 */
function fingerprint(files, read = defaultRead) {
  const h = crypto.createHash('sha256');
  for (const f of files) {
    h.update(`${f}\0`);
    let body;
    try {
      body = read(f) ?? '';
    } catch {
      body = '\u0000missing';
    }
    h.update(`${body}\0`);
  }
  return h.digest('hex');
}

/**
 * Commit subject plus body describing what actually moved this cycle.
 * `baseline` entries are first sightings, not member activity, so they are
 * summarised separately rather than reported as changes.
 */
function commitMessage(historyEntries = []) {
  const entries = historyEntries ?? [];
  const real = entries.filter((h) => h.type !== 'baseline');
  const baselines = entries.filter((h) => h.type === 'baseline');
  const line = (h) => `- ${h.startLabel}  ${h.eventName}  ${h.summary}`;

  if (!real.length && !baselines.length) {
    return { subject: 'Refresh open play dashboard', body: '' };
  }
  if (!real.length) {
    return {
      subject: `Start tracking ${baselines.length} open play session(s)`,
      body: baselines.map(line).join('\n'),
    };
  }
  if (real.length === 1) {
    // The subject already says who and where; a body would only repeat it.
    return { subject: `${real[0].startLabel}: ${real[0].summary}`.slice(0, 120), body: '' };
  }
  return {
    subject: `${real.length} open play change(s)`,
    body: real.map(line).join('\n'),
  };
}

/**
 * @param {object} p
 * @param {string} p.root            project root
 * @param {object} p.config          parsed config.json
 * @param {Function} p.log           run-log sink
 * @param {Array} [p.historyEntries] changes recorded this cycle
 * @param {boolean} [p.force]        ignore the fingerprint gate and publish anyway
 * @param {boolean} [p.dryRun]       log intent without touching git
 * @param {Function} [p.git]         injectable git runner
 * @param {Function} [p.read]        injectable file reader
 * @param {Function} [p.write]       injectable file writer
 * @returns {{published: boolean, reason?: string, subject?: string}}
 */
function publish({
  root,
  config,
  log = () => {},
  historyEntries = [],
  force = false,
  dryRun = false,
  git = defaultGit,
  read = defaultRead,
  write = defaultWrite,
}) {
  const pub = config.publish ?? {};
  if (!pub.enabled && !force) return { published: false, reason: 'disabled' };

  const remote = pub.remote ?? 'origin';
  const branch = pub.branch ?? 'main';
  const pageRel = config.paths.dashboardFile;
  const stampFile = path.resolve(root, pub.fingerprintFile ?? 'data/.publish-fingerprint');

  let remoteUrl;
  try {
    remoteUrl = git(root, ['remote', 'get-url', remote]);
  } catch {
    log(`publish skipped: no git remote '${remote}' configured`);
    return { published: false, reason: 'no-remote' };
  }

  const watched = [
    path.resolve(root, config.paths.stateFile),
    path.resolve(root, config.paths.historyFile),
  ];
  const next = fingerprint(watched, read);

  let prev = null;
  try {
    prev = read(stampFile).trim();
  } catch {
    prev = null; // first publish
  }

  if (!force && prev === next) return { published: false, reason: 'unchanged' };

  const { subject, body } = commitMessage(historyEntries);
  if (dryRun) {
    log(`[dry-run] would push to ${remoteUrl}: ${subject}`);
    return { published: false, reason: 'dry-run', subject };
  }

  try {
    git(root, ['add', '--', pageRel]);
    const staged = git(root, ['diff', '--cached', '--name-only']);
    if (staged) {
      const args = ['commit', '-m', subject];
      if (body) args.push('-m', body);
      git(root, args);
    }

    // The remote branch does not exist yet on the first publish; that is not fatal.
    try {
      git(root, ['pull', '--rebase', remote, branch]);
    } catch (err) {
      log(`publish: rebase skipped (${explain(err)})`);
    }

    const pushed = git(root, ['push', remote, `HEAD:${branch}`]);
    write(stampFile, `${next}\n`);
    log(`published -> ${remoteUrl} ${branch}${staged ? '' : ' (page unchanged)'}${pushed ? ` ${explain({ stderr: pushed })}` : ''}`);
    return { published: true, subject };
  } catch (err) {
    // No fingerprint write: the next poll sees the same gap and retries.
    log(`ERROR publish: ${explain(err)}`);
    return { published: false, reason: 'error', error: explain(err) };
  }
}

module.exports = { publish, fingerprint, commitMessage, explain };
