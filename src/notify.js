'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const TOAST_SCRIPT = path.join(__dirname, '..', 'scripts', 'toast.ps1');
const POWERSHELL = 'powershell.exe';

/**
 * Fires a Windows desktop toast.
 *
 * Arguments are passed as an argv array (never interpolated into a shell
 * string) because names come from a third-party web page.
 *
 * @returns {Promise<{shown: boolean, reason?: string}>}
 */
function showToast(title, message, kind = 'Info', timeoutMs = 12000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        POWERSHELL,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', TOAST_SCRIPT, title, message, kind, String(timeoutMs)],
        { windowsHide: true }
      );
    } catch (err) {
      return resolve({ shown: false, reason: `spawn failed: ${err.message}` });
    }

    const timer = setTimeout(() => {
      child.kill();
      resolve({ shown: false, reason: 'timeout' });
    }, 20000);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ shown: false, reason: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { shown: true } : { shown: false, reason: `exit ${code}` });
    });
  });
}

const TYPE_LABEL = {
  joined: 'joined',
  left: 'left',
  promoted: 'off waitlist',
  demoted: 'to waitlist',
  waitlisted: 'waitlisted',
  leftWaitlist: 'off waitlist',
  filled: 'FULL',
  opened: 'room opened',
  capacity: 'capacity',
};

function isQuietNow(quietHours, timezone) {
  if (!quietHours) return false;
  const hour = Number(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }).format(new Date())
  ) % 24;
  const { start, end } = quietHours;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Groups the cycle's changes into one toast per event, capped so a busy
 * evening cannot stack dozens of notifications.
 */
async function notifyChanges({ grouped, config, timezone, log, dryRun = false }) {
  if (!config.notify?.toast) return { sent: 0 };
  if (isQuietNow(config.notify?.quietHours, timezone)) {
    log('quiet hours active; skipping toasts');
    return { sent: 0 };
  }

  const limit = config.notify?.toastBatchLimit ?? 4;
  const types = config.notify?.toastTypes;
  let sent = 0;

  for (const group of grouped.slice(0, limit)) {
    const { event, changes } = group;
    const notable = types
      ? changes.filter((c) => types.includes(c.type))
      : changes.filter((c) => c.type !== 'baseline');
    if (!notable.length) continue;

    const title = `${event.dayLabel} ${event.name}`.slice(0, 120);
    const lines = notable.slice(0, 6).map((c) => `- ${c.summary}`);
    if (notable.length > 6) lines.push(`… and ${notable.length - 6} more`);
    lines.push('');
    lines.push(`${event.registrants.length}${event.max != null ? `/${event.max}` : ''} registered`);

    const kind = notable.some((c) => c.type === 'filled') ? 'Warning' : 'Info';
    const body = lines.join('\n').slice(0, 900);

    if (dryRun) {
      log(`[dry-run] toast "${title}":\n${body}`);
      sent++;
      continue;
    }
    const res = await showToast(title, body, kind);
    if (res.shown) sent++;
    else log(`toast failed: ${res.reason}`);
  }

  if (grouped.length > limit) log(`${grouped.length - limit} more changed event(s) not toasted (batch limit)`);
  return { sent };
}

module.exports = { showToast, notifyChanges, isQuietNow, TYPE_LABEL, TOAST_SCRIPT };
