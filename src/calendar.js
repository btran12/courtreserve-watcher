'use strict';

/** CourtReserve serializes dates as `/Date(1790866800000)/`. */
function parseAspNetDate(value) {
  if (value instanceof Date) return value;
  const m = String(value).match(/-?\d+/);
  if (!m) return null;
  const d = new Date(Number(m[0]));
  return Number.isNaN(d.getTime()) ? null : d;
}

const WEEKDAY_KEYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Localized date parts for a timestamp in the club's timezone. The portal's
 * 7pm cutoff is a *local* wall-clock rule, so everything is derived in
 * `timezone` rather than the machine's zone.
 */
function localParts(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(date)) p[type] = value;
  const hour = Number(p.hour) % 24; // Intl can yield "24" at midnight
  return {
    weekday: p.weekday,
    weekdayIndex: WEEKDAY_KEYS[p.weekday],
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour,
    minute: Number(p.minute),
    dateKey: `${p.year}-${p.month}-${p.day}`,
    timeLabel: formatTime(hour, Number(p.minute)),
    dayLabel: `${p.weekday}, ${monthName(Number(p.month))} ${Number(p.day)}`,
  };
}

function formatTime(hour, minute) {
  const suffix = hour < 12 ? 'AM' : 'PM';
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (m) => MONTHS[m - 1];

/**
 * Reduces a raw scheduler row to the fields the watcher persists.
 * `Number` is the stable per-occurrence key used in the detail-page URL.
 */
function normalizeRow(row, timezone) {
  const start = parseAspNetDate(row.Start);
  const end = parseAspNetDate(row.End);
  if (!start) return null;
  const lp = localParts(start, timezone);
  const ep = end ? localParts(end, timezone) : null;

  return {
    number: row.Number,
    eventId: row.EventId,
    reservationId: row.ReservationId ?? null,
    name: (row.EventName || '').trim(),
    eventType: (row.EventType || '').trim(),
    startIso: start.toISOString(),
    endIso: end ? end.toISOString() : null,
    startUtcMs: start.getTime(),
    weekday: lp.weekday,
    dateKey: lp.dateKey,
    dayLabel: lp.dayLabel,
    timeLabel: lp.timeLabel,
    startLabel: `${lp.dayLabel}, ${lp.timeLabel}`,
    endLabel: ep ? ep.timeLabel : null,
    hour: lp.hour,
    max: row.MaxMembersOnEvent ?? null,
    signed: row.SignedMembers ?? null,
    waitlistCount: row.WaitListCount ?? 0,
    slotsInfo: row.SlotsInfo ?? null,
    isFull: Boolean(row.IsFull),
    inPast: Boolean(row.InPast),
    registrationOpen: Boolean(row.RegistrationOpen),
  };
}

/**
 * Applies the user's watch rule: Mon/Wed/Fri Open Play sessions whose start
 * time is at or after the configured local hour.
 */
function selectEvents(rows, { timezone, match, now = new Date() }) {
  const days = new Set(match.weekdays);
  const out = [];
  const seen = new Set();

  for (const row of rows) {
    const ev = normalizeRow(row, timezone);
    if (!ev || seen.has(ev.number)) continue;

    if (!days.has(ev.weekday)) continue;
    if (ev.hour < match.startAtOrAfterHour) continue;

    if (match.eventTypeEquals) {
      const actual = ev.eventType.toLowerCase();
      const wanted = match.eventTypeEquals.toLowerCase();
      const ok = match.requireExactEventType ? actual === wanted : actual.includes(wanted);
      if (!ok) continue;
    }

    // The portal's InPast flag lags slightly; trust the clock as well.
    ev.inPast = ev.inPast || ev.startUtcMs < now.getTime();
    seen.add(ev.number);
    out.push(ev);
  }

  return out.sort((a, b) => a.startUtcMs - b.startUtcMs);
}

/**
 * Month buckets to query, covering today through `lookAheadDays`.
 *
 * Deliberately returns only the buckets the window actually touches: a 7-day
 * look-ahead late in a month needs one calendar call, not two. Each bucket is
 * a separate POST to the portal, so this is the cheap half of request budgeting.
 */
function monthsToFetch(now, timezone, lookAheadDays, maxMonths = 3) {
  const base = localParts(now, timezone);
  const end = localParts(new Date(now.getTime() + lookAheadDays * 86400000), timezone);
  const buckets = [];
  let y = base.year;
  let m = base.month;
  while (buckets.length < maxMonths) {
    buckets.push({ year: y, month: m });
    if (y === end.year && m === end.month) break;
    if (++m > 12) { m = 1; y++; }
  }
  return buckets;
}

module.exports = {
  parseAspNetDate,
  localParts,
  normalizeRow,
  selectEvents,
  monthsToFetch,
  formatTime,
  WEEKDAY_KEYS,
};
