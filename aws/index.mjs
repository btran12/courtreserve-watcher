import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const BUCKET_NAME = process.env.BUCKET_NAME; // Set in Lambda environment variables
const STATE_KEY = 'courtreserve-watcher/state.json';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const CONFIG = {
  orgId: '17397',
  days: [1, 2, 3, 4, 5],
  startAtOrAfterMinutes: 19 * 60,
  weeksAhead: 3,
  courtDaysAhead: 7, // only the next week of court availability is needed
  maxLogEntries: 3000,
  concurrency: 3,
  courtSchedulerId: '22028', // sId from /Online/Reservations/Bookings/{orgId}?sId=...
  timeZone: 'America/New_York',
};

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function parseMsDate(v) {
  const m = /\/Date\((-?\d+)\)\//.exec(v || '');
  return m ? new Date(Number(m[1])) : null;
}

function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(date);
  const o = {};
  parts.forEach((p) => { o[p.type] = p.value; });
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday);
  const hour = Number(o.hour) % 24;
  return {
    dow, hour, minute: Number(o.minute),
    minutes: hour * 60 + Number(o.minute),
    dateStr: `${o.year}-${o.month}-${o.day}`,
    timeStr: `${String(hour).padStart(2, '0')}:${o.minute}`,
  };
}

function fmtTime(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  const ap = h >= 12 ? 'pm' : 'am';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${ap}`;
}

function slotLabel(slot) {
  const d = new Date(`${slot.date}T12:00:00`);
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${day} ${fmtTime(slot.time)}`;
}

