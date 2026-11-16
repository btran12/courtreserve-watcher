const DATA_URL = 'https://d22bq7zsasshul.cloudfront.net/courtreserve-watcher/state.json';
const src = new URLSearchParams(location.search).get('src') || DATA_URL || (location.protocol.startsWith('http') ? 'courtreserve-watcher/state.json' : '');

const ICON = { 
  joined: 'add_circle', 
  left: 'remove_circle', 
  'waitlist-joined': 'hourglass_top', 
  'waitlist-left': 'door_back', 
  promoted: 'arrow_upward', 
  demoted: 'arrow_downward', 
  removed: 'delete' 
};

const TEXT = { 
  joined: 'joined', 
  left: 'left', 
  'waitlist-joined': 'joined the waitlist', 
  'waitlist-left': 'left the waitlist',
  promoted: 'moved from waitlist to registered', 
  demoted: 'moved from registered to waitlist', 
  removed: 'event no longer listed' 
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cls = (t) => (t === 'joined' || t === 'promoted' ? 'j' : t === 'left' || t === 'removed' ? 'l' : 'w');
const fmtTime = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}`; };
const renderIcon = (type) => `<span class="material-symbols-outlined" style="font-size:16px; vertical-align:middle;">${ICON[type] || 'info'}</span>`;
const count = (s, st) => Object.values(s.people).filter((p) => p.status === st).length;

let currentData = null;

// ── Device (system) notifications ──
// Every watch-change toast also raises a matching OS notification when the user allows it,
// so an alert still arrives with the tab in the background, another app in front, or the
// installed app on a phone.
const NOTIFY_PREF_KEY = 'crw_notify_pref';   // 'on' | 'off', null until the user chooses
const NOTIFY_ASKED_KEY = 'crw_notify_asked'; // stops re-prompting after a dismissed permission dialog
const notifySupported = typeof window !== 'undefined' && 'Notification' in window;
let notifyPref = localStorage.getItem(NOTIFY_PREF_KEY);
// Only two pages remain: the day view (with the court timeline) and the activity feed.
let currentView = localStorage.getItem('crw_view') === 'activity' ? 'activity' : 'day';
let selectedDate = new Date();
let dateInitialized = false;
// One-shot animation for the next renderCurrentView(): 'enter' after a view switch or first visit,
// 'prev'/'next' for directional navigation, null for background data refreshes (leave it still).
let pendingViewAnim = 'enter';
// Roster names stagger in once, on the first paint after the data arrives. Later renders
// (background polls, view changes) leave the lists still.
let namesAnimated = false;
// Date the day ribbon was last scrolled for, so a data refresh keeps the user's scroll position.
let ribbonCenteredFor = null;

// Restore view/date from URL if present (overrides localStorage / defaults)
restoreFromUrl();

// ── Watched events ──
const watchedEvents = new Set(JSON.parse(localStorage.getItem('crw_watched') || '[]'));
let lastWatchSnapshot = JSON.parse(localStorage.getItem('crw_watch_snapshot') || '{}');

function toggleWatch(slotKey) {
  if (watchedEvents.has(slotKey)) {
    watchedEvents.delete(slotKey);
  } else {
    watchedEvents.add(slotKey);
    // First watch is a natural, user-initiated moment to offer device alerts.
    maybeAskForNotifications();
  }
  localStorage.setItem('crw_watched', JSON.stringify([...watchedEvents]));
  renderCurrentView();
}

// "Sat, Nov 8 (Tomorrow) · 7:00am" — enough context to place a change without opening the app.
function slotWhenLabel(s) {
  const time = s.time ? fmtTime(s.time) : '';
  if (!s.date) return time;
  const dateLabel = fromDateStr(s.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const rel = getRelativeDateLabel(s.date);
  const relLabel = rel === 'Today' || rel === 'Tomorrow' ? ` (${rel})` : '';
  return `${dateLabel}${relLabel} · ${time}`;
}

// Compares the roster kept from the previous poll (name → 'reg' | 'wait') against the current one
// so every toast can name who actually joined, left, or moved between the list and the waitlist.
function rosterChanges(prevRoster, roster) {
  const changes = [];
  const names = new Set([...Object.keys(prevRoster || {}), ...Object.keys(roster || {})]);
  for (const name of [...names].sort((a, b) => a.localeCompare(b))) {
    const before = (prevRoster || {})[name];
    const after = (roster || {})[name];
    if (!before && after) changes.push({ type: after === 'reg' ? 'joined' : 'waitlist-joined', name });
    else if (before && !after) changes.push({ type: before === 'reg' ? 'left' : 'waitlist-left', name });
    else if (before === 'wait' && after === 'reg') changes.push({ type: 'promoted', name });
    else if (before === 'reg' && after === 'wait') changes.push({ type: 'demoted', name });
  }
  return changes;
}

// "12 registered (+2) · 1 waitlisted (-1) · 0 open" — the numeric side of a change.
function rosterSummaryLine(regCount, prevReg, waitCount, prevWait, spots) {
  const delta = (n, p) => (p == null || n === p) ? '' : ` (${n > p ? '+' : ''}${n - p})`;
  const parts = [`${regCount} registered${delta(regCount, prevReg)}`];
  if (waitCount > 0 || (prevWait || 0) > 0) parts.push(`${waitCount} waitlisted${delta(waitCount, prevWait)}`);
  if (spots != null) parts.push(spots > 0 ? `${spots} open` : 'full');
  return parts.join(' · ');
}

function checkWatchedChanges(data) {
  if (!data || !data.snapshots) return;
  const newSnap = {};
  const toasts = [];

  for (const key of watchedEvents) {
    const s = data.snapshots[key];
    if (!s) continue;
    const regCount = Object.values(s.people).filter(p => p.status === 'reg').length;
    const waitCount = Object.values(s.people).filter(p => p.status === 'wait').length;
    const evData = (s.events && s.events[0]) || {};
    const spots = evData.spotsRemaining != null ? evData.spotsRemaining
      : evData.capacity != null ? Math.max(0, evData.capacity - regCount) : null;

    // Keep the full roster (name → status) so the next poll can report exactly who moved.
    const roster = {};
    for (const [name, p] of Object.entries(s.people)) roster[name] = p && p.status ? p.status : p;

    newSnap[key] = { regCount, waitCount, spots, roster };

    const prev = lastWatchSnapshot[key];
    if (!prev) continue; // first time seeing this event, no toast

    // Snapshots stored before rosters were tracked have no roster to diff against yet.
    const changes = prev.roster ? rosterChanges(prev.roster, roster) : [];
    const countsChanged = regCount !== prev.regCount || waitCount !== prev.waitCount;

    const when = slotWhenLabel(s);
    const eventName = (s.events || []).map((e) => e.name).join(' / ') || key;
    const summary = rosterSummaryLine(regCount, prev.regCount, waitCount, prev.waitCount, spots);

    // Spot-opened toast
    if (spots != null && prev.spots != null && prev.spots === 0 && spots > 0) {
      toasts.push({ type: 'spot-open', title: `${spots} spot${spots > 1 ? 's' : ''} opened!`, when, eventName, summary, changes, key, date: s.date });
    }
    // General change toast (roster changed, including swaps that keep the counts identical)
    else if (changes.length || countsChanged) {
      toasts.push({ type: 'change', title: 'Roster changed', when, eventName, summary, changes, key, date: s.date });
    }
  }

  lastWatchSnapshot = newSnap;
  localStorage.setItem('crw_watch_snapshot', JSON.stringify(newSnap));

  if (toasts.length) {
    ensureToastContainer();
    for (const t of toasts) showToast(t);
  }
}

function ensureToastContainer() {
  if (document.getElementById('toastContainer')) return;
  const el = document.createElement('div');
  el.id = 'toastContainer';
  el.className = 'toast-container';
  document.body.appendChild(el);
}

// Toasts are sticky: they stay until the reader dismisses them (or clears them all).
// A long-lived tab could otherwise pile them up, so the stack is capped.
const MAX_TOASTS = 6;
// Monotonic id used to pair each toast with the system notification it raises.
let toastSeq = 0;

// Horizontal swipe-to-dismiss: how far / how fast the toast must travel before it flies out.
const TOAST_SWIPE_MIN = 48;      // px
const TOAST_SWIPE_VELOCITY = 0.5; // px per ms
const TOAST_SWIPE_MAX_RATIO = 0.25; // of the toast width, capped below

function dismissToast(el, direction) {
  if (!el || el.classList.contains('dismissing')) return;
  el.classList.add('dismissing');
  if (direction) el.classList.add(direction === 'left' ? 'swipe-left' : 'swipe-right');
  // The matching system notification goes away with its toast.
  closeDeviceNotification(el.dataset.notifTag);
  setTimeout(() => {
    el.remove();
    syncToastContainer();
  }, 250);
}

// Drag a toast sideways to throw it away. A short drag springs back instead.
// Vertical gestures are left to the page so scrolling still works on touch.
function attachToastSwipe(el, onHorizontalDrag) {
  let drag = null;

  const snapBack = () => {
    drag = null;
    if (!el.isConnected) return;
    el.classList.remove('swiping');
    void el.offsetWidth; // commit the drag offset before the transition is enabled
    el.classList.add('snapping');
    el.style.transform = '';
    el.style.opacity = '';
    setTimeout(() => el.classList.remove('snapping'), 220);
  };

  el.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A previous gesture's click may not have fired (e.g. pointercancel); reset safely here.
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      axis: null,
    };
  });

  el.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;

    if (!drag.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // Dominant vertical movement means the user is scrolling, not swiping the toast.
      if (Math.abs(dy) >= Math.abs(dx)) { drag.axis = 'y'; return; }
      drag.axis = 'x';
      try { el.setPointerCapture(event.pointerId); } catch (_) { /* not supported */ }
      el.classList.remove('snapping');
      el.classList.add('swiping');
      onHorizontalDrag();
    }
    if (drag.axis !== 'x') return;

    event.preventDefault();
    const opacity = Math.max(0.3, 1 - Math.abs(dx) / (el.offsetWidth || 320));
    el.style.setProperty('--toast-swipe-x', `${dx}px`);
    el.style.setProperty('--toast-swipe-opacity', String(opacity));
    el.style.transform = `translateX(${dx}px)`;
    el.style.opacity = String(opacity);
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const gesture = drag;
    drag = null;
    if (gesture.axis !== 'x') return;

    const dx = event.clientX - gesture.x;
    const elapsed = Math.max(1, performance.now() - gesture.time);
    const threshold = Math.min(96, Math.max(TOAST_SWIPE_MIN, el.offsetWidth * TOAST_SWIPE_MAX_RATIO));
    const fast = Math.abs(dx) / elapsed > TOAST_SWIPE_VELOCITY && Math.abs(dx) > 28;

    if (Math.abs(dx) >= threshold || fast) {
      el.classList.remove('swiping', 'snapping');
      dismissToast(el, dx >= 0 ? 'right' : 'left');
    } else {
      snapBack();
    }
  };

  el.addEventListener('pointerup', endDrag);
  el.addEventListener('pointercancel', () => {
    // Only a horizontal gesture has anything to spring back; a canceled page scroll does not.
    if (drag && drag.axis === 'x') snapBack();
    else drag = null;
  });
}

function clearToasts() {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  container.querySelectorAll('.toast').forEach(dismissToast);
}

// Drops the container once empty and only shows "clear all" when more than one toast is up.
function syncToastContainer() {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const n = container.querySelectorAll('.toast:not(.dismissing)').length;
  if (!n) { container.remove(); return; }
  const bulk = container.querySelector('.toast-clear-all');
  if (bulk) bulk.classList.toggle('visible', n > 1);
}

// Named roster movements inside a toast, e.g. "Alex Chen joined". Capped so a mass
// change can't turn one toast into an unbounded wall of text.
const MAX_TOAST_CHANGES = 4;

function toastChangesHtml(changes) {
  if (!changes || !changes.length) return '';
  const shown = changes.slice(0, MAX_TOAST_CHANGES);
  const extra = changes.length - shown.length;
  const items = shown.map((c) =>
    `<li class="tc-${cls(c.type)}"><span class="material-symbols-outlined">${ICON[c.type] || 'info'}</span><span><b>${esc(c.name)}</b> ${esc(TEXT[c.type] || c.type)}</span></li>`
  ).join('');
  return `<ul class="toast-changes">${items}${extra ? `<li class="toast-more">+${extra} more change${extra > 1 ? 's' : ''}</li>` : ''}</ul>`;
}

function showToast(t, opts = {}) {
  // The container is torn down once the last toast is dismissed, so recreate on demand.
  ensureToastContainer();
  const container = document.getElementById('toastContainer');
  if (!container) return;

  // Tags are unique per toast so dismissing one closes exactly its own system notification.
  const tag = `crw-${++toastSeq}-${t.key || 'update'}`;

  if (!container.querySelector('.toast-clear-all')) {
    const bulk = document.createElement('button');
    bulk.type = 'button';
    bulk.className = 'toast-clear-all';
    bulk.innerHTML = '<span class="material-symbols-outlined">delete_sweep</span> Clear all';
    bulk.onclick = (e) => { e.stopPropagation(); clearToasts(); };
    container.appendChild(bulk);
  }

  const [toastIcon, toastColor] = t.type === 'spot-open' ? ['event_available', '#2e7d32']
    : t.type === 'notify' ? ['notifications_active', '#1976d2']
    : ['campaign', '#1976d2'];

  const el = document.createElement('div');
  el.className = `toast ${t.type}`;
  el.dataset.notifTag = tag;
  el.innerHTML = `<span class="toast-icon material-symbols-outlined" style="color:${toastColor}">${toastIcon}</span>
    <div class="toast-body">
      <div class="toast-title">${esc(t.title)}</div>
      ${t.when ? `<div class="toast-when"><span class="material-symbols-outlined">schedule</span><span>${esc(t.when)}</span></div>` : ''}
      ${t.eventName ? `<div class="toast-event">${esc(t.eventName)}</div>` : ''}
      ${t.summary ? `<div class="toast-detail">${esc(t.summary)}</div>` : ''}
      ${toastChangesHtml(t.changes)}
    </div>
    <button type="button" class="toast-close" aria-label="Dismiss notification" title="Dismiss">
      <span class="material-symbols-outlined">close</span>
    </button>`;
  el.querySelector('.toast-close').onclick = (e) => { e.stopPropagation(); dismissToast(el); };
  // A horizontal drag must not also fire the tap-to-dismiss click when it ends.
  let clickBlockedUntil = 0;
  el.onclick = () => {
    if (performance.now() < clickBlockedUntil) return;
    dismissToast(el);
  };
  container.appendChild(el);
  attachToastSwipe(el, () => { clickBlockedUntil = performance.now() + 500; });

  // Mirror the toast to the device. Permission feedback toasts opt out with { device: false }.
  if (opts.device !== false) notifyDevice(t, tag);

  const shown = [...container.querySelectorAll('.toast')];
  if (shown.length > MAX_TOASTS) shown.slice(0, shown.length - MAX_TOASTS).forEach(dismissToast);
  syncToastContainer();
}

// ── Device notification plumbing ──

function notificationPermission() {
  if (!notifySupported) return 'unsupported';
  try { return Notification.permission; } catch (_) { return 'denied'; }
}

// On by default once permission is granted; the bell button can switch it back off.
function notifyEnabled() {
  return notificationPermission() === 'granted' && notifyPref !== 'off';
}

// "12 registered (+2) · 1 waitlisted" plus who moved, same content as the toast body.
function deviceNotificationBody(t) {
  const lines = [];
  if (t.when) lines.push(t.when);
  if (t.summary) lines.push(t.summary);
  const changes = t.changes || [];
  for (const c of changes.slice(0, MAX_TOAST_CHANGES)) lines.push(`${c.name} ${TEXT[c.type] || c.type}`);
  const extra = changes.length - Math.min(changes.length, MAX_TOAST_CHANGES);
  if (extra > 0) lines.push(`+${extra} more change${extra > 1 ? 's' : ''}`);
  return lines.join('\n');
}

// Tapping a notification should land on the event's day rather than the app's last view.
function notificationUrl(t) {
  if (!t.date) return location.href;
  const params = new URLSearchParams({ view: 'day', date: t.date });
  return `${location.origin}${location.pathname}#${params.toString()}`;
}

