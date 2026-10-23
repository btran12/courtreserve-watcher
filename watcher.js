// watcher.js
const fetch = require('node-fetch');

const CONFIG = {
  orgId: '17397',
  days: [1, 3, 5], // Mon, Wed, Fri
  startAtOrAfterMinutes: 19 * 60, // 7:00 PM
  weeksAhead: 4,
  maxLogEntries: 3000,
  concurrency: 3,
  stateUrl: 'https://d22bq7zsasshul.cloudfront.net/courtreserve-watcher/state.json',
  upload: { 
    url: 'https://iadaqxsoltiiozya7osszn545q0bvwre.lambda-url.us-east-1.on.aws/', 
    token: '5f110021d039457da1b6e15d830ccc50a4db18ac0e4c466fa6a83ba4b1f82075',
    maxLog: 500 
  }
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
  for (const ev of events) {
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
    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  if (!r.ok) throw new Error(`calendar HTTP ${r.status}`);
  const j = await r.json();
  return j.Data || [];
}

async function readParticipants(number) {
  const page = await fetch(`https://app.courtreserve.com/Online/Events/Details/${CONFIG.orgId}/${encodeURIComponent(number)}`);
  if (!page.ok) throw new Error(`details HTTP ${page.status}`);
  const htmlText = await page.text();
  const m = /fixUrl\('([^']*EventsApi\/ApiDetails[^']*)'\)/.exec(htmlText);
  if (!m) throw new Error('details: ApiDetails url not found');
  
  const apiUri = new URL(m[1].replace(/&amp;/g, '&'), 'https://app.courtreserve.com');
  apiUri.searchParams.set('modalHtml', '""');
  
  const r = await fetch(apiUri.toString(), { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  if (!r.ok) throw new Error(`ApiDetails HTTP ${r.status}`);
  const detailHtml = await r.text();
  
  const extractNames = (sectionTestId) => {
    const tableRegex = new RegExp(`data-testid="${sectionTestId}"[\\s\\S]*?<tbody[\\s\\S]*?<\/tbody>`, 'i');
    const match = tableRegex.exec(detailHtml);
    if (!match) return [];
    const rowRegex = /<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/gi;
    const names = [];
    let rMatch;
    while ((rMatch = rowRegex.exec(match[0])) !== null) {
      const cleaned = clean(rMatch[1].replace(/<[^>]*>/g, ''));
      if (cleaned) names.push(cleaned);
    }
    return names;
  };

  return {
    reg: extractNames('registrants-table-body'),
    wait: extractNames('waitlisted-table-body'),
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function main() {
  let state = { snapshots: {}, log: [], initialized: false };
  try {
    const res = await fetch(CONFIG.stateUrl);
    if (res.ok) state = await res.json();
  } catch (e) {
    console.log('Starting with fresh state history.');
  }

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
    if (!ev.signed && !ev.wait) return { reg: [], wait: [] };
    try { return await readParticipants(ev.number); } catch (e) { return null; }
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
      .map(({ t, r }) => ({ eventName: t.ev.name, reg: r.reg, wait: r.wait }));
    const people = mergePeople(perEvent);
    const prev = state.snapshots[slot.key];
    
    if (!prev && state.initialized) {
      newLog.push({ ts, slot: slot.key, label: slotLabel(slot), type: 'tracking', name: '', ev: slot.events.map((e) => e.name).join(' / '),
        note: `${Object.values(people).filter((p) => p.status === 'reg').length} registered, ${Object.values(people).filter((p) => p.status === 'wait').length} waitlisted` });
    } else if (prev) {
      diffSlot(prev.people, people).forEach((c) => newLog.push({ ts, slot: slot.key, label: slotLabel(slot), ...c }));
    }
    snapshots[slot.key] = { key: slot.key, date: slot.date, time: slot.time, events: slot.events.map((e) => e.name), people, updated: ts };
  }

  state.snapshots = snapshots;
  state.log = newLog.reverse().concat(state.log || []).slice(0, CONFIG.maxLogEntries);
  state.lastRun = ts;
  state.initialized = true;

  console.log('Uploading updated state to AWS Lambda...');
  const uploadRes = await fetch(CONFIG.upload.url, {
    method: 'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'X-Watcher-Token': CONFIG.upload.token 
    },
    body: JSON.stringify({ 
      updated: state.lastRun, 
      snapshots: state.snapshots, 
      log: state.log.slice(0, CONFIG.upload.maxLog) 
    })
  });

  console.log('Upload completed with status:', uploadRes.status);
}

main().catch(console.error);