function buildSlots(events, now) {
  const seen = new Set();
  const slots = new Map();
  let _keysLogged = false;
  for (const ev of events) {
    if (!_keysLogged) { console.log('Event keys:', Object.keys(ev).sort().join(', ')); _keysLogged = true; }
    if (seen.has(ev.ReservationId)) continue;
    seen.add(ev.ReservationId);
    const start = parseMsDate(ev.Start);
    const end = parseMsDate(ev.End);
    if (!start || ev.IsLeague || ev.TournamentId) continue;
    if (end && end < now) continue;
    const p = zonedParts(start, ev.TimeZone || 'America/New_York');
    if (!CONFIG.days.includes(p.dow) || p.minutes < CONFIG.startAtOrAfterMinutes) continue;
    const key = `${p.dateStr} ${p.timeStr}`;
    if (!slots.has(key)) slots.set(key, { key, date: p.dateStr, time: p.timeStr, events: [] });
    slots.get(key).events.push({
      number: ev.Number,
      name: clean(ev.EventName || ev.Title),
      signed: ev.SignedMembers || 0,
      wait: ev.WaitListCount || 0,
      capacity: ev.Capacity || ev.MaxMembers || ev.MaxParticipants || ev.TotalSpots || ev.MaxCapacity || null,
      spotsRemaining: ev.SpotsRemaining || ev.AvailableSpots || ev.OpenSpots || ev.SpotsAvailable || null,
    });
  }
  return [...slots.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function mergePeople(perEvent) {
  const people = {};
  for (const { eventName, reg, wait } of perEvent) {
    const add = (name, status) => {
      const p = people[name] || (people[name] = { status, ev: [] });
      if (status === 'reg') p.status = 'reg';
      if (!p.ev.includes(eventName)) p.ev.push(eventName);
    };
    reg.forEach((n) => add(n, 'reg'));
    wait.forEach((n) => add(n, 'wait'));
  }
  return people;
}

function diffSlot(oldPeople, newPeople) {
  const changes = [];
  const names = new Set([...Object.keys(oldPeople), ...Object.keys(newPeople)]);
  for (const name of [...names].sort()) {
    const o = oldPeople[name];
    const n = newPeople[name];
    const ev = (n || o).ev.join(' / ');
    if (!o && n) changes.push({ type: n.status === 'reg' ? 'joined' : 'waitlist-joined', name, ev });
    else if (o && !n) changes.push({ type: o.status === 'reg' ? 'left' : 'waitlist-left', name, ev });
    else if (o.status === 'wait' && n.status === 'reg') changes.push({ type: 'promoted', name, ev });
    else if (o.status === 'reg' && n.status === 'wait') changes.push({ type: 'demoted', name, ev });
  }
  return changes;
}

async function readWeek(startLocal) {
  const end = new Date(startLocal); end.setDate(end.getDate() + 7);
  const last = new Date(startLocal); last.setDate(last.getDate() + 6);
  const kd = (d) => ({ Year: d.getFullYear(), Month: d.getMonth() + 1, Day: d.getDate() });
  const criteria = {
    startDate: startLocal.toISOString(), end: end.toISOString(),
    Date: startLocal.toUTCString(), orgId: CONFIG.orgId, TimeZone: 'America/New_York',
    KendoStart: kd(startLocal), KendoEnd: kd(last),
    Categories: [], EventTagIds: [], CostTypeId: '', MemberId: '', FamilyId: '', FamilyMemberIds: '',
    EventSessionIds: [], ViewType: 'View', MonthlySelectedDate: '',
    IsLeagueCalendar: 'False', IncludeLeagues: 'True', IncludeRoundRobins: 'False',
  };
  const body = new URLSearchParams({ jsonData: JSON.stringify(criteria), sort: '', group: '', filter: '' });
  const r = await fetch(`https://app.courtreserve.com/Online/Calendar/ReadCalendarEvents/${CONFIG.orgId}`, {
    method: 'POST', body,
    headers: {
      'User-Agent': DEFAULT_UA,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
  });
  if (!r.ok) throw new Error(`calendar HTTP ${r.status}`);
  const j = await r.json();
  return j.Data || [];
}

async function readParticipants(number) {
  // The Events/Details page is now a React SPA shell; call the details API it uses directly.
  const apiUri = new URL('https://app.courtreserve.com/Online/EventsApi/ApiDetails');
  apiUri.searchParams.set('id', CONFIG.orgId);
  apiUri.searchParams.set('number', number);
  apiUri.searchParams.set('ajaxCall', 'true');

  console.log(`${apiUri.toString()}`)
  const r = await fetch(apiUri.toString(), {
    headers: {
      'User-Agent': DEFAULT_UA,
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': `https://app.courtreserve.com/Online/Events/Details/${CONFIG.orgId}?number=${number}`,
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
    }
  });
  if (!r.ok) throw new Error(`ApiDetails HTTP ${r.status}`);
  const detailHtml = await r.text();

  console.log(`[DEBUG] Event ${number}: received ${detailHtml.length} chars from ApiDetails`);
  
  const extractNames = (sectionTestId) => {
    const tableRegex = new RegExp(`data-testid="${sectionTestId}"[\\s\\S]*?<\\/tbody>`, 'i');
    const match = tableRegex.exec(detailHtml);
    if (!match) {
      console.log(`[DEBUG] Table testid "${sectionTestId}" not found in HTML`);
      return [];
    }
    const rowRegex = /<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/gi;
    const names = [];
    let rMatch;
    while ((rMatch = rowRegex.exec(match[0])) !== null) {
      const cleaned = clean(rMatch[1].replace(/<[^>]*>/g, ''));
      if (cleaned) names.push(cleaned);
    }
    return names;
  };

  const reg = extractNames('registrants-table-body');
  const wait = extractNames('waitlisted-table-body');
  console.log(`[DEBUG] Event ${number}: Found ${reg.length} registrants, ${wait.length} waitlisted`);

  // Extract capacity / spots from the detail page HTML
  let capacity = null;
  let spotsRemaining = null;

  // Pattern 0: "FULL" or "Event Full" → no spots remaining
  if (/\bfull\b/i.test(detailHtml)) {
    spotsRemaining = 0;
  }

  // Pattern 1: "X of Y spots remaining" or "X / Y spots" → X=remaining, Y=capacity
  const ofMatch = detailHtml.match(/(\d+)\s*(?:\/|of)\s*(\d+)\s*(?:spots?|spaces?)/i);
  if (ofMatch) {
    spotsRemaining = parseInt(ofMatch[1], 10);
    capacity = parseInt(ofMatch[2], 10);
  }

  // Pattern 2: "X spots remaining" or "X spots left" or "X available"
  if (spotsRemaining == null) {
    const remMatch = detailHtml.match(/(?:spots?|spaces?)\s*(?:remaining|left|available)[^<>]*?(\d+)/i);
    if (remMatch) spotsRemaining = parseInt(remMatch[1], 10);
    else {
      const remMatch2 = detailHtml.match(/(\d+)\s*(?:spots?|spaces?)\s*(?:remaining|left|available)/i);
      if (remMatch2) spotsRemaining = parseInt(remMatch2[1], 10);
    }
  }

  // Pattern 3: "Capacity: Y" or "Y total spots" or "Max: Y"
  if (capacity == null) {
    const capText = detailHtml.match(/(?:capacity|total spots|max members|max participants)[^<>]*?(\d+)/i);
    if (capText) capacity = parseInt(capText[1], 10);
  }

  // Compute whichever is missing
  if (capacity != null && spotsRemaining == null) {
    spotsRemaining = Math.max(0, capacity - reg.length);
  } else if (spotsRemaining != null && capacity == null) {
    capacity = reg.length + spotsRemaining;
  }

  // Fallback: JSON-embedded data
  if (capacity == null) {
    const jsonMatch = detailHtml.match(/"(?:capacity|totalSpots|maxMembers|MaxCapacity)"\s*:\s*(\d+)/i);
    if (jsonMatch) capacity = parseInt(jsonMatch[1], 10);
    if (capacity != null) spotsRemaining = Math.max(0, capacity - reg.length);
  }

  return { reg, wait, capacity, spotsRemaining };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const hhmm = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ── Court availability (per-court free windows) ──────────────────────────────
// The member portal scheduler gets its grid from /Online/Reservations/ReadConsolidated, which
// returns every visible slot of the day with the courts that are still bookable
// (AvailableCourtIds). That is the only publicly reachable source that also reflects OTHER
// MEMBERS' reservations (the grey "Reserved" blocks) and court closures - the older
// /api/scheduler/member-expanded endpoint only ever returns public events for anonymous
// callers, which is why "open courts" used to over-report free time.

const BOOKINGS_URL = () => `https://app.courtreserve.com/Online/Reservations/Bookings/${CONFIG.orgId}?sId=${CONFIG.courtSchedulerId}`;

// X-Requested-By: ReactApp is what makes the Bookings URL answer with the scheduler model JSON
// instead of the legacy Kendo HTML page.
const CLIENT_HEADERS = {
  'User-Agent': DEFAULT_UA,
  'X-Requested-With': 'XMLHttpRequest',
  'X-Requested-By': 'ReactApp',
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
  reactsubmit: 'true',
  uiculture: 'en-US',
};

function msDate(value) {
  const m = /\/Date\((-?\d+)\)\//.exec(String(value || ''));
  return m ? new Date(Number(m[1])) : null;
}

async function readCourtConfig() {
  const url = BOOKINGS_URL();
  // The JSON view is tied to a portal session, so warm up cookies first.
  const shell = await fetch(url, { headers: { 'User-Agent': DEFAULT_UA } });
  const cookie = (shell.headers.getSetCookie ? shell.headers.getSetCookie() : [])
    .map((c) => c.split(';')[0]).join('; ');
  await shell.text();
  const r = await fetch(url, { headers: { ...CLIENT_HEADERS, Pragma: 'no-cache', 'Cache-Control': 'no-cache', Referer: url, ...(cookie ? { Cookie: cookie } : {}) } });
  if (!r.ok) throw new Error(`bookings HTTP ${r.status}`);
  const j = await r.json();
  const model = j && j.Data && j.Data.Model;
  if (!model) throw new Error('bookings: no scheduler model');
  const courts = (model.Courts || [])
    .filter((c) => c.CanBeBookedOnMemberPortal !== false && c.IsDisabled !== true)
    .map((c) => ({ id: String(c.Id), name: clean(c.Label) }));
  const open = msDate(model.StartTime);
  const close = msDate(model.EndTime);
  // StartTime/EndTime in the model are wall-clock values encoded as UTC (5:00 AM => 05:00Z),
  // unlike the per-slot Start/End values, which are real instants.
  const wallClock = (d) => (d ? d.getUTCHours() * 60 + d.getUTCMinutes() : null);
  return {
    url,
    cookie,
    costTypeId: model.CostTypeId,
    minInterval: Number(model.MinInterval) || 30,
    courtIds: courts.map((c) => c.id).join(','),
    openMin: wallClock(open) ?? 0,
    closeMin: wallClock(close) || 24 * 60,
    courts,
  };
}

async function readCourtSlots(cfg, dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const criteria = {
    orgId: Number(CONFIG.orgId), timeZone: CONFIG.timeZone, browserTimeZone: CONFIG.timeZone,
    uiCulture: 'en-US', costTypeId: cfg.costTypeId, customSchedulerId: CONFIG.courtSchedulerId,
    reservationMinInterval: cfg.minInterval, selectedCourtIds: cfg.courtIds,
    selectedInstructorIds: '', memberIds: '', memberFamilyId: null, embedCodeId: null,
    isAdmin: false, hideReservationDetailsOnMemberPortalScheduler: true, openMatchesOnly: false,
    shortDto: true, kendoDate: { year: y, month: m, day: d },
  };
  const url = `https://app.courtreserve.com/Online/Reservations/ReadConsolidated/${CONFIG.orgId}`
    + `?page=1&pageSize=1000&take=1000&skip=0&jsonData=${encodeURIComponent(JSON.stringify(criteria))}`;
  const r = await fetch(url, {
    headers: { ...CLIENT_HEADERS, Referer: cfg.url, ...(cfg.cookie ? { Cookie: cfg.cookie } : {}) },
  });
  if (!r.ok) throw new Error(`consolidated HTTP ${r.status}`);
  const j = await r.json();
  return (j && (j.Data || j.data)) || [];
}

// Free [start, end] windows per court for one day, as 'HH:MM' pairs, derived from the
// per-slot availability the booking page itself renders (events, member reservations, closures).
function freeWindowsFromSlots(cfg, items, dateStr, fromMin) {
  const toMin = (date) => {
    const p = zonedParts(date, CONFIG.timeZone);
    if (p.dateStr < dateStr) return 0;
    if (p.dateStr > dateStr) return 24 * 60;
    return p.minutes;
  };
  const free = {};
  cfg.courts.forEach((c) => { free[c.id] = []; });
  for (const it of items) {
    if (it.IsClosed) continue;
    const ids = (it.AvailableCourtIds || []).map(String);
    const start = msDate(it.Start);
    const end = msDate(it.End);
    if (!ids.length || !start || !end) continue;
    const s = toMin(start);
    const e = toMin(end);
    if (e <= s) continue;
    for (const id of ids) {
      const list = free[id];
      if (!list) continue;
      const last = list[list.length - 1];
      if (last && s - last[1] <= 1) last[1] = Math.max(last[1], e);
      else list.push([s, e]);
    }
  }
  const opening = Math.max(cfg.openMin, fromMin || 0);
  const closing = cfg.closeMin;
  const out = {};
  for (const [id, list] of Object.entries(free)) {
    out[id] = list
      .map(([s, e]) => [Math.max(s, opening), Math.min(e, closing)])
      .filter(([s, e]) => e - s >= cfg.minInterval)
      .map(([s, e]) => [hhmm(s), hhmm(e)]);
  }
  return out;
}

async function readCourts(prev, todayStr, nowMin) {
  let cfg;
  try {
    cfg = await readCourtConfig();
  } catch (e) {
    console.error('Failed to read court scheduler config:', e.message);
    return prev; // keep the last known good availability rather than reporting wrong free time
  }
  const dates = Array.from({ length: CONFIG.courtDaysAhead }, (_, i) => addDays(todayStr, i));
  const results = await pool(dates, CONFIG.concurrency, async (date) => {
    try {
      return freeWindowsFromSlots(cfg, await readCourtSlots(cfg, date), date, date === todayStr ? nowMin : 0);
    } catch (e) {
      console.error(`Failed to read court availability for ${date}:`, e.message);
      return null;
    }
  });
  const prevDays = (prev && prev.days) || {};
  const days = {};
  dates.forEach((date, i) => {
    if (results[i]) days[date] = { free: results[i], updated: Date.now() };
    else if (prevDays[date]) days[date] = prevDays[date];
  });
  return { open: hhmm(cfg.openMin), close: hhmm(cfg.closeMin), minInterval: cfg.minInterval, list: cfg.courts, days };
}

export const handler = async () => {
  let state = { snapshots: {}, log: [], initialized: false };
  
  // 1. Fetch current state directly from S3
  try {
    const s3Object = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: STATE_KEY }));
    const s3Body = await s3Object.Body.transformToString();
    state = JSON.parse(s3Body);
  } catch (e) {
    console.log('No existing state found or failed to read from S3. Starting fresh state.');
  }

  const now = new Date();
  const nyParts = zonedParts(now, 'America/New_York');
  const [nyY, nyM, nyD] = nyParts.dateStr.split('-').map(Number);
  const today = new Date(nyY, nyM - 1, nyD);
  const weekStarts = Array.from({ length: CONFIG.weeksAhead }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() + 7 * i); return d;
  });

  let events = [];
  for (const ws of weekStarts) {
    try { events = events.concat(await readWeek(ws)); } catch (e) { console.error(e.message); }
  }

  const slots = buildSlots(events, now);
  const targets = slots.flatMap((s) => s.events.map((e) => ({ slot: s, ev: e })));
  const results = await pool(targets, CONFIG.concurrency, async ({ ev }) => {
    // if (!ev.signed && !ev.wait) return { reg: [], wait: [] };
    try {
      return await readParticipants(ev.number);
    } catch (e) {
      console.error(`Failed to read participants for event ${ev.number} (${ev.name}):`, e.message);
      return null;
    }
  });

  const ts = Date.now();
  const newLog = [];
  const snapshots = { ...state.snapshots };
  const failed = new Set();
  targets.forEach((t, i) => { if (!results[i]) failed.add(t.slot.key); });

  for (const slot of slots) {
    if (failed.has(slot.key)) continue;
    const perEvent = targets.map((t, i) => ({ t, r: results[i] }))
      .filter(({ t }) => t.slot === slot)
      .map(({ t, r }) => ({ eventName: t.ev.name, reg: r.reg, wait: r.wait, capacity: r.capacity, spotsRemaining: r.spotsRemaining }));
    const people = mergePeople(perEvent);
    const prev = state.snapshots[slot.key];
    
    if (!prev && state.initialized) {
      newLog.push({ ts, slot: slot.key, label: slotLabel(slot), type: 'tracking', name: '', ev: slot.events.map((e) => e.name).join(' / '),
        note: `${Object.values(people).filter((p) => p.status === 'reg').length} registered, ${Object.values(people).filter((p) => p.status === 'wait').length} waitlisted` });
    } else if (prev) {
      diffSlot(prev.people, people).forEach((c) => newLog.push({ ts, slot: slot.key, label: slotLabel(slot), ...c }));
    }
        // Build per-event name map for snapshot
    const perEventMap = {};
    for (const pe of perEvent) {
      perEventMap[pe.eventName] = { reg: pe.reg, wait: pe.wait, capacity: pe.capacity, spotsRemaining: pe.spotsRemaining };
    }
    snapshots[slot.key] = {
      key: slot.key, date: slot.date, time: slot.time,
      events: slot.events.map((e) => ({
        name: e.name,
        number: e.number,
        signed: e.signed,
        waitCount: e.wait,
        capacity: (perEventMap[e.name] || {}).capacity != null ? perEventMap[e.name].capacity : e.capacity,
        spotsRemaining: (perEventMap[e.name] || {}).spotsRemaining != null ? perEventMap[e.name].spotsRemaining : e.spotsRemaining,
        reg: (perEventMap[e.name] || {}).reg || [],
        wait: (perEventMap[e.name] || {}).wait || [],
      })),
      people, updated: ts
    };
  }

  state.snapshots = snapshots;
  try {
    state.courts = await readCourts(state.courts, nyParts.dateStr, nyParts.minutes);
  } catch (e) {
    console.error('Failed to read court availability:', e.message);
  }
  state.log = newLog.reverse().concat(state.log || []).slice(0, CONFIG.maxLogEntries);
  state.lastRun = ts;
  state.updated = ts;
  state.initialized = true;

  // 2. Save updated state directly back into S3
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: STATE_KEY,
    Body: JSON.stringify(state),
    ContentType: 'application/json',
    CacheControl: 'no-cache',
  }));

  console.log('Successfully updated state.json in S3.');
  return { statusCode: 200, body: 'Success' };
};