async function displayDeviceNotification(title, options) {
  // The service worker path is required on Android and on iOS home-screen web apps;
  // a page-level Notification is the desktop fallback when no worker is registered.
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.showNotification) {
        await reg.showNotification(title, options);
        return;
      }
    } catch (_) {
      /* fall through to the constructor */
    }
  }
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      n.close();
      const target = options.data && options.data.url;
      if (target && target !== location.href) location.href = target;
    };
  } catch (_) {
    /* notifications unavailable */
  }
}

function notifyDevice(t, tag) {
  if (!notifyEnabled()) return;
  const title = t.eventName ? `${t.title} — ${t.eventName}` : t.title;
  displayDeviceNotification(title, {
    body: deviceNotificationBody(t),
    icon: 'icon.png',
    badge: 'icon.png',
    tag,
    data: { url: notificationUrl(t) },
  });
}

async function closeDeviceNotification(tag) {
  if (!tag || !('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.getNotifications) return;
    const notifications = await reg.getNotifications({ tag });
    notifications.forEach((n) => n.close());
  } catch (_) {
    /* the OS notification simply stays around */
  }
}

function requestNotificationPermission() {
  if (!notifySupported || typeof Notification.requestPermission !== 'function') return;
  localStorage.setItem(NOTIFY_ASKED_KEY, '1');
  let pending;
  try {
    pending = Notification.requestPermission();
  } catch (_) {
    syncNotifyButton();
    return;
  }
  Promise.resolve(pending).then((permission) => {
    notifyPref = permission === 'granted' ? 'on' : permission === 'denied' ? 'off' : notifyPref;
    if (notifyPref) localStorage.setItem(NOTIFY_PREF_KEY, notifyPref);
    syncNotifyButton();
    if (permission === 'granted') {
      showToast({
        type: 'notify',
        title: 'Device notifications on',
        summary: "Watched-event changes will also pop up on this device.",
      }, { device: false });
    } else if (permission === 'denied') {
      showToast({
        type: 'notify',
        title: 'Device notifications blocked',
        summary: 'Allow notifications for this site in your browser settings to turn them on.',
      }, { device: false });
    }
  }).catch(() => { syncNotifyButton(); });
}

// Ask once, from a user gesture, the first time an event is watched. Afterwards only the bell
// button (or the browser's own settings) changes the choice.
function maybeAskForNotifications() {
  if (notificationPermission() !== 'default') return;
  if (localStorage.getItem(NOTIFY_ASKED_KEY)) return;
  requestNotificationPermission();
}

function toggleDeviceNotifications() {
  const permission = notificationPermission();
  if (permission === 'unsupported') return;

  if (permission === 'denied') {
    showToast({
      type: 'notify',
      title: 'Device notifications blocked',
      summary: 'Allow notifications for this site in your browser settings, then try again.',
    }, { device: false });
    return;
  }

  if (permission === 'default') {
    requestNotificationPermission();
    return;
  }

  // Already granted: the bell flips the app-level preference without touching site settings.
  notifyPref = notifyEnabled() ? 'off' : 'on';
  localStorage.setItem(NOTIFY_PREF_KEY, notifyPref);
  syncNotifyButton();
  showToast({
    type: 'notify',
    title: notifyPref === 'on' ? 'Device notifications on' : 'Device notifications off',
    summary: notifyPref === 'on'
      ? "Watched-event changes will also pop up on this device."
      : 'You will still see change toasts inside the app.',
  }, { device: false });
}

// Reflect permission + preference in the header bell (hidden on browsers without support).
function syncNotifyButton() {
  const btn = document.getElementById('notifyToggle');
  if (!btn) return;
  if (!notifySupported) { btn.hidden = true; return; }
  btn.hidden = false;

  const permission = notificationPermission();
  const on = notifyEnabled();
  const blocked = permission === 'denied';
  const icon = btn.querySelector('.material-symbols-outlined');

  btn.classList.toggle('on', on);
  btn.classList.toggle('blocked', blocked);
  btn.setAttribute('aria-pressed', String(on));
  if (icon) icon.textContent = blocked ? 'notifications_off' : on ? 'notifications_active' : 'notifications_none';
  btn.title = blocked
    ? 'Device notifications blocked — allow them in your browser settings'
    : on ? 'Device notifications on — click to turn off'
    : permission === 'granted' ? 'Device notifications off — click to turn on'
    : 'Enable device notifications';
  btn.setAttribute('aria-label', btn.title);
}

// ── User name ──
let userName = localStorage.getItem('crw_user_name') || '';

// Show startup name prompt if not set and not dismissed
function showNamePrompt() {
  const prompt = document.getElementById('namePrompt');
  if (!prompt) return;
  if (userName || localStorage.getItem('crw_name_dismissed')) return;
  prompt.classList.add('open');
  const input = document.getElementById('promptNameInput');
  const saveBtn = document.getElementById('promptSave');
  const dismissBtn = document.getElementById('promptDismiss');

  const close = () => prompt.classList.remove('open');
  saveBtn.onclick = () => {
    const val = input.value.trim();
    if (val) setUserName(val);
    close();
  };
  dismissBtn.onclick = () => {
    localStorage.setItem('crw_name_dismissed', '1');
    updateNameDisplay();
    close();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
  input.focus();
}

function updateNameDisplay() {
  const display = document.getElementById('userNameDisplay');
  const inputWrap = document.getElementById('userNameInputWrap');
  const welcomeName = document.getElementById('welcomeName');
  const input = document.getElementById('userNameInput');
  const check = document.getElementById('userNameCheck');

  if (userName) {
    if (welcomeName) welcomeName.textContent = userName;
    if (display) display.classList.add('visible');
    if (inputWrap) inputWrap.classList.remove('visible');
  } else {
    if (display) display.classList.remove('visible');
    if (inputWrap) inputWrap.classList.add('visible');
    if (input) input.value = '';
  }
}

function setUserName(name) {
  userName = name.trim();
  localStorage.setItem('crw_user_name', userName);
  const input = document.getElementById('userNameInput');
  const check = document.getElementById('userNameCheck');
  if (input) input.value = userName;
  if (check) check.style.display = userName ? '' : 'none';
  updateNameDisplay();
  renderCurrentView();
}
function userStatus(snapshot) {
  if (!userName || !snapshot) return null;
  const key = userName.toLowerCase().trim();
  for (const [name, p] of Object.entries(snapshot.people)) {
    if (name.toLowerCase().trim() === key) return p.status;
  }
  return null;
}
// Every roster name is a button: tapping it opens the participant sheet with the
// CourtReserve OrganizationMemberId and a Code 128 barcode generated from it.
function personButton(name, snapshot, waitlist = false) {
  const matched = !!userName && name.toLowerCase().trim() === userName.toLowerCase().trim();
  const inner = matched
    ? `<span class="${waitlist ? 'user-match-waitlist' : 'user-match'}">${esc(name)}</span>`
    : esc(name);
  const key = snapshot && snapshot.key ? snapshot.key : '';
  return `<button type="button" class="name-btn" title="${esc(name)} — member ID &amp; barcode"`
    + ` onclick="event.stopPropagation();openPersonSheet('${esc(key)}','${esc(name)}')">${inner}</button>`;
}

function highlightName(name, snapshot) {
  return personButton(name, snapshot, false);
}
function highlightNameWaitlist(name, snapshot) {
  return personButton(name, snapshot, true);
}

// Blank, pre-numbered rows for the spots still open, e.g. "24. __________".
// The <ol> numbering continues from the registered names, so a null entry is just a placeholder.
const OPEN_SLOT_LI = '<li class="open-slot" aria-label="Open spot">__________</li>';

function withOpenSlots(names, openCount) {
  const blanks = Math.max(0, Math.floor(Number(openCount) || 0));
  return names.concat(Array(blanks).fill(null));
}


function spotsLabel(evt) {
  const parts = [];
  // Prefer actual scraped name count over API aggregate count
  const regCount = (evt.reg || []).length || (evt.signed || 0);
  parts.push('<b>' + regCount + '</b> registered');
  if (evt.spotsRemaining != null) {
    parts.push('<b>' + evt.spotsRemaining + '</b> open');
  } else if (evt.capacity) {
    const open = Math.max(0, evt.capacity - regCount);
    parts.push('<b>' + open + '</b> open');
  }
  // Prefer actual scraped waitlist names over API count
  const waitN = (evt.wait || []).length || (evt.waitCount || 0);
  if (waitN > 0) parts.push('<b>' + waitN + '</b> waitlisted');
  return parts.join(' \u00b7 ');
}

function hasPerEventData(s) {
  return (s.events || []).length > 1 && s.events[0] && Array.isArray(s.events[0].reg);
}

function renderPerEventSections(s) {
  return s.events.map((evt) => {
    const regNames = (evt.reg || []).sort((a, b) => a.localeCompare(b));
    const waitNames = (evt.wait || []).sort((a, b) => a.localeCompare(b));

    // Fill the roster out to capacity so open spots show as numbered blanks.
    const openSpots = evt.spotsRemaining != null ? evt.spotsRemaining
      : evt.capacity != null ? Math.max(0, evt.capacity - regNames.length) : 0;
    const entries = withOpenSlots(regNames, openSpots);
    const half = Math.ceil(entries.length / 2);
    const col1 = entries.slice(0, half);
    const col2 = entries.slice(half);

    const makeList = (items, startIdx) =>
      '<ol class="people-list" start="' + startIdx + '">' +
      items.map((n) => n == null ? OPEN_SLOT_LI : '<li>' + highlightName(n, s) + '</li>').join('') +
      '</ol>';

    const regHtml = entries.length
      ? '<div class="roster-2col"><div>' + makeList(col1, 1) + '</div><div>' + (col2.length ? makeList(col2, half + 1) : '') + '</div></div>'
      : '<div class="empty-state">No registered participants yet</div>';

    const waitHtml = waitNames.length
      ? '<ol class="people-list waitlist-list">' + waitNames.map((n) => '<li>' + highlightNameWaitlist(n, s) + '</li>').join('') + '</ol>'
      : '';

    const url = evt.number ? 'https://app.courtreserve.com/Online/Events/Details/17397/' + encodeURIComponent(evt.number) : '#';

    return '<div class="box-container">' +
      '<div class="box-title">' +
        '<a href="' + url + '" target="_blank" rel="noopener" style="color:var(--md-primary);text-decoration:none;">' + esc(evt.name) + '</a>' +
        ' <span style="font-weight:400;font-size:0.78rem;color:var(--md-on-surface-variant);">(' + spotsLabel(evt) + ')</span>' +
      '</div>' +
      regHtml +
      (waitHtml ? '<div style="margin-top:10px;"><div class="box-title" style="color:#ed6c02;margin-bottom:4px;"><span class="material-symbols-outlined" style="font-size:16px;color:#ed6c02">hourglass_empty</span> Waitlist (' + waitNames.length + ')</div>' + waitHtml + '</div>' : '') +
    '</div>';
  }).join('');
}
// ── Registration window countdown (uses event time, not just date) ──
function regCountdown(s) {
  const [y, m, d] = s.date.split('-').map(Number);
  const [hh, mm] = (s.time || '0:00').split(':').map(Number);
  const eventDate = new Date(y, m - 1, d, hh, mm);
  const regOpenDate = new Date(eventDate);
  regOpenDate.setDate(regOpenDate.getDate() - 14);
  const now = new Date();
  const diffMs = regOpenDate - now;
  if (diffMs <= 0) return { open: true, label: '' };
  const totalHours = Math.ceil(diffMs / (1000 * 60 * 60));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  let label;
  if (days === 0) {
    label = hours <= 1 ? 'Opens in 1h' : `Opens in ${hours}h`;
  } else if (days === 1 && hours === 0) {
    label = 'Opens tomorrow';
  } else if (hours === 0) {
    label = `Opens in ${days}d`;
  } else {
    label = `Opens in ${days}d ${hours}h`;
  }
  return { open: false, label };
}

function userStatusBadgeHtml(status) {
  if (!userName) return '';
  if (status === 'reg') return `<span class="user-status-badge registered"><span class="material-symbols-outlined" style="font-size:14px;">check_circle</span> You're registered</span>`;
  if (status === 'wait') return `<span class="user-status-badge waitlisted"><span class="material-symbols-outlined" style="font-size:14px;">hourglass_empty</span> You're on the waitlist</span>`;
  return `<span class="user-status-badge not-registered"><span class="material-symbols-outlined" style="font-size:14px;">cancel</span> Not registered</span>`;
}

function eventUrl(keyOrNumber) {
  return `https://app.courtreserve.com/Online/Events/Details/17397/${keyOrNumber}`;
}

// ── Open court availability (state.courts, produced by the Lambda) ──
const COURTS_URL = 'https://app.courtreserve.com/Online/Reservations/Bookings/17397?sId=22028';
const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fmtRange = (s, e) => `${fmtTime(s)}–${fmtTime(e)}`;
const shortCourtName = (name) => name.replace(/^pickleball\s+/i, '');

function courtDay(d, dateStr) {
  const day = d.courts && d.courts.days && d.courts.days[dateStr];
  return day && day.free ? day : null;
}

// Windows either way: tapping a court in the day panel opens the timeline.
function renderCourtsDay(d, dateStr) {
  const day = courtDay(d, dateStr);
  if (!day) return '';
  const courts = d.courts.list && d.courts.list.length
    ? d.courts.list
    : Object.keys(day.free).map((id) => ({ id, name: `Court ${id}` }));
  const rows = courts.map((c) => {
    const free = day.free[c.id] || [];
    return `
      <div class="court-row">
        <span class="court-name">${esc(shortCourtName(c.name))}</span>
        <span class="court-windows">${free.length
          ? free.map(([s, e]) => `<span class="chip chip-open">${fmtRange(s, e)}</span>`).join('')
          : '<span class="chip chip-full">Fully booked</span>'}</span>
      </div>`;
  }).join('');
  const updated = day.updated
    ? new Date(day.updated).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  return `
    <div class="box-container courts-panel" role="button" tabindex="0"
         aria-label="Open the court availability timeline for ${esc(dateStr)}"
         onclick="openCourtsModal('${dateStr}')"
         onkeydown="if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openCourtsModal('${dateStr}'); }">
      <div class="box-title">
        <span class="material-symbols-outlined" style="font-size:16px; color:#2e7d32">sports_tennis</span>
        <a href="${COURTS_URL}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:inherit;">Open Courts</a>
        <span class="court-updated">${updated ? `updated ${updated}` : ''}</span>
      </div>
      ${rows}
      <div class="courts-more">
        <span class="material-symbols-outlined" style="font-size:14px">open_in_full</span>
        Tap for the full timeline
      </div>
    </div>`;
}

// ── Court availability timeline modal ──
const COURT_PX_PER_MIN = 1.15;
let courtsModalDate = null;

// Current wall-clock time in the venue's timezone (all court data is America/New_York).
function etNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const o = {};
  parts.forEach((p) => { o[p.type] = p.value; });
  const h = Number(o.hour) % 24;
  return { dateStr: `${o.year}-${o.month}-${o.day}`, minutes: h * 60 + Number(o.minute) };
}

// 420 -> '7am', 1230 -> '8:30pm'
function clockLabel(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${((h + 11) % 12) + 1}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`;
}

// Alternating booked/open blocks for one court, clamped to the venue's opening hours.
function courtSegments(day, courtId, openMin, closeMin) {
  const free = (day.free[courtId] || [])
    .map(([s, e]) => [Math.max(openMin, toMinutes(s)), Math.min(closeMin, toMinutes(e))])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const segs = [];
  let t = openMin;
  for (const [s, e] of free) {
    if (s > t) segs.push({ s: t, e: s, free: false });
    if (e > t) segs.push({ s: Math.max(s, t), e, free: true });
    t = Math.max(t, e);
  }
  if (t < closeMin) segs.push({ s: t, e: closeMin, free: false });
  return segs.filter((x) => x.e > x.s);
}

function openCourtsModal(dateStr) {
  courtsModalDate = dateStr;
  renderCourtsModal();
}

function closeCourtsModal() {
  courtsModalDate = null;
  const overlay = document.getElementById('courtsModal');
  if (overlay) overlay.classList.remove('open');
  document.body.classList.remove('modal-open');
}

function renderCourtsModal() {
  const overlay = document.getElementById('courtsModal');
  const body = document.getElementById('courtsModalBody');
  const sub = document.getElementById('courtsModalSub');
  if (!overlay || !body) return;

  const d = currentData;
  const day = d && d.courts ? courtDay(d, courtsModalDate) : null;
  if (!day) { closeCourtsModal(); return; }

  const openMin = Math.max(0, toMinutes(d.courts.open || '06:00'));
  const closeMin = Math.min(24 * 60, toMinutes(d.courts.close || '22:00')) || 24 * 60;
  const span = Math.max(60, closeMin - openMin);
  const px = COURT_PX_PER_MIN;
  const totalH = Math.round(span * px);
  const slotH = Math.max(1, Number(d.courts.minInterval) || 30) * px;

  const courts = d.courts.list && d.courts.list.length
    ? d.courts.list
    : Object.keys(day.free).map((id) => ({ id, name: `Court ${id}` }));

  const dateLabel = new Date(`${courtsModalDate}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long', month: 'short', day: 'numeric',
  });
  if (sub) {
    sub.textContent = `${dateLabel} · ${clockLabel(openMin)}–${clockLabel(closeMin)} · `
      + `${Number(d.courts.minInterval) || 30} min blocks`;
  }

  // Hourly ruler
  const tickStep = span > 420 ? 60 : 30;
  let ticks = '';
  for (let m = Math.ceil(openMin / tickStep) * tickStep; m <= closeMin; m += tickStep) {
    const pos = Math.round((m - openMin) * px);
    const edge = pos === 0 ? ' first' : m === closeMin ? ' last' : '';
    ticks += `<div class="court-tick${edge}" style="top:${pos}px"><span>${clockLabel(m)}</span></div>`;
  }

  // "Now" marker, only for today in venue time
  const nowEt = etNow();
  const nowTop = courtsModalDate === nowEt.dateStr && nowEt.minutes >= openMin && nowEt.minutes <= closeMin
    ? Math.round((nowEt.minutes - openMin) * px)
    : null;

  const heads = courts.map((c) => {
    const freeMin = courtSegments(day, c.id, openMin, closeMin)
      .filter((s) => s.free)
      .reduce((a, s) => a + (s.e - s.s), 0);
    const hrs = freeMin / 60;
    const meta = freeMin ? `${hrs % 1 === 0 ? hrs : hrs.toFixed(1)}h open` : 'Fully booked';
    return `
      <div class="cg-head">
        <span class="cg-head-name" title="${esc(c.name)}">${esc(shortCourtName(c.name))}</span>
        <span class="cg-head-meta${freeMin ? '' : ' none'}">${meta}</span>
      </div>`;
  }).join('');

  const cols = courts.map((c) => {
    const segs = courtSegments(day, c.id, openMin, closeMin);
    const segHtml = segs.map(({ s, e, free }) => {
      const h = Math.round((e - s) * px);
      const label = `${clockLabel(s)}–${clockLabel(e)}`;
      const showText = h >= 26;
      const tall = h > 190 ? ' tall' : '';
      return `<div class="court-seg ${free ? 'free' : 'booked'}${tall}" style="top:${Math.round((s - openMin) * px)}px;height:${h}px" title="${free ? 'Open' : 'Booked'} ${label}">${
        showText ? `<span class="seg-time">${label}</span>` : ''
      }${showText && free && h >= 34 ? '<span class="seg-tag">open</span>' : ''}</div>`;
    }).join('');
    const marker = nowTop != null ? `<div class="court-now-line" style="top:${nowTop}px"></div>` : '';
    return `<div class="cg-col" style="height:${totalH}px">${segHtml}${marker}</div>`;
  }).join('');

  body.innerHTML = `
    <div class="courts-grid" style="--court-cols:${courts.length};--slot-h:${slotH}px">
      <div class="cg-corner"></div>
      ${heads}
      <div class="cg-ruler" style="height:${totalH}px">${ticks}</div>
      ${cols}
    </div>`;

  overlay.classList.add('open');
  document.body.classList.add('modal-open');
  // Auto-scroll so "now" sits near the top of the viewport instead of the start of the day.
  // Deferred one frame so the freshly rendered grid has a real clientHeight.
  if (nowTop != null) {
    requestAnimationFrame(() => {
      body.scrollTop = Math.max(0, nowTop - body.clientHeight / 3);
    });
  }
}

