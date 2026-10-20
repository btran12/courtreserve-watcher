'use strict';

const byName = (list) => new Map((list || []).map((n) => [n.toLowerCase(), n]));

/**
 * Compares one event occurrence against its previously stored state and
 * returns the roster movements worth reporting.
 *
 * Names are matched case-insensitively because the portal preserves whatever
 * capitalization each member typed ("cuong le" vs "Cuong Le"), while the
 * original spelling is kept for display.
 *
 * @param {object|null} prev  stored record for this event number, or null
 * @param {object} next        freshly scraped record
 * @returns {Array<object>}    change records
 */
function diffEvent(prev, next) {
  const changes = [];
  const at = next.scrapedAt;

  const prevReg = byName(prev?.registrants);
  const nextReg = byName(next.registrants);
  const prevWait = byName(prev?.waitlist);
  const nextWait = byName(next.waitlist);

  if (!prev) {
    changes.push({
      type: 'baseline',
      at,
      summary: `tracking started with ${next.registrants.length} of ${next.max ?? '?'} registered`,
    });
    return changes;
  }

  for (const [key, name] of nextReg) {
    if (prevReg.has(key)) continue;
    if (prevWait.has(key)) {
      changes.push({ type: 'promoted', name, at, summary: `${name} moved off the waitlist into the event` });
    } else {
      changes.push({ type: 'joined', name, at, summary: `${name} joined` });
    }
  }

  for (const [key, name] of prevReg) {
    if (nextReg.has(key)) continue;
    if (nextWait.has(key)) {
      changes.push({ type: 'demoted', name, at, summary: `${name} dropped onto the waitlist` });
    } else {
      changes.push({ type: 'left', name, at, summary: `${name} left` });
    }
  }

  for (const [key, name] of nextWait) {
    if (prevWait.has(key) || prevReg.has(key)) continue;
    changes.push({ type: 'waitlisted', name, at, summary: `${name} joined the waitlist` });
  }

  for (const [key, name] of prevWait) {
    if (nextWait.has(key) || nextReg.has(key)) continue;
    changes.push({ type: 'leftWaitlist', name, at, summary: `${name} left the waitlist` });
  }

  if (prev.max !== next.max && next.max != null && prev.max != null) {
    changes.push({
      type: 'capacity',
      at,
      from: prev.max,
      to: next.max,
      summary: `capacity changed ${prev.max} -> ${next.max}`,
    });
  }

  if (prev.isFull !== next.isFull) {
    changes.push({
      type: next.isFull ? 'filled' : 'opened',
      at,
      summary: next.isFull
        ? `now FULL at ${next.registrants.length}/${next.max ?? '?'}`
        : `has room again at ${next.registrants.length}/${next.max ?? '?'}`,
    });
  }

  return changes;
}

/** Change types that raise a desktop toast by default. */
const DEFAULT_TOAST_TYPES = ['joined', 'left', 'promoted', 'demoted', 'filled', 'opened'];

/**
 * True when a change should raise a desktop toast rather than only being
 * written to the log and the dashboard.
 *
 * @param {object} change
 * @param {string[]} [types] override, e.g. config.notify.toastTypes
 */
const isNotifiable = (change, types = DEFAULT_TOAST_TYPES) => types.includes(change.type);

module.exports = { diffEvent, isNotifiable, DEFAULT_TOAST_TYPES };
