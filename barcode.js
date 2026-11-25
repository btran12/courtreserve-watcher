/* CourtReserve Watcher — Code 128 barcodes + the check-in barcode page.
 *
 * `Code128.svg(value)` is shared with the participant sheet in app.js, so index.html loads this
 * file before app.js. Everything below the page marker only runs on barcode.html.
 */
(() => {
  // Code 128 symbol patterns: bar/space widths, always starting with a bar. Index 106 is the stop
  // pattern (7 widths, 13 modules); every other symbol is 11 modules wide.
  const CODE128 = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
  ];
  const START_B = 104;
  const STOP = 106;

  const escapeAttr = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Code 128 code set B covers printable ASCII (space..~), which is all a member id ever needs.
  function code128Modules(value) {
    const text = String(value ?? '');
    if (!text || [...text].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126)) return '';
    const codes = [START_B];
    for (const ch of text) codes.push(ch.charCodeAt(0) - 32);
    // Checksum: start value + sum(value * position), positions starting at 1, modulo 103.
    const checksum = codes.reduce((sum, code, i) => sum + code * (i === 0 ? 1 : i), 0) % 103;
    codes.push(checksum, STOP);

    let modules = '';
    codes.forEach((code) => {
      const pattern = CODE128[code];
      if (!pattern) return;
      for (let k = 0; k < pattern.length; k++) {
        modules += (k % 2 === 0 ? '1' : '0').repeat(Number(pattern[k]));
      }
    });
    return modules;
  }

  function barcodeSvg(value) {
    const modules = code128Modules(value);
    if (!modules) return '';
    const quiet = 10; // quiet zone, in modules
    const width = modules.length + quiet * 2;
    let bars = '';
    for (let i = 0; i < modules.length;) {
      if (modules[i] === '0') { i++; continue; }
      let end = i;
      while (end < modules.length && modules[end] === '1') end++;
      bars += `<rect x="${quiet + i}" y="0" width="${end - i}" height="64"/>`;
      i = end;
    }
    return `<svg class="person-barcode-svg" viewBox="0 0 ${width} 64" preserveAspectRatio="none"`
      + ` shape-rendering="crispEdges" role="img" aria-label="Barcode ${escapeAttr(value)}">${bars}</svg>`;
  }

  window.Code128 = { modules: code128Modules, svg: barcodeSvg };

  // ── Check-in barcode page ────────────────────────────────────────────────────
  // Shows the member id + barcode for the name saved in this browser (the same `crw_user_name`
  // the Watcher page writes). Details come straight from the public state.json.
  const page = document.getElementById('barcodePage');
  if (!page) return;

  const DATA_URL = 'https://d22bq7zsasshul.cloudfront.net/courtreserve-watcher/state.json';
  const src = new URLSearchParams(location.search).get('src') || DATA_URL;
  const NAME_KEY = 'crw_user_name';
  const ID_KEY = 'crw_member_id'; // last member id seen for this name, so the barcode survives quiet weeks
  const esc = escapeAttr;

  const el = {
    status: document.getElementById('checkinStatus'),
    banner: document.getElementById('checkinBanner'),
    card: document.getElementById('checkinCard'),
    refresh: document.getElementById('checkinRefresh'),
  };

  const state = {
    user: (localStorage.getItem(NAME_KEY) || '').trim(),
    data: null,
    error: '',
    loading: true,
    editing: false,
  };

  const nameKey = (value) => String(value || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')   // keep only letters a-z and whitespace; remove digits & special chars
    .replace(/\s+/g, ' ')
    .trim();
  const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

  function readCachedId() {
    try {
      const saved = JSON.parse(localStorage.getItem(ID_KEY) || 'null');
      return saved && nameKey(saved.name) === nameKey(state.user) ? String(saved.id || '') : '';
    } catch { return ''; }
  }
  function saveCachedId(name, id) {
    if (!name || !id) return;
    try { localStorage.setItem(ID_KEY, JSON.stringify({ name, id: String(id) })); } catch { /* private mode */ }
  }

  function slotDate(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(key || ''));
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
  }
  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function slotLabel(found) {
    const when = found.when;
    if (!when) return found.key;
    const day = when.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${day} · ${time}`;
  }

  // Every upcoming slot whose roster contains this name (case/space insensitive, like app.js).
  function findSessions(data, name) {
    const key = nameKey(name);
    if (!key || !data || !data.snapshots) return [];
    const found = [];
    for (const [slotKey, snap] of Object.entries(data.snapshots)) {
      if (!snap || !snap.people) continue;
      for (const [personName, person] of Object.entries(snap.people)) {
        if (nameKey(personName) !== key) continue;
        const when = slotDate(slotKey) || slotDate(snap.date ? `${snap.date} ${snap.time || '00:00'}` : '');
        // Snapshots are pruned on the server, but keep the page honest about "upcoming" anyway.
        if (when && when < startOfToday()) break;
        found.push({ key: slotKey, snap, person, name: personName, when });
        break;
      }
    }
    return found.sort((a, b) => a.key.localeCompare(b.key));
  }

  function statusChip(status) {
    if (status === 'reg') return '<span class="person-status reg"><span class="material-symbols-outlined">check_circle</span> Registered</span>';
    if (status === 'wait') return '<span class="person-status wait"><span class="material-symbols-outlined">hourglass_empty</span> Waitlisted</span>';
    return '';
  }

  function setupHtml() {
    return `<div class="checkin-setup">
      <span class="material-symbols-outlined">barcode</span>
      <h2>Your check-in barcode</h2>
      <p>Enter the name you use on CourtReserve. It stays in this browser and is shared with the Watcher page.</p>
      <input type="text" id="checkinNameInput" class="checkin-input" placeholder="Your CourtReserve name"
        autocomplete="off" spellcheck="false" value="${esc(state.user)}">
      <div class="checkin-actions centered">
        <button type="button" class="checkin-btn primary" id="saveCheckinName">Save name</button>
        ${state.user ? '<button type="button" class="checkin-btn" id="cancelCheckinName">Cancel</button>' : ''}
      </div>
    </div>`;
  }

  function barcodeBlock(id) {
    const code = barcodeSvg(id);
    if (!code) return '';
    return `<div class="person-barcode-wrap checkin-barcode">
        ${code}
        <span class="person-barcode-text">${esc(id)}</span>
      </div>
      <p class="person-hint">Show this barcode at the front desk to check in.</p>`;
  }

  function emptyBarcodeHtml() {
    return `<div class="person-empty">
      <span class="material-symbols-outlined">barcode</span>
      <p>No member barcode yet. CourtReserve returns an Organization Member ID for registered
      members; it appears here once a scan includes you.</p>
    </div>`;
  }

  function sessionsHtml(sessions) {
    const rows = sessions.map((found) => {
      const events = (found.person.ev && found.person.ev.length
        ? found.person.ev
        : (found.snap.events || []).map((e) => (typeof e === 'string' ? e : e.name))).filter(Boolean);
      return `<div class="checkin-event">
        <div class="checkin-event-text">
          <div class="checkin-event-when">${esc(slotLabel(found))}</div>
          <div class="checkin-event-ev">${esc(events.join(' / ') || 'Event')}</div>
        </div>
        <span class="checkin-event-status">${statusChip(found.person.status)}</span>
      </div>`;
    }).join('');
    return `<div class="checkin-section-title"><span class="material-symbols-outlined">event</span>Upcoming sessions</div>
      <div class="checkin-events">${rows}</div>`;
  }

  function render() {
    if (!el.card) return;

    if (state.loading && !state.data) {
      el.card.innerHTML = '<div class="checkin-loading"><span class="spin"></span> Loading your check-in details…</div>';
      return;
    }
    if (!state.user || state.editing) {
      el.card.innerHTML = setupHtml();
      el.card.querySelector('#checkinNameInput')?.focus({ preventScroll: true });
      return;
    }
    if (state.error && !state.data) {
      el.card.innerHTML = `<div class="person-empty">
        <span class="material-symbols-outlined">cloud_off</span>
        <p>Could not load your details — ${esc(state.error)}. Use the refresh button to try again.</p>
      </div>`;
      return;
    }

    const sessions = findSessions(state.data, state.user);
    const liveId = sessions.map((s) => s.person && s.person.id).find(Boolean);
    if (liveId) saveCachedId(sessions[0].name || state.user, liveId);
    const id = liveId ? String(liveId) : readCachedId();
    const displayName = sessions.length ? sessions[0].name : state.user;
    const status = sessions.some((s) => s.person.status === 'reg') ? 'reg'
      : sessions.some((s) => s.person.status === 'wait') ? 'wait' : '';
    const upcoming = sessions.length
      ? `${sessions.length} upcoming session${sessions.length === 1 ? '' : 's'}`
      : 'No upcoming sessions';

    el.card.innerHTML = `
      <div class="person-head">
        <span class="person-avatar">${esc(initials(displayName) || '?')}</span>
        <div class="person-head-text">
          <div class="person-name">${esc(displayName)}</div>
          ${statusChip(status)}
          <div class="checkin-meta">${esc(upcoming)}</div>
        </div>
      </div>
      ${id ? `<div class="person-field">
        <span class="person-field-label">Organization Member ID</span>
        <div class="person-id-row">
          <span class="person-id-value">${esc(id)}</span>
          <button type="button" class="person-copy-btn" id="copyMemberId" data-id="${esc(id)}">
            <span class="material-symbols-outlined">content_copy</span> Copy
          </button>
        </div>
      </div>${barcodeBlock(id)}` : emptyBarcodeHtml()}
      ${sessions.length ? sessionsHtml(sessions) : `<p class="checkin-note">
        Nothing on the schedule matches “${esc(state.user)}”. Check that the name is exactly as it
        appears on CourtReserve, or refresh after the next scan.</p>`}
      <div class="checkin-actions">
        <button type="button" class="checkin-btn" id="changeName">
          <span class="material-symbols-outlined">person</span>Change name
        </button>
        <a class="checkin-btn" href="index.html">
          <span class="material-symbols-outlined">calendar_month</span>Open Watcher
        </a>
      </div>`;
  }

  function saveName() {
    const input = document.getElementById('checkinNameInput');
    const value = ((input && input.value) || '').trim();
    if (!value) { if (input) input.focus(); return; }
    haptic();
    state.user = value;
    state.editing = false;
    try { localStorage.setItem(NAME_KEY, value); } catch { /* private mode */ }
    render();
  }

  function copyMemberId(id) {
    haptic();
    const done = () => flashBanner('Member ID copied.', false);
    const fallback = () => {
      const area = document.createElement('textarea');
      area.value = id;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy'); } catch { /* nothing else to try */ }
      area.remove();
      done();
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(id).then(done).catch(fallback);
    } else {
      fallback();
    }
  }

  let bannerTimer = 0;
  function flashBanner(text, isError) {
    if (!el.banner) return;
    el.banner.textContent = text;
    el.banner.hidden = false;
    el.banner.classList.toggle('err', !!isError);
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => { el.banner.hidden = true; }, 2600);
  }

  el.card.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.id === 'saveCheckinName') saveName();
    else if (button.id === 'cancelCheckinName') { haptic(); state.editing = false; render(); }
    else if (button.id === 'changeName') { haptic(); state.editing = true; render(); }
    else if (button.id === 'copyMemberId') copyMemberId(button.dataset.id || '');
  });
  el.card.addEventListener('keydown', (event) => {
    if (event.target.id === 'checkinNameInput' && event.key === 'Enter') {
      event.preventDefault();
      saveName();
    }
  });

  function updateStatus() {
    if (!el.status) return;
    const ts = state.data && (state.data.updated || state.data.lastRun);
    el.status.innerHTML = ts
      ? `<span class="material-symbols-outlined" style="font-size:12px">check_circle</span> Updated ${new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
  }

  async function load() {
    if (!src) return;
    el.refresh?.classList.add('spinning');
    state.loading = true;
    try {
      const r = await fetch(`${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      state.data = await r.json();
      state.error = '';
      if (el.banner && !el.banner.classList.contains('err')) el.banner.hidden = true;
      updateStatus();
    } catch (e) {
      state.error = (e && e.message) || 'request failed';
    } finally {
      state.loading = false;
      el.refresh?.classList.remove('spinning');
      render();
    }
  }

  el.refresh?.addEventListener('click', () => {
    haptic();
    load();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  window.addEventListener('storage', (event) => {
    if (event.key !== NAME_KEY) return;
    state.user = (event.newValue || '').trim();
    state.editing = false;
    render();
  });
  setInterval(load, 60000);
  render();
  load();
})();