// ── Participant sheet: OrganizationMemberId + membership barcode ──
// CourtReserve identifies a member in an organization by OrganizationMemberId, which is what the
// club scans at check-in. The watcher stores it per participant; tapping a roster name opens this
// sheet, which shows the id and a Code 128 barcode generated from it (no external library, so the
// page stays self-contained and works offline / from file://).
let personSheet = null; // { key: slot key, name: participant name }

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
const CODE128_START_B = 104;
const CODE128_STOP = 106;

// Code 128 code set B covers printable ASCII (space..~), which is all a member id ever needs.
function code128Modules(value) {
  const text = String(value ?? '');
  if (!text || [...text].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126)) return '';
  const codes = [CODE128_START_B];
  for (const ch of text) codes.push(ch.charCodeAt(0) - 32);
  // Checksum: start value + sum(value * position), positions starting at 1, modulo 103.
  const checksum = codes.reduce((sum, code, i) => sum + code * (i === 0 ? 1 : i), 0) % 103;
  codes.push(checksum, CODE128_STOP);

  let modules = '';
  codes.forEach((code, i) => {
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
    + ` shape-rendering="crispEdges" role="img" aria-label="Barcode ${esc(value)}">${bars}</svg>`;
}

function openPersonSheet(slotKey, name) {
  personSheet = { key: slotKey, name };
  renderPersonSheet();
}

function closePersonSheet() {
  personSheet = null;
  const overlay = document.getElementById('personModal');
  if (overlay) overlay.classList.remove('open');
  document.body.classList.remove('modal-open');
}

function renderPersonSheet() {
  const overlay = document.getElementById('personModal');
  const title = document.getElementById('personModalTitle');
  const sub = document.getElementById('personModalSub');
  const body = document.getElementById('personModalBody');
  if (!overlay || !body || !personSheet) return;

  const snapshot = currentData && currentData.snapshots ? currentData.snapshots[personSheet.key] : null;
  const person = snapshot && snapshot.people ? snapshot.people[personSheet.name] : null;
  const name = personSheet.name;
  const id = person && person.id ? String(person.id) : '';
  const status = person ? (person.status === 'wait' ? 'wait' : 'reg') : null;
  const events = (person && person.ev) || [];

  if (title) title.textContent = name;
  if (sub) {
    sub.textContent = [
      status === 'wait' ? 'On the waitlist' : status === 'reg' ? 'Registered' : 'Participant',
      events.join(' / '),
    ].filter(Boolean).join(' \u00b7 ');
  }

  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  const statusChip = status === 'wait'
    ? '<span class="person-status wait"><span class="material-symbols-outlined">hourglass_empty</span> Waitlisted</span>'
    : status === 'reg'
      ? '<span class="person-status reg"><span class="material-symbols-outlined">check_circle</span> Registered</span>'
      : '';

  const idBlock = id
    ? `<div class="person-field">
        <span class="person-field-label">Organization Member ID</span>
        <div class="person-id-row">
          <span class="person-id-value">${esc(id)}</span>
          <button type="button" class="person-copy-btn" onclick="copyPersonId('${esc(id)}')">
            <span class="material-symbols-outlined">content_copy</span> Copy
          </button>
        </div>
      </div>
      <div class="person-barcode-wrap">
        ${barcodeSvg(id)}
        <span class="person-barcode-text">${esc(id)}</span>
      </div>
      <p class="person-hint">Show this barcode at the front desk to check in.</p>`
    : `<div class="person-empty">
        <span class="material-symbols-outlined">barcode</span>
        <p>CourtReserve did not return an Organization Member ID for this participant. Guests and
        waitlist entries do not have one.</p>
      </div>`;

  body.innerHTML = `
    <div class="person-head">
      <span class="person-avatar">${esc(initials || '?')}</span>
      <div class="person-head-text">
        <div class="person-name">${esc(name)}</div>
        ${statusChip}
      </div>
    </div>
    ${idBlock}`;

  overlay.classList.add('open');
  document.body.classList.add('modal-open');
}

function copyPersonId(id) {
  const copied = () => showToast({ type: 'notify', title: 'Member ID copied', summary: id }, { device: false });
  const fallback = () => {
    const area = document.createElement('textarea');
    area.value = id;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch { /* nothing else to try */ }
    area.remove();
    copied();
  };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(id).then(copied).catch(fallback);
  } else {
    fallback();
  }
}

