// ==UserScript==
// @name         CourtReserve Watcher
// @namespace    courtreserve-watcher
// @version      1.0.0
// @description  Tracks registrants/waitlist for evening Mon/Wed/Fri events and logs joins/leaves between visits (localStorage only).
// @match        https://app.courtreserve.com/Online/Calendar/Events/17397*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    orgId: '17397',
    days: [1, 3, 5],          // 0=Sun ... 6=Sat (Mon, Wed, Fri)
    startAtOrAfterMinutes: 19 * 60, // events starting at/after 7:00pm
    weeksAhead: 4,
    maxLogEntries: 3000,
    concurrency: 3,
    storageKey: 'crw:v1',
    // Optional: Lambda Function URL that stores the data in S3 (see aws/README.md). Leave url empty to disable.
    upload: { url: 'https://iadaqxsoltiiozya7osszn545q0bvwre.lambda-url.us-east-1.on.aws/', token: '5f110021d039457da1b6e15d830ccc50a4db18ac0e4c466fa6a83ba4b1f82075', maxLog: 500 },
  };

  // ---------- pure helpers ----------
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

  // Keep only target events and group them into merged slots (same date + start time).
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

  // people: { name: { status: 'reg'|'wait', ev: [eventNames] } }
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

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildSlots, mergePeople, diffSlot, parseMsDate, zonedParts, CONFIG };
    return;
  }

  // ---------- storage ----------
  function loadState() {
    try {
      const s = JSON.parse(localStorage.getItem(CONFIG.storageKey));
      if (s && s.snapshots) return s;
    } catch (e) { /* fall through */ }
    return { snapshots: {}, log: [], lastRun: null, lastAttemptAt: 0, rateLimitUntil: 0, consecutiveFailures: 0, lastSeen: 0, initialized: false };
  }
  const saveState = (s) => localStorage.setItem(CONFIG.storageKey, JSON.stringify(s));

  // ---------- network ----------
  // Retry temporary rate limits/server errors with exponential backoff.
  // CourtReserve requests only; the separate AWS upload is not affected.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function courtReserveFetch(url, options = {}) {
    const maxRetries = 3;
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, options);
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt >= maxRetries) {
        if (response.status === 429) {
          const err = new Error('CourtReserve rate limit (HTTP 429). Back off before the next check.');
          err.status = 429;
          throw err;
        }
        if ([500, 502, 503, 504].includes(response.status)) {
          const err = new Error(`CourtReserve temporary server error (HTTP ${response.status}).`);
          err.status = response.status;
          throw err;
        }
        return response;
      }
      const retryAfter = Number(response.headers.get('Retry-After'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 120000)
        : Math.min(2000 * (2 ** attempt), 30000);
      await sleep(delay);
    }
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
      EventSessionIds: [], ViewType: 'Week', MonthlySelectedDate: '',
      IsLeagueCalendar: 'False', IncludeLeagues: 'True', IncludeRoundRobins: 'False',
    };
    const body = new URLSearchParams({ jsonData: JSON.stringify(criteria), sort: '', group: '', filter: '' });
    const r = await courtReserveFetch(`/Online/Calendar/ReadCalendarEvents/${CONFIG.orgId}`, {
      method: 'POST', credentials: 'same-origin', body,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (!r.ok) throw new Error(`calendar HTTP ${r.status}`);
    const j = await r.json();
    if (!j || !Array.isArray(j.Data)) throw new Error('calendar: unexpected response');
    return j.Data;
  }

  async function readParticipants(number) {
    const page = await courtReserveFetch(`/Online/Events/Details/${CONFIG.orgId}/${encodeURIComponent(number)}`, { credentials: 'same-origin' });
    if (!page.ok) throw new Error(`details HTTP ${page.status}`);
    const m = /fixUrl\('([^']*EventsApi\/ApiDetails[^']*)'\)/.exec(await page.text());
    if (!m) throw new Error('details: ApiDetails url not found');
    const u = new URL(m[1].replace(/&amp;/g, '&'), location.href);
    u.protocol = location.protocol; u.host = location.host;
    u.searchParams.set('modalHtml', '""');
    const r = await courtReserveFetch(u.toString(), { credentials: 'same-origin', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    if (!r.ok) throw new Error(`ApiDetails HTTP ${r.status}`);
    const html = await r.text();
    if (!html.includes('EventDetailsTabStrip')) throw new Error('ApiDetails: unexpected markup');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const names = (sel) => [...doc.querySelectorAll(sel)].map((e) => clean(e.textContent)).filter(Boolean);
    return {
      reg: names('[data-testid="registrants-table-body"] th[scope="row"]'),
      wait: names('[data-testid="waitlisted-table-body"] th[scope="row"]'),
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

  // ---------- main check ----------
  async function runCheck(state) {
    const now = new Date();
    const errors = [];
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStarts = Array.from({ length: CONFIG.weeksAhead }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() + 7 * i); return d;
    });

    let events = [];
    let complete = true;
    for (const ws of weekStarts) {
      try { events = events.concat(await readWeek(ws)); } catch (e) { complete = false; errors.push(e.message); }
    }
    if (!events.length && !complete) throw new Error(errors[0]);

    const slots = buildSlots(events, now);
    const targets = slots.flatMap((s) => s.events.map((e) => ({ slot: s, ev: e })));
    const results = await pool(targets, CONFIG.concurrency, async ({ ev }) => {
      if (!ev.signed && !ev.wait) return { reg: [], wait: [] };
      try { return await readParticipants(ev.number); } catch (e) { errors.push(`${ev.name}: ${e.message}`); return null; }
    });

    // Don't treat a rate-limited partial scan as a successful check.
    const rateLimitError = errors.find((message) => /HTTP 429|rate limit/i.test(message));
    if (rateLimitError) {
      const err = new Error(rateLimitError);
      err.status = 429;
      throw err;
    }

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

    // Drop slots in the past; report vanished upcoming slots only when every week loaded fine.
    const seenKeys = new Set(slots.map((s) => s.key));
    const todayStr = zonedParts(now, 'America/New_York').dateStr;
    const windowEnd = new Date(weekStarts[weekStarts.length - 1]); windowEnd.setDate(windowEnd.getDate() + 7);
    for (const key of Object.keys(snapshots)) {
      if (seenKeys.has(key)) continue;
      const snap = snapshots[key];
      const inWindow = new Date(`${snap.date}T00:00:00`) < windowEnd;
      if (snap.date < todayStr) delete snapshots[key];
      else if (complete && inWindow && !failed.has(key)) {
        newLog.push({ ts, slot: key, label: slotLabel(snap), type: 'removed', name: '', ev: snap.events.join(' / '), note: 'No longer listed (cancelled or already started)' });
        delete snapshots[key];
      }
    }

    state.snapshots = snapshots;
    state.log = newLog.reverse().concat(state.log).slice(0, CONFIG.maxLogEntries);
    state.lastRun = ts;
    state.initialized = true;
    state.lastErrors = errors;
    saveState(state);
    return newLog.filter((l) => l.type !== 'tracking').length;
  }

  function uploadState(state) {
    const { url, token, maxLog } = CONFIG.upload;
    if (!url || typeof GM_xmlhttpRequest !== 'function') return Promise.resolve(null);
    const payload = { updated: state.lastRun, snapshots: state.snapshots, log: state.log.slice(0, maxLog) };
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'POST', url, data: JSON.stringify(payload), timeout: 30000,
        headers: { 'Content-Type': 'application/json', 'X-Watcher-Token': token },
        onload: (r) => resolve(r.status >= 200 && r.status < 300 ? 'ok' : `HTTP ${r.status}`),
        onerror: () => resolve('network error'),
        ontimeout: () => resolve('timeout'),
      });
    });
  }

  // ---------- UI ----------
  const ICON = { joined: '➕', left: '➖', 'waitlist-joined': '⏳', 'waitlist-left': '🚪', promoted: '⬆️', demoted: '⬇️', tracking: '👁️', removed: '🗑️' };
  const TEXT = {
    joined: 'joined', left: 'left', 'waitlist-joined': 'joined the waitlist', 'waitlist-left': 'left the waitlist',
    promoted: 'moved from waitlist to registered', demoted: 'moved from registered to waitlist',
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function mountUI(state) {
    const css = document.createElement('style');
    css.textContent = `
      #crw-btn{position:fixed;right:16px;bottom:16px;z-index:99999;background:#284b73;color:#fff;border:0;border-radius:24px;padding:10px 16px;font:600 14px Inter,sans-serif;cursor:pointer;box-shadow:0 2px 8px #0005}
      #crw-btn .b{background:#e53935;border-radius:10px;padding:1px 7px;margin-left:6px}
      #crw-panel{position:fixed;right:16px;bottom:64px;z-index:99999;width:720px;max-width:calc(100vw - 32px);max-height:75vh;overflow:auto;background:#fff;color:#222;border-radius:10px;box-shadow:0 4px 24px #0006;font:13px Inter,sans-serif;display:none}
      #crw-panel header{position:sticky;top:0;z-index:10;background:#284b73;color:#fff;padding:10px 12px;display:flex;gap:8px;align-items:center;box-shadow:0 2px 4px #0003}
      #crw-panel header b{flex:1}
      #crw-panel section,#crw-panel details{position:relative;z-index:0}
      #crw-panel button.s{background:#fff2;color:#fff;border:1px solid #fff6;border-radius:4px;padding:3px 8px;cursor:pointer}
      #crw-panel section{padding:8px 12px;border-bottom:1px solid #eee}
      #crw-panel h4{margin:6px 0;font-size:13px}
      #crw-panel .row{padding:3px 0}
      #crw-panel .time{color:#777;font-size:11px}
      #crw-panel .j{color:#1b7f3b}#crw-panel .l{color:#c62828}#crw-panel .w{color:#b26a00}
      #crw-panel details{margin:4px 0}#crw-panel summary{cursor:pointer}
      #crw-panel .err{color:#c62828;font-size:12px}
      #crw-panel ol{margin:2px 0 6px;padding-left:22px}
      #crw-panel .cols{display:grid;grid-template-columns:1fr 1fr 1.2fr;gap:12px;margin-top:6px}
      #crw-panel .latest{background:#fff3c4;border-left:4px solid #f5a300;border-radius:4px;padding:4px 6px}
      #crw-panel .tag{display:inline-block;background:#f5a300;color:#fff;border-radius:8px;padding:1px 8px;font-size:11px;margin-top:3px}
      #crw-panel .new{background:#fff8d6}
      #crw-panel,#crw-panel *{box-sizing:border-box}
      #crw-panel{overflow-x:hidden}
      #crw-panel section{padding:8px 16px}
      #crw-panel .row,#crw-panel li,#crw-panel .time,#crw-panel summary{overflow-wrap:anywhere;word-break:break-word}
      #crw-panel .cols>div{min-width:0}
      #crw-panel .row{padding:3px 6px}
    `;
    document.head.appendChild(css);
    const btn = document.createElement('button'); btn.id = 'crw-btn';
    const panel = document.createElement('div'); panel.id = 'crw-panel';
    document.body.append(btn, panel);

    const unseen = () => state.log.filter((l) => l.ts > state.lastSeen && l.type !== 'tracking').length;
    let checking = false;
    const openKeys = new Set();

    function render(status) {
      const n = unseen();
      btn.innerHTML = `🏓 Watcher${n ? `<span class="b">${n}</span>` : ''}`;
      const snaps = Object.values(state.snapshots).sort((a, b) => a.key.localeCompare(b.key));
      const regCount = (s, st) => Object.values(s.people).filter((p) => p.status === st).length;
      const lastChange = {};
      state.log.forEach((l) => { if (l.type !== 'tracking' && !(l.slot in lastChange)) lastChange[l.slot] = l.ts; });
      const latestSlot = Object.keys(lastChange).filter((k) => state.snapshots[k]).sort((a, b) => lastChange[b] - lastChange[a])[0];
      const slotsHtml = snaps.map((s) => {
        const names = (st) => {
          const items = Object.entries(s.people).filter(([, p]) => p.status === st).map(([nm]) => `<li>${esc(nm)}</li>`).sort().join('');
          return items ? `<ol>${items}</ol>` : '<div>—</div>';
        };
        const changes = state.log.filter((l) => l.slot === s.key && l.type !== 'tracking').slice(0, 50).map((l) => {
          const cls = l.type === 'joined' || l.type === 'promoted' ? 'j' : l.type === 'left' || l.type === 'removed' ? 'l' : 'w';
          return `<div class="row"><span class="${cls}">${ICON[l.type] || ''} <b>${esc(l.name)}</b> ${TEXT[l.type] || esc(l.type)}</span>
            <div class="time">${esc(new Date(l.ts).toLocaleString())}</div></div>`;
        }).join('') || '<div class="time">No changes yet</div>';
        const latest = s.key === latestSlot;
        const stamp = lastChange[s.key] ? new Date(lastChange[s.key]).toLocaleString() : '';
        return `<details class="${latest ? 'latest' : ''}" data-key="${esc(s.key)}" ${openKeys.has(s.key) ? 'open' : ''}><summary><b>${esc(slotLabel(s))}</b> — ${regCount(s, 'reg')} registered, ${regCount(s, 'wait')} waitlisted
          ${latest ? `<span class="tag">Most recently updated · ${esc(stamp)}</span>` : ''}
          <div class="time">${esc(s.events.join(' / '))}</div></summary>
          <div class="cols"><div><b>Registered</b>${names('reg')}</div><div><b>Waitlist</b>${names('wait')}</div><div><b>Joined / left</b>${changes}</div></div></details>`;
      }).join('') || '<div class="time">No matching events tracked yet.</div>';
      const logHtml = state.log.slice(0, 300).map((l) => {
        const cls = l.type === 'joined' || l.type === 'promoted' ? 'j' : l.type === 'left' || l.type === 'removed' ? 'l' : 'w';
        const what = l.name ? `<b>${esc(l.name)}</b> ${TEXT[l.type]}` : esc(l.note || '');
        return `<div class="row ${l.ts > state.lastSeen && l.type !== 'tracking' ? 'new' : ''}">${ICON[l.type] || ''} <span class="${cls}">${what}</span>
          <div class="time">${esc(l.label)} · ${esc(l.ev)} · ${new Date(l.ts).toLocaleString()}</div></div>`;
      }).join('') || '<div class="time">No changes recorded yet.</div>';
      const errs = (state.lastErrors || []).length ? `<div class="err">${state.lastErrors.map(esc).join('<br>')}</div>` : '';
      panel.innerHTML = `<header><b>Mon/Wed/Fri after 7pm</b>
      <a href="https://d22bq7zsasshul.cloudfront.net/viewer.html" target="_blank"
   style="display: inline-block; padding: 10px 20px; background-color: #007BFF; color: white; text-decoration: none; border-radius: 5px; font-family: sans-serif;">
   Viewer
</a>

          <button class="s" data-a="refresh">Refresh</button><button class="s" data-a="export">Export</button>
          <button class="s" data-a="clear">Clear log</button></header>
        <section><div class="time">${esc(status || (state.lastRun ? 'Last checked ' + new Date(state.lastRun).toLocaleString() : 'Not checked yet'))}${state.lastUpload ? ' · ' + esc(state.lastUpload) : ''}</div>${errs}</section>
        <section><h4>Tracked events</h4>${slotsHtml}</section>
        <section><h4>Change log</h4>${logHtml}</section>`;
    }

    const markSeen = () => { state.lastSeen = Date.now(); saveState(state); };
    btn.onclick = () => {
      const open = panel.style.display === 'block';
      panel.style.display = open ? 'none' : 'block';
      if (!open) { render(); setTimeout(() => { markSeen(); btn.innerHTML = '🏓 Watcher'; }, 0); }
    };

    // Global minimum gap applies to automatic checks, initial load, and manual refresh.
    const MIN_GAP_MS = 5 * 60 * 1000;

    async function check() {
      if (checking) return;
      Object.assign(state, loadState());
      const now = Date.now();
      const blockedUntil = Math.max((state.lastAttemptAt || 0) + MIN_GAP_MS, state.rateLimitUntil || 0);
      if (now < blockedUntil) {
        const seconds = Math.ceil((blockedUntil - now) / 1000);
        render(`Throttled — next check in about ${Math.ceil(seconds / 60)} min`);
        return;
      }

      checking = true;
      state.lastAttemptAt = now;
      saveState(state);
      render('Checking…');
      try {
        const changed = await runCheck(state);
        state.consecutiveFailures = 0;
        state.rateLimitUntil = 0;
        const up = await uploadState(state);
        if (up) { state.lastUpload = `${up === 'ok' ? 'Uploaded' : 'Upload failed (' + up + ')'} ${new Date().toLocaleTimeString()}`; saveState(state); }
        if (changed && panel.style.display !== 'block') btn.click();
        else render();
      } catch (e) {
        state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
        const isRateLimit = e.status === 429 || /HTTP 429|rate limit/i.test(e.message || '');
        const backoffMs = isRateLimit
          ? Math.min(15 * 60 * 1000, 5 * 60 * 1000 * (2 ** Math.min(state.consecutiveFailures - 1, 2)))
          : Math.min(10 * 60 * 1000, 60 * 1000 * (2 ** Math.min(state.consecutiveFailures - 1, 3)));
        state.rateLimitUntil = Date.now() + backoffMs;
        state.lastErrors = [e.message, `Automatic retry blocked for about ${Math.ceil(backoffMs / 60000)} minute(s).`];
        saveState(state);
        render(isRateLimit ? 'Rate limited — backing off' : 'Check failed — backing off');
      } finally { checking = false; }
    }

    // Re-check when returning to the page; check() enforces the shared throttle.
    const autoRefresh = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', autoRefresh);
    window.addEventListener('focus', autoRefresh);
    window.addEventListener('pageshow', autoRefresh);

    panel.addEventListener('toggle', (e) => {
      const k = e.target.dataset && e.target.dataset.key;
      if (!k) return;
      if (e.target.open) openKeys.add(k); else openKeys.delete(k);
    }, true);

    panel.addEventListener('click', (e) => {
      const a = e.target.dataset && e.target.dataset.a;
      if (a === 'refresh') check();
      else if (a === 'clear') { if (confirm('Clear the change log?')) { state.log = []; saveState(state); render(); } }
      else if (a === 'export') {
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob);
        link.download = 'courtreserve-watcher.json'; link.click();
      }
    });

    render();
    check();
  }

  mountUI(loadState());
})();