// ── Event data helpers (events are now {name, number} objects) ──
function eventLinks(snapshot) {
  return (snapshot.events || []).map(e => {
    if (typeof e === 'string') return esc(e);
    const url = eventUrl(e.number || snapshot.key);
    return '<a href="' + url + '" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:inherit;text-decoration:underline;text-decoration-color:var(--md-primary);text-underline-offset:3px;">' + esc(e.name) + '</a>';
  }).join(' / ');
}
function firstEventNumber(snapshot) {
  const evs = snapshot.events || [];
  if (!evs.length) return snapshot.key;
  const e = evs[0];
  return typeof e === 'string' ? snapshot.key : (e.number || snapshot.key);
}

// ── Expected games per player ──
// Doubles fills 4 spots per court, so at 15 minutes per game one round of games gives every
// player on a court one game. The venue runs these sessions on four courts by default (an event
// may carry its own `courts` count); when more players turn up than the courts can seat, they
// rotate and share the available game slots.
const GAME_MINUTES = 15;
const DEFAULT_EVENT_MINUTES = 120; // snapshots written before durationMin existed
const DEFAULT_COURTS = 4; // venue default when the data does not say otherwise

function eventMinutes(evt) {
  return evt && evt.durationMin > 0 ? evt.durationMin : DEFAULT_EVENT_MINUTES;
}

// One chip for a group of players sharing `courts` courts (4 players per court, 15-minute games).
function gamesChipFor(players, minutes, label, courts = DEFAULT_COURTS) {
  if (!players) return '';
  const rounds = minutes / GAME_MINUTES;
  const games = rounds * Math.min(1, (courts * 4) / players);
  const rounded = games >= 10 ? Math.round(games) : Math.round(games * 10) / 10;
  const shown = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
  const hours = Math.floor(minutes / 60);
  const length = minutes % 60 === 0
    ? `${hours}h`
    : `${hours ? `${hours}h ` : ''}${minutes % 60}m`;
  const tip = `${label ? `${label} · ` : ''}${players} players · ${courts} court${courts === 1 ? '' : 's'} · ${length} session · ${GAME_MINUTES} min per game`;
  return `<span class="chip chip-games" title="${esc(tip)}"><span class="material-symbols-outlined" style="font-size:13px">sports_score</span> ≈${shown} games in ${hours} hours</span>`;
}

function gamesChipHtml(evt) {
  const players = (evt.reg || []).length || evt.signed || evt.capacity || 0;
  return gamesChipFor(players, eventMinutes(evt), '', evt.courts || DEFAULT_COURTS);
}

// Merged events share one day card, so they get one combined estimate: the players of every
// event in the slot are pooled, the courts stay the venue default, and the longest session sets
// the number of rounds.
function slotGamesChipHtml(snapshot) {
  const evts = (snapshot.events || []).filter((e) => e && typeof e === 'object');
  if (!evts.length) return '';
  if (evts.length === 1) return gamesChipHtml(evts[0]);
  const players = evts.reduce((n, e) => n + ((e.reg || []).length || e.signed || e.capacity || 0), 0);
  const minutes = Math.max(...evts.map(eventMinutes));
  const courts = Math.max(...evts.map((e) => e.courts || DEFAULT_COURTS));
  return gamesChipFor(players, minutes, `${evts.length} events`, courts);
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(date, days) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

function fromDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function getWeekDays(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diff);
  
  const days = [];
  for (let i = 0; i < 7; i++) {
    const cur = new Date(monday);
    cur.setDate(monday.getDate() + i);
    days.push(cur);
  }
  return days;
}

function getRelativeDateLabel(dateStr) {
  const now = new Date();
  const [y, m, d] = dateStr.split('-').map(Number);
  const slotDate = new Date(y, m - 1, d);
  const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  const diffTime = slotDate - todayDate;
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Tomorrow';
  if (diffDays > 1 && diffDays < 7) return `In ${diffDays} days`;
  if (diffDays >= 7 && diffDays < 14) return 'In 1 week';
  if (diffDays >= 14) {
    const weeks = Math.round(diffDays / 7);
    return `In ${weeks} weeks`;
  }
  if (diffDays === -1) return 'Yesterday';
  return `${Math.abs(diffDays)} days ago`;
}

// Groups activity rows by the calendar day a change was detected.
function activityDayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function activityDayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
}

function activityDaySeparator(ts) {
  return `<div class="activity-day-separator"><span>${esc(activityDayLabel(ts))}</span></div>`;
}

function initDateIfNeeded(data) {
  if (dateInitialized || !data || !data.snapshots) return;
  dateInitialized = true;
  const slotKeys = Object.keys(data.snapshots).sort();
  if (!slotKeys.length) return;

  const weekDays = getWeekDays(selectedDate);
  const weekDateStrs = new Set(weekDays.map(toDateStr));
  const hasInWeek = slotKeys.some((k) => weekDateStrs.has(data.snapshots[k].date));

  if (!hasInWeek) {
    const todayStr = toDateStr(new Date());
    const upcoming = slotKeys.find((k) => data.snapshots[k].date >= todayStr) || slotKeys[0];
    if (upcoming && data.snapshots[upcoming]) {
      const [y, m, d] = data.snapshots[upcoming].date.split('-').map(Number);
      selectedDate = new Date(y, m - 1, d);
    }
  }
}

function setView(view) {
  currentView = view === 'activity' ? 'activity' : 'day';
  localStorage.setItem('crw_view', currentView);
  closeCourtsModal();
  pendingViewAnim = 'enter';
  syncUrl();
  renderCurrentView();
  // Attach swipe handlers when entering day view
  if (currentView === 'day') setTimeout(attachSwipeHandlers, 100);
}

function navToday() {
  selectedDate = new Date();
  pendingViewAnim = 'enter';
  syncUrl();
  renderCurrentView();
}

function navPrev() {
  selectedDate.setDate(selectedDate.getDate() - 1);
  pendingViewAnim = 'prev';
  syncUrl();
  renderCurrentView();
}

function navNext() {
  selectedDate.setDate(selectedDate.getDate() + 1);
  pendingViewAnim = 'next';
  syncUrl();
  renderCurrentView();
}

function selectDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const nextDate = new Date(y, m - 1, d);
  const prevKey = toDateStr(selectedDate);
  const nextKey = toDateStr(nextDate);
  // Slide in from the side the chosen day sits on, so ribbon taps match swipe navigation.
  pendingViewAnim = nextKey === prevKey ? 'enter' : nextKey < prevKey ? 'prev' : 'next';
  selectedDate = nextDate;
  currentView = 'day';
  localStorage.setItem('crw_view', 'day');
  syncUrl();
  renderCurrentView();
}

// ── URL state sync ──
function syncUrl() {
  const params = new URLSearchParams();
  params.set('view', currentView);
  params.set('date', toDateStr(selectedDate));
  history.replaceState(null, '', '#' + params.toString());
}

function restoreFromUrl() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const v = params.get('view');
  const d = params.get('date');
  const legacyView = !!v && v !== 'day' && v !== 'activity';
  if (v === 'day' || v === 'activity') currentView = v;
  else if (v) currentView = 'day'; // links saved with the old week/list views open the day view
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-').map(Number);
    selectedDate = new Date(y, m - 1, day);
  }
  // Rewrite an old week/list link so the address bar matches what is on screen.
  if (legacyView) syncUrl();
}

// A device notification opens a hash on an already-running tab (a same-document navigation,
// so the page does not reload). Follow the new view/date instead of ignoring it.
window.addEventListener('hashchange', () => {
  const prevView = currentView;
  const prevDate = toDateStr(selectedDate);
  restoreFromUrl();
  if (currentView === prevView && toDateStr(selectedDate) === prevDate) return;
  pendingViewAnim = 'enter';
  closeCourtsModal();
  renderCurrentView();
});

function renderCurrentView() {
  if (!currentData) return;
  const app = document.getElementById('app');

  const titleStr = currentView === 'activity'
    ? 'All Activity'
    : selectedDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

  const viewHtml = currentView === 'activity'
    ? renderActivityView(currentData)
    : renderDayView(currentData);

  // Keep the day ribbon where the user left it when the same day is re-rendered (e.g. data refresh).
  const prevRibbon = currentView === 'day' ? document.querySelector('#viewContainer .day-ribbon') : null;
  const prevRibbonScroll = prevRibbon ? prevRibbon.scrollLeft : null;

  // Consume the one-shot animation so later data refreshes re-render without motion.
  const anim = pendingViewAnim;
  pendingViewAnim = null;

  app.innerHTML = `
    <div class="nav-toolbar">
      <div class="view-segmented-btn">
        <button id="seg-day" class="seg-btn ${currentView === 'day' ? 'active' : ''}" onclick="setView('day')">
          <span class="material-symbols-outlined" style="font-size:18px;">calendar_view_day</span>
          <span class="seg-label">Day</span>
        </button>
        <button id="seg-activity" class="seg-btn ${currentView === 'activity' ? 'active' : ''}" onclick="setView('activity')">
          <span class="material-symbols-outlined" style="font-size:18px;">history</span>
          <span class="seg-label">Activity</span>
        </button>
      </div>

      <div class="date-nav-controls" id="dateNavControls" style="${currentView === 'activity' ? 'display:none;' : ''}">
        <button class="nav-btn nav-btn-icon" onclick="navPrev()" title="Previous period" aria-label="Previous period">
          <span class="material-symbols-outlined" style="font-size:20px;">chevron_left</span>
        </button>
        <button class="nav-btn" onclick="navToday()">
          <span class="material-symbols-outlined" style="font-size:16px;">today</span>
          Today
        </button>
        <button class="nav-btn nav-btn-icon" onclick="navNext()" title="Next period" aria-label="Next period">
          <span class="material-symbols-outlined" style="font-size:20px;">chevron_right</span>
        </button>
        <span class="date-display-title" id="dateDisplayTitle">${titleStr}</span>
      </div>
    </div>

    <div id="viewContainer">
      ${viewHtml}
    </div>
  `;

  const viewContainer = document.getElementById('viewContainer');
  if (viewContainer && (anim === 'prev' || anim === 'next')) {
    // Directional navigation slides the whole view in from the side it came from.
    viewContainer.classList.add('view-slide-in', `from-${anim}`);
    viewContainer.addEventListener('animationend', () => {
      viewContainer.classList.remove('view-slide-in', 'from-prev', 'from-next');
    }, { once: true });
  } else if (anim === 'enter') {
    animateViewContent(viewContainer);
  }

  // First paint only: make the names appear one after another within each event list.
  // Wait for a render that actually has rosters so an empty day doesn't use up the effect.
  if (!namesAnimated && viewContainer && animateRosterNames(viewContainer)) {
    namesAnimated = true;
  }

  if (currentView === 'day') {
    const ribbon = document.querySelector('#viewContainer .day-ribbon');
    const activeDayBtn = ribbon ? ribbon.querySelector('.day-ribbon-btn.active') : null;
    if (ribbon && activeDayBtn) {
      const dateKey = toDateStr(selectedDate);
      if (prevRibbonScroll !== null && ribbonCenteredFor === dateKey) {
        ribbon.scrollLeft = prevRibbonScroll;
      } else {
        // Only move the strip when the selected day is not already comfortably visible.
        const pad = 24;
        const left = activeDayBtn.offsetLeft;
        const right = left + activeDayBtn.offsetWidth;
        if (left < ribbon.scrollLeft + pad || right > ribbon.scrollLeft + ribbon.clientWidth - pad) {
          ribbon.scrollLeft = Math.max(0, left - (ribbon.clientWidth - activeDayBtn.offsetWidth) / 2);
        }
      }
      ribbonCenteredFor = dateKey;
    }
    attachSwipeHandlers();
  }
}

// Cards and sections that rise in with a small stagger when the user changes view or day.
const VIEW_ENTER_TARGETS = [
  '#viewContainer > .day-view-container > *',
  '#viewContainer > .calendar-week-container .week-day-col',
  '#viewContainer > .section-title',
  '#viewContainer > details.card',
  '#viewContainer > .log-card',
  '#viewContainer > .activity-view-container',
].join(',');

function animateViewContent(container) {
  if (!container) return;
  container.querySelectorAll(VIEW_ENTER_TARGETS).forEach((el, i) => {
    el.style.setProperty('--anim-order', String(Math.min(i, 12)));
    el.classList.add('anim-in');
    el.addEventListener('animationend', () => {
      el.classList.remove('anim-in');
      el.style.removeProperty('--anim-order');
    }, { once: true });
  });
}

// Reveal roster names one by one, restarting the stagger for each list so every
// event's registered/waitlist names cascade independently on the first page paint.
function animateRosterNames(container) {
  if (!container || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
  let animated = 0;
  container.querySelectorAll('ol.people-list').forEach((list) => {
    [...list.children].forEach((li, i) => {
      if (li.classList.contains('open-slot')) return; // blank spot placeholders are not names
      animated++;
      li.style.setProperty('--name-order', String(Math.min(i, 24)));
      li.classList.add('name-in');
      li.addEventListener('animationend', () => {
        li.classList.remove('name-in');
        li.style.removeProperty('--name-order');
      }, { once: true });
    });
  });
  return animated;
}

function renderDayView(d) {
  const selectedDateStr = toDateStr(selectedDate);
  const todayStr = toDateStr(new Date());

  const log = (d.log || []).filter((l) => l.type !== 'tracking');

  const slotsByDate = {};
  for (const s of Object.values(d.snapshots)) {
    if (!slotsByDate[s.date]) slotsByDate[s.date] = [];
    slotsByDate[s.date].push(s);
  }

  // The ribbon covers exactly the dates the backend actually returned (slot snapshots and court
  // availability), padded out to full Mon–Sun weeks. Today and the selected day are always kept in
  // range so the strip still works if the URL points at a date with no data yet.
  const dataDates = new Set();
  for (const s of Object.values(d.snapshots || {})) if (s.date) dataDates.add(s.date);
  for (const key of Object.keys((d.courts && d.courts.days) || {})) dataDates.add(key);
  dataDates.add(todayStr);
  dataDates.add(selectedDateStr);

  const sortedDates = [...dataDates].sort();
  const stripFirst = getWeekDays(fromDateStr(sortedDates[0]))[0];
  const stripLast = getWeekDays(fromDateStr(sortedDates[sortedDates.length - 1]))[6];

  const ribbonDays = [];
  for (let day = stripFirst; day <= stripLast; day = addDays(day, 1)) ribbonDays.push(day);

  const ribbonHtml = ribbonDays.map((day, i) => {
    const dStr = toDateStr(day);
    const isActive = dStr === selectedDateStr;
    const isToday = dStr === todayStr;
    const hasSlots = (slotsByDate[dStr] || []).length > 0;
    const dName = day.toLocaleDateString(undefined, { weekday: 'short' });
    const dNum = day.getDate();
    const weekGap = day.getDay() === 1 && i > 0 ? ' week-gap' : '';
    const fullLabel = day.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    return `
      <button class="day-ribbon-btn ${isActive ? 'active' : ''} ${isToday ? 'is-today' : ''}${weekGap}"
              onclick="selectDay('${dStr}')" title="${dName}, ${dStr}" aria-label="${fullLabel}"
              ${isActive ? 'aria-current="date"' : ''}>
        <span class="ribbon-day-name">${dName}</span>
        <span class="ribbon-day-val">${dNum}</span>
        ${hasSlots ? `<div class="ribbon-event-dot"></div>` : `<div style="height:6px; margin-top:2px;"></div>`}
      </button>
    `;
  }).join('');

  const daySlots = (slotsByDate[selectedDateStr] || []).sort((a, b) => a.time.localeCompare(b.time));
  const fullDateLabel = selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const slotDateLabel = selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const relLabel = getRelativeDateLabel(selectedDateStr);

  // The Open Courts panel normally leads the day. For events with a full roster
  // (10+ registered) it is more useful right after the waitlist, just before the
  // activity log, so it moves into the first such event card.
  const COURTS_INLINE_MIN_REG = 10;
  const courtsDayHtml = renderCourtsDay(d, selectedDateStr);
  const courtsSlotIdx = daySlots.findIndex((s) => count(s, 'reg') >= COURTS_INLINE_MIN_REG);

  let slotsHtml = '';
  if (!daySlots.length) {
    slotsHtml = `
      <div class="box-container" style="text-align:center; padding:48px 16px; margin-top:12px;">
        <span class="material-symbols-outlined" style="font-size:48px; color:#bdbdbd; margin-bottom:8px;">event_busy</span>
        <h3 style="margin:0 0 6px 0; color:var(--md-on-surface);">No events scheduled for this day</h3>
        <p style="color:var(--md-on-surface-variant); font-size:0.875rem; margin:0 0 16px 0;">Swipe left or right, or use the ribbon above, to browse nearby days.</p>
        <button class="nav-btn" onclick="navToday()"><span class="material-symbols-outlined" style="font-size:16px;">today</span> Go to Today</button>
      </div>
    `;
  } else {
    slotsHtml = daySlots.map((s, slotIdx) => {
      const courtsHere = slotIdx === courtsSlotIdx ? courtsDayHtml : '';
      const regNames = Object.entries(s.people)
        .filter(([, p]) => p.status === 'reg')
        .map(([n]) => n)
        .sort((a, b) => a.localeCompare(b));
      const waitNames = Object.entries(s.people)
        .filter(([, p]) => p.status === 'wait')
        .map(([n]) => n)
        .sort((a, b) => a.localeCompare(b));

      const uStatus = userStatus(s);
      const userBadgeHtml = userStatusBadgeHtml(uStatus);
      const regOpen = regCountdown(s).open;

      let dayCap = null, dayRem = null;
      if (s.events) for (const e of s.events) {
        if (e.capacity != null) dayCap = (dayCap || 0) + e.capacity;
        if (e.spotsRemaining != null) dayRem = (dayRem || 0) + e.spotsRemaining;
      }
      const dayOpenSpots = dayRem != null ? dayRem
        : dayCap != null ? Math.max(0, dayCap - regNames.length) : null;

      // Extend the roster to capacity so each open spot appears as a numbered blank row.
      const regEntries = withOpenSlots(regNames, dayOpenSpots);
      const entryHalf = Math.ceil(regEntries.length / 2);
      const entryCol1 = regEntries.slice(0, entryHalf);
      const entryCol2 = regEntries.slice(entryHalf);

      const makeList = (items, startIdx) => 
        `<ol class="people-list" start="${startIdx}">` +
        items.map((n) => n == null ? OPEN_SLOT_LI : `<li>${highlightName(n, s)}</li>`).join('') +
        `</ol>`;

      const regRosterHtml = regEntries.length 
        ? `<div class="roster-2col"><div>${makeList(entryCol1, 1)}</div><div>${entryCol2.length ? makeList(entryCol2, entryHalf + 1) : ''}</div></div>`
        : '<div class="empty-state">No registered participants yet</div>';

      const waitRosterHtml = waitNames.length
        ? `<ol class="people-list waitlist-list">${waitNames.map((n) => `<li>${highlightNameWaitlist(n, s)}</li>`).join('')}</ol>`
        : '<div class="empty-state">No one on the waitlist</div>';

      const slotLog = log.filter((l) => l.slot === s.key).slice(0, 50);
      let lastActivityDay = '';
      const ch = slotLog.map((l) => {
        const day = activityDayKey(l.ts);
        const separator = day !== lastActivityDay ? activityDaySeparator(l.ts) : '';
        lastActivityDay = day;
        return `${separator}
        <div class="row">
          <div class="row-main">
            <span class="action-chip ${cls(l.type)}">${renderIcon(l.type)} </span>
            <b>${esc(l.name)} </b> <span class="action-type">- ${esc(TEXT[l.type] || l.type)}</span>
          </div>
          <div class="time">${new Date(l.ts).toLocaleString()}</div>
        </div>`;
      }).join('') || '<div class="empty-state" style="padding:8px 0;">No changes yet</div>';

      // Merged events share the card, so they share one combined games estimate.
      const slotGames = slotGamesChipHtml(s);

      return `
        <div class="day-slot-card">
          <div class="day-slot-header">
            <div class="day-slot-title-group">
              <span class="day-slot-time">
                <span class="material-symbols-outlined">schedule</span>
                ${fmtTime(s.time)}
                <span style="font-size:0.78rem; font-weight:600; color:var(--md-on-surface); white-space:nowrap;">
                <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle; color:var(--md-primary);">calendar_month</span>
                ${slotDateLabel}
              </span>
              ${uStatus === 'reg' ? `<span class="user-status-badge registered" style="margin:0;font-size:0.7rem;padding:2px 6px;"><span class="material-symbols-outlined" style="font-size:12px;">check_circle</span> You're in</span>`
                : uStatus === 'wait' ? `<span class="user-status-badge waitlisted" style="margin:0;font-size:0.7rem;padding:2px 6px;"><span class="material-symbols-outlined" style="font-size:12px;">hourglass_empty</span> Waitlisted</span>`
                : regOpen ? `<a href="${eventUrl(firstEventNumber(s))}" target="_blank" rel="noopener" class="header-btn" style="padding:3px 8px; font-size:0.72rem; text-decoration:none; margin-left:8px;border-radius:6px;" title="Register on CourtReserve"><span class="material-symbols-outlined" style="font-size:14px;">how_to_reg</span> Register</a>`
                : `<span class="chip chip-countdown" style="font-size:0.68rem;cursor:default;"><span class="material-symbols-outlined" style="font-size:12px;">lock_clock</span> ${regCountdown(s).label}</span>`}
              <button class="watch-btn${watchedEvents.has(s.key) ? ' watching' : ''}" onclick="event.stopPropagation();toggleWatch('${esc(s.key)}')" title="Watch for changes"><span class="material-symbols-outlined">star</span></button></span>
              <div class="day-slot-events">${eventLinks(s)}</div>
              <div class="badges-row">
                <span class="chip chip-reg"><span class="material-symbols-outlined" style="font-size:13px">group</span> ${regNames.length} out of ${dayCap || '?'} registered</span>
                <span class="chip chip-wait"><span class="material-symbols-outlined" style="font-size:13px">hourglass_empty</span> ${waitNames.length} waitlist</span>
                ${dayOpenSpots != null ? (dayOpenSpots === 0 ? `<span class="chip chip-full"><span class="material-symbols-outlined" style="font-size:13px">block</span> Event FULL</span>` : `<span class="chip chip-open"><span class="material-symbols-outlined" style="font-size:13px">event_available</span> ${dayOpenSpots} spots open</span>`) : ''}
                ${slotGames}
              </div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0;">
              <span class="chip chip-relative" style="font-size:0.7rem;">
                <span class="material-symbols-outlined" style="font-size:12px;">event</span> ${relLabel}
              </span>
            </div>
          </div>
          <div class="day-slot-body">
            ${hasPerEventData(s)
              ? '<div class="event-grid event-grid-stacked" style="margin-top:0;">' + renderPerEventSections(s) + '</div>' + courtsHere
              : `<div class="event-grid event-grid-stacked" style="margin-top:0;">
              <div class="box-container">
                <div class="box-title"><span class="material-symbols-outlined" style="font-size:16px; color:#2e7d32">group</span> Registered (${regNames.length})</div>
                ${regRosterHtml}
              </div>
              <div class="box-container">
                <div class="box-title"><span class="material-symbols-outlined" style="font-size:16px; color:#ed6c02">hourglass_empty</span> Waitlist (${waitNames.length})</div>
                ${waitRosterHtml}
              </div>
            </div>
            ${courtsHere}`
            }
            <div class="box-container" style="margin-top:12px;">
              <div class="box-title"><span class="material-symbols-outlined" style="font-size:16px; color:#1976d2">history</span> Event Activity</div>
              ${ch}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  return `
    <div class="day-view-container">
      <div class="day-ribbon">
        ${ribbonHtml}
      </div>
      ${courtsSlotIdx === -1 ? courtsDayHtml : ''}
      ${slotsHtml}
    </div>
  `;
}

function renderActivityView(d) {
  const log = (d.log || []).filter((l) => l.type !== 'tracking').slice(0, 200);
  if (!log.length) {
    return `<div class="activity-view-container"><div class="box-container" style="text-align:center; padding:48px 16px;">
      <span class="material-symbols-outlined" style="font-size:48px; color:#bdbdbd; margin-bottom:8px;">history</span>
      <h3 style="margin:0 0 6px 0; color:var(--md-on-surface);">No activity recorded yet</h3>
      <p style="color:var(--md-on-surface-variant); font-size:0.875rem; margin:0;">Changes will appear here as the watcher detects them.</p>
    </div></div>`;
  }

  // Short verbs keep the compact activity rows on one line (the icon carries the direction).
  const SHORT = {
    'waitlist-joined': 'waitlist',
    'waitlist-left': 'left waitlist',
    promoted: 'promoted',
    demoted: 'demoted',
    removed: 'unlisted',
  };

  // Group rows by the day the change was detected so dates are easy to scan.
  let lastDay = '';
  const rows = log.map((l) => {
    const tone = cls(l.type) === 'j' ? '#2e7d32' : cls(l.type) === 'l' ? '#c62828' : '#ed6c02';
    const meta = [l.label, l.ev].filter(Boolean).join(' \u00b7 ');
    const day = activityDayKey(l.ts);
    const separator = day !== lastDay ? activityDaySeparator(l.ts) : '';
    lastDay = day;
    return `
    ${separator}
    <div class="activity-log-row">
      <span class="act-icon material-symbols-outlined" style="color:${tone}">${ICON[l.type] || 'info'}</span>
      <span class="act-name">${esc(l.name)}</span>
      <span class="action-chip ${cls(l.type)}">${esc(SHORT[l.type] || TEXT[l.type] || l.type)}</span>
      <span class="act-meta" title="${esc(meta)}">${esc(meta)}</span>
      <span class="act-time">${new Date(l.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
    </div>
  `;
  }).join('');

  return `
    <div class="section-title"><span class="material-symbols-outlined">history</span> Recent Activity (Last ${log.length} changes)</div>
    <div class="activity-view-container">
      <div class="activity-log-card">${rows}</div>
    </div>
  `;
}

function render(d) {
  // Init user name input
  const nameInput = document.getElementById('userNameInput');
  if (nameInput && !nameInput.dataset.bound) {
    nameInput.dataset.bound = '1';
    nameInput.value = userName;
    if (userName) document.getElementById('userNameCheck').style.display = '';
    nameInput.addEventListener('blur', () => setUserName(nameInput.value));
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { setUserName(nameInput.value); nameInput.blur(); } });
  }

  // Init welcome display and edit button
  const editBtn = document.querySelector('.edit-name-btn');
  if (editBtn && !editBtn.dataset.bound) {
    editBtn.dataset.bound = '1';
    editBtn.addEventListener('click', () => {
      document.getElementById('userNameDisplay').classList.remove('visible');
      document.getElementById('userNameInputWrap').classList.add('visible');
      document.getElementById('userNameInput').focus();
    });
  }

  // Set initial display state
  updateNameDisplay();

  currentData = d;
  initDateIfNeeded(d);
  renderCurrentView();

  // Keep an open court timeline in sync with refreshed data (poll reloads every 60s)
  if (courtsModalDate) {
    if (currentView === 'day') renderCourtsModal();
    else closeCourtsModal();
  }

  // Same for the participant sheet: pick up the newest id/barcode from the refreshed snapshot.
  if (personSheet) renderPersonSheet();

  checkWatchedChanges(d);

  const updatedTs = d.updated || d.lastRun || d.uploadedAt;
  document.getElementById('status').innerHTML = updatedTs 
    ? `<span class="material-symbols-outlined" style="font-size:12px">check_circle</span> Updated ${new Date(updatedTs).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}` 
    : '';
}


// ── Day view swipe navigation ──
// One gesture handles touch, pen, mouse drags and horizontal trackpad scrolls, and moves the
// selected day by one. Text fields are left alone so typing and caret placement keep working;
// anywhere else a horizontal swipe wins over the link/button under the finger.
const SWIPE_MIN_DISTANCE = 56;   // px the finger/mouse must travel
const SWIPE_MIN_VELOCITY = 0.4;  // px per ms, a quick flick counts even when short
const WHEEL_SWIPE_ACCUM = 72;    // summed horizontal wheel delta before changing day
const DAY_NAV_COOLDOWN = 240;    // ms between day changes, prevents double-fire
const TEXT_INPUT_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

let dayNavCooldownUntil = 0;
let wheelAccum = 0;
let wheelResetTimer = null;
let suppressClickUntil = 0;

// A swipe often ends on top of a link or button; swallow the click it would otherwise fire.
document.addEventListener('click', (event) => {
  if (performance.now() < suppressClickUntil) {
    event.preventDefault();
    event.stopPropagation();
  }
}, true);

function navigateDay(direction) {
  if (currentView !== 'day') return;
  const now = performance.now();
  if (now < dayNavCooldownUntil) return;
  dayNavCooldownUntil = now + DAY_NAV_COOLDOWN;
  if (direction === 'prev') navPrev(); else navNext();
}

function attachSwipeHandlers() {
  const container = document.getElementById('viewContainer');
  if (!container || container.dataset.swipeBound === currentView) return;
  container.dataset.swipeBound = currentView;

  const surface = container.querySelector('.day-view-container');
  if (!surface) return;

  let drag = null;

  const resetSurface = () => {
    if (drag) return; // a new gesture took over while the old one was settling
    surface.style.transition = '';
    surface.style.transform = '';
    surface.classList.remove('is-swiping');
  };

  // Ease the content back into place when the gesture was too small to change the day.
  const settle = () => {
    surface.style.transition = 'transform 0.18s ease';
    surface.style.transform = '';
    surface.addEventListener('transitionend', resetSurface, { once: true });
    setTimeout(resetSurface, 260);
  };

  container.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // The ribbon scrolls on its own; leave its gestures to the browser.
    if (event.target.closest('.day-ribbon')) return;
    if (event.target.closest(TEXT_INPUT_SELECTOR)) return;
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      axis: null,
    };
  });

  container.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;

    // Decide once whether this is a horizontal swipe or a normal vertical scroll.
    if (!drag.axis) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      if (drag.axis === 'x') {
        try { container.setPointerCapture(event.pointerId); } catch { /* not supported */ }
        surface.style.transition = 'none';
        surface.classList.add('is-swiping');
        suppressClickUntil = performance.now() + 400;
      }
    }
    if (drag.axis !== 'x') return;

    event.preventDefault();
    const offset = Math.max(-90, Math.min(90, dx * 0.4));
    surface.style.transform = `translateX(${offset}px)`;
  });

  const endDrag = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const gesture = drag;
    drag = null;
    if (gesture.axis !== 'x') { resetSurface(); return; }

    const dx = event.clientX - gesture.x;
    const elapsed = Math.max(1, performance.now() - gesture.time);
    const fastEnough = Math.abs(dx) / elapsed > SWIPE_MIN_VELOCITY && Math.abs(dx) > 24;
    const changed = Math.abs(dx) > SWIPE_MIN_DISTANCE || fastEnough;

    if (!changed) { settle(); return; }
    resetSurface();
    navigateDay(dx > 0 ? 'prev' : 'next');
  };

  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', () => {
    if (!drag) return;
    drag = null;
    settle();
  });

  // Trackpads report horizontal swipes as wheel deltas, not pointer events.
  container.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return; // pinch-zoom
    if (event.target.closest('.day-ribbon')) return; // the strip scrolls itself
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    if (performance.now() < dayNavCooldownUntil) return;

    wheelAccum += event.deltaX;
    clearTimeout(wheelResetTimer);
    wheelResetTimer = setTimeout(() => { wheelAccum = 0; }, 150);

    if (Math.abs(wheelAccum) < WHEEL_SWIPE_ACCUM) return;
    const direction = wheelAccum > 0 ? 'prev' : 'next';
    wheelAccum = 0;
    navigateDay(direction);
  }, { passive: false });
}

// Arrow keys do the same on desktop, as long as the user is not typing and no overlay is open.
document.addEventListener('keydown', (event) => {
  if (currentView !== 'day' || courtsModalDate || personSheet) return;
  if (document.body.classList.contains('nav-open') || document.querySelector('dialog[open]')) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (event.target.closest && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    navigateDay('prev');
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    navigateDay('next');
  }
});


async function load() {
  const app = document.getElementById('app');
  
  if (!src) { 
    app.innerHTML = '<div class="err">Set DATA_URL in this file or open with ?src=&lt;url to state.json&gt;</div>'; 
    return; 
  }
  
  try {
    const r = await fetch(`${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    render(await r.json());
  } catch (e) { 
    app.innerHTML = `<div class="err">Failed to load data: ${esc(e.message)} (check bucket CORS / URL)</div>`; 
  } finally {
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  syncNotifyButton(); // the user may have changed the site permission outside the app
  load();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (courtsModalDate) closeCourtsModal();
  else if (personSheet) closePersonSheet();
});
setInterval(load, 60000);
syncNotifyButton();
load();
showNamePrompt();
