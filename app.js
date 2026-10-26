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

const open = new Set();
let currentData = null;
let currentView = (() => {
  const saved = localStorage.getItem('crw_view');
  if (saved) return saved;
  return window.innerWidth < 768 ? 'day' : 'week';
})();
let selectedDate = new Date();
let dateInitialized = false;

// ── User name ──
let userName = localStorage.getItem('crw_user_name') || '';
function setUserName(name) {
  userName = name.trim();
  localStorage.setItem('crw_user_name', userName);
  const input = document.getElementById('userNameInput');
  const check = document.getElementById('userNameCheck');
  if (input) input.value = userName;
  if (check) check.style.display = userName ? '' : 'none';
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
function highlightName(name) {
  if (!userName) return esc(name);
  if (name.toLowerCase().trim() === userName.toLowerCase().trim()) return `<span class="user-match">${esc(name)}</span>`;
  return esc(name);
}
function highlightNameWaitlist(name) {
  if (!userName) return esc(name);
  if (name.toLowerCase().trim() === userName.toLowerCase().trim()) return `<span class="user-match-waitlist">${esc(name)}</span>`;
  return esc(name);
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
    const half = Math.ceil(regNames.length / 2);
    const col1 = regNames.slice(0, half);
    const col2 = regNames.slice(half);

    const makeList = (items, startIdx, hlFn) =>
      '<ol class="people-list" start="' + startIdx + '">' +
      items.map((n) => '<li>' + hlFn(n) + '</li>').join('') +
      '</ol>';

    const regHtml = regNames.length
      ? '<div class="roster-2col"><div>' + makeList(col1, 1, highlightName) + '</div><div>' + (col2.length ? makeList(col2, half + 1, highlightName) : '') + '</div></div>'
      : '<div class="empty-state">No registered participants yet</div>';

    const waitHtml = waitNames.length
      ? '<ol class="people-list waitlist-list">' + waitNames.map((n) => '<li>' + highlightNameWaitlist(n) + '</li>').join('') + '</ol>'
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
// ── Registration window countdown ──
function getDaysUntilRegOpens(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const eventDate = new Date(y, m - 1, d);
  const regOpenDate = new Date(eventDate);
  regOpenDate.setDate(regOpenDate.getDate() - 14);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  regOpenDate.setHours(0, 0, 0, 0);
  const diffMs = regOpenDate - today;
  return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
}

function regCountdownHtml(dateStr) {
  const days = getDaysUntilRegOpens(dateStr);
  if (days <= 0) return '';
  const label = days === 0 ? 'Opens today' : days === 1 ? 'Opens tomorrow' : `Opens in ${days} days`;
  return `<span class="chip chip-countdown"><span class="material-symbols-outlined" style="font-size:13px;">lock_clock</span> ${label}</span>`;
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

// ── Event data helpers (events are now {name, number} objects) ──
function eventNames(snapshot) {
  return (snapshot.events || []).map(e => typeof e === 'string' ? e : e.name);
}
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

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

function formatWeekRange(weekDays) {
  const start = weekDays[0];
  const end = weekDays[6];
  if (start.getFullYear() === end.getFullYear()) {
    if (start.getMonth() === end.getMonth()) {
      return `${start.toLocaleDateString(undefined, { month: 'short' })} ${start.getDate()} – ${end.getDate()}, ${start.getFullYear()}`;
    }
    return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`;
  }
  return `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} – ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
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
  currentView = view;
  localStorage.setItem('crw_view', view);
  renderCurrentView();
  // Attach swipe handlers when entering day view
  if (view === 'day') setTimeout(attachSwipeHandlers, 100);
}

function navToday() {
  selectedDate = new Date();
  renderCurrentView();
}

function navPrev() {
  if (currentView === 'day') {
    selectedDate.setDate(selectedDate.getDate() - 1);
  } else {
    selectedDate.setDate(selectedDate.getDate() - 7);
  }
  renderCurrentView();
}

function navNext() {
  if (currentView === 'day') {
    selectedDate.setDate(selectedDate.getDate() + 1);
  } else {
    selectedDate.setDate(selectedDate.getDate() + 7);
  }
  renderCurrentView();
}

function selectDay(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  selectedDate = new Date(y, m - 1, d);
  currentView = 'day';
  localStorage.setItem('crw_view', 'day');
  renderCurrentView();
}

function renderCurrentView() {
  if (!currentData) return;
  const app = document.getElementById('app');

  let titleStr = '';
  const weekDays = getWeekDays(selectedDate);
  if (currentView === 'week') {
    titleStr = formatWeekRange(weekDays);
  } else if (currentView === 'day') {
    titleStr = selectedDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  } else if (currentView === 'activity') {
    titleStr = 'All Activity';
  } else {
    titleStr = 'All Tracked Events';
  }

  let viewHtml = '';
  if (currentView === 'week') {
    viewHtml = renderWeekView(currentData);
  } else if (currentView === 'day') {
    viewHtml = renderDayView(currentData);
  } else if (currentView === 'activity') {
    viewHtml = renderActivityView(currentData);
  } else {
    viewHtml = renderListView(currentData);
  }

  app.innerHTML = `
    <div class="nav-toolbar">
      <div class="view-segmented-btn">
        <button id="seg-week" class="seg-btn ${currentView === 'week' ? 'active' : ''}" onclick="setView('week')">
          <span class="material-symbols-outlined" style="font-size:18px;">calendar_view_week</span>
          <span class="seg-label">Week</span>
        </button>
        <button id="seg-day" class="seg-btn ${currentView === 'day' ? 'active' : ''}" onclick="setView('day')">
          <span class="material-symbols-outlined" style="font-size:18px;">calendar_view_day</span>
          <span class="seg-label">Day</span>
        </button>
        <button id="seg-list" class="seg-btn ${currentView === 'list' ? 'active' : ''}" onclick="setView('list')">
          <span class="material-symbols-outlined" style="font-size:18px;">format_list_bulleted</span>
          <span class="seg-label">List</span>
        </button>
        <button id="seg-activity" class="seg-btn ${currentView === 'activity' ? 'active' : ''}" onclick="setView('activity')">
          <span class="material-symbols-outlined" style="font-size:18px;">history</span>
          <span class="seg-label">Activity</span>
        </button>
      </div>

      <div class="date-nav-controls" id="dateNavControls" style="${currentView === 'list' || currentView === 'activity' ? 'display:none;' : ''}">
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

  if (currentView === 'day') setTimeout(attachSwipeHandlers, 150);
}

function renderWeekView(d) {
  const weekDays = getWeekDays(selectedDate);
  const todayStr = toDateStr(new Date());

  const slotsByDate = {};
  for (const s of Object.values(d.snapshots)) {
    if (!slotsByDate[s.date]) slotsByDate[s.date] = [];
    slotsByDate[s.date].push(s);
  }

  const log = (d.log || []).filter((l) => l.type !== 'tracking');
  const last = {};
  log.forEach((l) => { if (!(l.slot in last)) last[l.slot] = l.ts; });
  const latest = Object.keys(last).filter((k) => d.snapshots[k]).sort((a, b) => last[b] - last[a])[0];

  const colsHtml = weekDays.map((day) => {
    const dateStr = toDateStr(day);
    const isToday = dateStr === todayStr;
    const daySlots = (slotsByDate[dateStr] || []).sort((a, b) => a.time.localeCompare(b.time));
    const dayName = day.toLocaleDateString(undefined, { weekday: 'short' });
    const dayNum = day.getDate();

    let contentHtml = '';
    if (!daySlots.length) {
      contentHtml = `<div class="cal-empty-col">No events</div>`;
    } else {
      contentHtml = daySlots.map((s) => {
        const isLatest = s.key === latest;
        const regNames = Object.entries(s.people)
          .filter(([, p]) => p.status === 'reg')
          .map(([n]) => n)
          .sort((a, b) => a.localeCompare(b));
        const waitNames = Object.entries(s.people)
          .filter(([, p]) => p.status === 'wait')
          .map(([n]) => n)
          .sort((a, b) => a.localeCompare(b));

        let weekCap = null, weekRem = null;
        if (s.events) for (const e of s.events) {
          if (e.capacity != null) weekCap = (weekCap || 0) + e.capacity;
          if (e.spotsRemaining != null) weekRem = (weekRem || 0) + e.spotsRemaining;
        }
        const openSpots = weekRem != null ? weekRem
          : weekCap != null ? Math.max(0, weekCap - regNames.length) : null;

        const wStatus = userStatus(s);
        const regOpen = getDaysUntilRegOpens(s.date) <= 0;

        return `
          <div class="cal-event-card ${isLatest ? 'latest-card' : ''}">
            <div class="cal-event-header">
              <div class="cal-event-time-row">
                <span class="cal-event-time">
                  <span class="material-symbols-outlined" style="font-size:16px;">schedule</span>
                  ${fmtTime(s.time)}
                </span>
                ${wStatus === 'reg' ? `<span class="user-status-badge registered" style="margin:0;font-size:0.68rem;padding:2px 6px;"><span class="material-symbols-outlined" style="font-size:12px;">check_circle</span> You're in</span>`
                  : wStatus === 'wait' ? `<span class="user-status-badge waitlisted" style="margin:0;font-size:0.68rem;padding:2px 6px;"><span class="material-symbols-outlined" style="font-size:12px;">hourglass_empty</span> Waitlisted</span>`
                  : regOpen ? `<a href="${eventUrl(firstEventNumber(s))}" target="_blank" rel="noopener" class="header-btn" style="padding:3px 8px; font-size:0.72rem; text-decoration:none;border-radius:6px;" title="Register on CourtReserve"><span class="material-symbols-outlined" style="font-size:14px;">how_to_reg</span> Register</a>`
                  : `<span class="chip chip-countdown" style="font-size:0.68rem;cursor:default;"><span class="material-symbols-outlined" style="font-size:12px;">lock_clock</span> ${getDaysUntilRegOpens(s.date) === 0 ? 'Opens today' : getDaysUntilRegOpens(s.date) === 1 ? 'Opens tomorrow' : `Opens ${getDaysUntilRegOpens(s.date)}d`}</span>`}
                ${isLatest ? `<span class="cal-badge cal-badge-latest"><span class="material-symbols-outlined" style="font-size:12px">update</span> New</span>` : ''}
              </div>
              <div class="cal-event-title">${eventLinks(s)}</div>
              <div class="cal-badges-row">
                <span class="cal-badge cal-badge-reg"><span class="material-symbols-outlined" style="font-size:12px">group</span> ${regNames.length} reg</span>
                <span class="cal-badge cal-badge-wait"><span class="material-symbols-outlined" style="font-size:12px">hourglass_empty</span> ${waitNames.length} wait</span>
                ${openSpots != null ? (openSpots === 0 ? `<span class="cal-badge cal-badge-full"><span class="material-symbols-outlined" style="font-size:12px">block</span> Full</span>` : `<span class="cal-badge cal-badge-open"><span class="material-symbols-outlined" style="font-size:12px">event_available</span> ${openSpots} open</span>`) : ''}
              </div>
            </div>

            <!-- Participant & Waitlist Roster Preview -->
            <div class="cal-roster-section">
              <div class="cal-roster-title">
                <span><span class="material-symbols-outlined" style="font-size:13px; color:#2e7d32; vertical-align:middle;">group</span> Registered (${regNames.length})</span>
              </div>
              ${regNames.length 
                ? `<ol class="cal-roster-list">${regNames.map((n) => `<li>${highlightName(n)}</li>`).join('')}</ol>`
                : `<div class="empty-state" style="font-size:0.75rem; padding:4px 0;">None</div>`
              }

              ${waitNames.length ? `
                <div class="cal-roster-title" style="margin-top:8px;">
                  <span><span class="material-symbols-outlined" style="font-size:13px; color:#ed6c02; vertical-align:middle;">hourglass_empty</span> Waitlist (${waitNames.length})</span>
                </div>
                <ol class="cal-roster-list waitlist-list">${waitNames.map((n) => `<li>${highlightNameWaitlist(n)}</li>`).join('')}</ol>
              ` : ''}
            </div>
</div>
        `;
      }).join('');
    }

    return `
      <div class="week-day-col ${isToday ? 'is-today' : ''}">
        <div class="week-col-header" onclick="selectDay('${dateStr}')" title="Click to view full day details">
          <span class="week-day-name">${dayName}</span>
          <span class="week-day-num">${dayNum}</span>
          ${isToday ? `<span class="chip chip-reg" style="font-size:0.65rem; padding:1px 6px;">Today</span>` : ''}
          ${daySlots.length ? `<span class="week-col-badge">${daySlots.length} ${daySlots.length === 1 ? 'event' : 'events'}</span>` : ''}
        </div>
        <div class="week-col-content">
          ${contentHtml}
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="calendar-week-container">
      <div class="calendar-week-grid">
        ${colsHtml}
      </div>
    </div>
  `;
}

function renderDayView(d) {
  const weekDays = getWeekDays(selectedDate);
  const selectedDateStr = toDateStr(selectedDate);
  const todayStr = toDateStr(new Date());

  const log = (d.log || []).filter((l) => l.type !== 'tracking');

  const slotsByDate = {};
  for (const s of Object.values(d.snapshots)) {
    if (!slotsByDate[s.date]) slotsByDate[s.date] = [];
    slotsByDate[s.date].push(s);
  }

  const ribbonHtml = weekDays.map((day) => {
    const dStr = toDateStr(day);
    const isActive = dStr === selectedDateStr;
    const isToday = dStr === todayStr;
    const hasSlots = (slotsByDate[dStr] || []).length > 0;
    const dName = day.toLocaleDateString(undefined, { weekday: 'short' });
    const dNum = day.getDate();

    return `
      <button class="day-ribbon-btn ${isActive ? 'active' : ''} ${isToday ? 'is-today' : ''}" onclick="selectDay('${dStr}')" title="${dName}, ${dStr}">
        <span class="ribbon-day-name">${dName}</span>
        <span class="ribbon-day-val">${dNum}</span>
        ${hasSlots ? `<div class="ribbon-event-dot"></div>` : `<div style="height:6px; margin-top:2px;"></div>`}
      </button>
    `;
  }).join('');

  const daySlots = (slotsByDate[selectedDateStr] || []).sort((a, b) => a.time.localeCompare(b.time));
  const fullDateLabel = selectedDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const slotDateLabel = selectedDate.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const relLabel = getRelativeDateLabel(selectedDateStr);

  let slotsHtml = '';
  if (!daySlots.length) {
    slotsHtml = `
      <div class="box-container" style="text-align:center; padding:48px 16px; margin-top:12px;">
        <span class="material-symbols-outlined" style="font-size:48px; color:#bdbdbd; margin-bottom:8px;">event_busy</span>
        <h3 style="margin:0 0 6px 0; color:var(--md-on-surface);">No events scheduled for this day</h3>
        <p style="color:var(--md-on-surface-variant); font-size:0.875rem; margin:0 0 16px 0;">Use the ribbon above or arrows to navigate to dates with events.</p>
        <button class="nav-btn" onclick="navToday()"><span class="material-symbols-outlined" style="font-size:16px;">today</span> Go to Today</button>
      </div>
    `;
  } else {
    slotsHtml = daySlots.map((s) => {
      const regNames = Object.entries(s.people)
        .filter(([, p]) => p.status === 'reg')
        .map(([n]) => n)
        .sort((a, b) => a.localeCompare(b));
      const waitNames = Object.entries(s.people)
        .filter(([, p]) => p.status === 'wait')
        .map(([n]) => n)
        .sort((a, b) => a.localeCompare(b));

      const half = Math.ceil(regNames.length / 2);
      const col1 = regNames.slice(0, half);
      const col2 = regNames.slice(half);
      const uStatus = userStatus(s);
      const userBadgeHtml = userStatusBadgeHtml(uStatus);
      const regOpen = getDaysUntilRegOpens(s.date) <= 0;

      let dayCap = null, dayRem = null;
      if (s.events) for (const e of s.events) {
        if (e.capacity != null) dayCap = (dayCap || 0) + e.capacity;
        if (e.spotsRemaining != null) dayRem = (dayRem || 0) + e.spotsRemaining;
      }
      const dayOpenSpots = dayRem != null ? dayRem
        : dayCap != null ? Math.max(0, dayCap - regNames.length) : null;

      const makeList = (items, startIdx, hlFn) => 
        `<ol class="people-list" start="${startIdx}">` +
        items.map((n) => `<li>${hlFn(n)}</li>`).join('') +
        `</ol>`;

      const regRosterHtml = regNames.length 
        ? `<div class="roster-2col"><div>${makeList(col1, 1, highlightName)}</div><div>${col2.length ? makeList(col2, half + 1, highlightName) : ''}</div></div>`
        : '<div class="empty-state">No registered participants yet</div>';

      const waitRosterHtml = waitNames.length
        ? `<ol class="people-list waitlist-list">${waitNames.map((n) => `<li>${highlightNameWaitlist(n)}</li>`).join('')}</ol>`
        : '<div class="empty-state">No one on the waitlist</div>';

      const ch = log.filter((l) => l.slot === s.key).slice(0, 50).map((l) =>
        `<div class="row">
          <div class="row-main">
            <span class="action-chip ${cls(l.type)}">${renderIcon(l.type)} ${esc(TEXT[l.type] || l.type)}</span>
            <b>${esc(l.name)}</b>
          </div>
          <div class="time">${new Date(l.ts).toLocaleString()}</div>
        </div>`).join('') || '<div class="empty-state" style="padding:8px 0;">No changes yet</div>';

      return `
        <div class="day-slot-card">
          <div class="day-slot-header">
            <div class="day-slot-title-group">
              <span class="day-slot-time">
                <span class="material-symbols-outlined">schedule</span>
                ${fmtTime(s.time)}
              ${uStatus === 'reg' ? `<span class="user-status-badge registered" style="margin:0;font-size:0.7rem;padding:2px 6px;"><span class="material-symbols-outlined" style="font-size:12px;">check_circle</span> You're in</span>`
                : uStatus === 'wait' ? `<span class="user-status-badge waitlisted" style="margin:0;font-size:0.7rem;padding:2px 6px;"><span class="material-symbols-outlined" style="font-size:12px;">hourglass_empty</span> Waitlisted</span>`
                : regOpen ? `<a href="${eventUrl(firstEventNumber(s))}" target="_blank" rel="noopener" class="header-btn" style="padding:3px 8px; font-size:0.72rem; text-decoration:none; margin-left:8px;border-radius:6px;" title="Register on CourtReserve"><span class="material-symbols-outlined" style="font-size:14px;">how_to_reg</span> Register</a>`
                : `<span class="chip chip-countdown" style="font-size:0.68rem;cursor:default;"><span class="material-symbols-outlined" style="font-size:12px;">lock_clock</span> ${getDaysUntilRegOpens(s.date) === 0 ? 'Opens today' : getDaysUntilRegOpens(s.date) === 1 ? 'Opens tomorrow' : `Opens ${getDaysUntilRegOpens(s.date)}d`}</span>`}</span>
              <div class="day-slot-events">${eventLinks(s)}</div>
              <div class="badges-row">
                <span class="chip chip-reg"><span class="material-symbols-outlined" style="font-size:13px">group</span> ${regNames.length} out of ${dayCap || '?'} registered</span>
                <span class="chip chip-wait"><span class="material-symbols-outlined" style="font-size:13px">hourglass_empty</span> ${waitNames.length} waitlist</span>
                ${dayOpenSpots != null ? (dayOpenSpots === 0 ? `<span class="chip chip-full"><span class="material-symbols-outlined" style="font-size:13px">block</span> Event FULL</span>` : `<span class="chip chip-open"><span class="material-symbols-outlined" style="font-size:13px">event_available</span> ${dayOpenSpots} spots open</span>`) : ''}
              </div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0;">
              <span style="font-size:0.78rem; font-weight:600; color:var(--md-on-surface); white-space:nowrap;">
                <span class="material-symbols-outlined" style="font-size:14px; vertical-align:middle; color:var(--md-primary);">calendar_month</span>
                ${slotDateLabel}
              </span>
              <span class="chip chip-relative" style="font-size:0.7rem;">
                <span class="material-symbols-outlined" style="font-size:12px;">event</span> ${relLabel}
              </span>
            </div>
          </div>
          <div class="day-slot-body">
            ${hasPerEventData(s)
              ? '<div class="event-grid event-grid-stacked" style="margin-top:0;">' + renderPerEventSections(s) + '</div>'
              : `<div class="event-grid event-grid-stacked" style="margin-top:0;">
              <div class="box-container">
                <div class="box-title"><span class="material-symbols-outlined" style="font-size:16px; color:#2e7d32">group</span> Registered (${regNames.length})</div>
                ${regRosterHtml}
              </div>
              <div class="box-container">
                <div class="box-title"><span class="material-symbols-outlined" style="font-size:16px; color:#ed6c02">hourglass_empty</span> Waitlist (${waitNames.length})</div>
                ${waitRosterHtml}
              </div>
            </div>`
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
      ${slotsHtml}
    </div>
  `;
}

function renderListView(d) {
  const log = (d.log || []).filter((l) => l.type !== 'tracking');
  const last = {};
  log.forEach((l) => { if (!(l.slot in last)) last[l.slot] = l.ts; });
  const latest = Object.keys(last).filter((k) => d.snapshots[k]).sort((a, b) => last[b] - last[a])[0];

  const renderRegRoster = (s) => {
    const names = Object.entries(s.people)
      .filter(([, p]) => p.status === 'reg')
      .map(([n]) => n)
      .sort((a, b) => a.localeCompare(b));
    if (!names.length) return '<div class="empty-state">None</div>';
    const half = Math.ceil(names.length / 2);
    const col1 = names.slice(0, half);
    const col2 = names.slice(half);
    const makeList = (items, startIdx) =>
      `<ol class="people-list" start="${startIdx}">` +
      items.map((n) => `<li>${highlightName(n)}</li>`).join('') +
      `</ol>`;
    return `<div class="roster-2col"><div>${makeList(col1, 1)}</div><div>${col2.length ? makeList(col2, half + 1) : ''}</div></div>`;
  };

  const renderWaitlist = (s) => {
    const names = Object.entries(s.people)
      .filter(([, p]) => p.status === 'wait')
      .map(([n]) => n)
      .sort((a, b) => a.localeCompare(b));
    if (!names.length) return '<div class="empty-state">None</div>';
    return `<ol class="people-list">` + names.map((n) => `<li>${highlightNameWaitlist(n)}</li>`).join('') + `</ol>`;
  };

  const sortedSlots = Object.values(d.snapshots).sort((a, b) => a.key.localeCompare(b.key));

  let lastDate = '';
  const slotsHtml = sortedSlots.map((s) => {
    const showDateHeader = s.date !== lastDate;
    lastDate = s.date;
    const relLabel = getRelativeDateLabel(s.date);
    const uStatus = userStatus(s);
    const userBadgeHtml = userStatusBadgeHtml(uStatus);
    const regOpen = getDaysUntilRegOpens(s.date) <= 0;

    let listCap = null, listRem = null;
    if (s.events) for (const e of s.events) {
      if (e.capacity != null) listCap = (listCap || 0) + e.capacity;
      if (e.spotsRemaining != null) listRem = (listRem || 0) + e.spotsRemaining;
    }
    const listOpenSpots = listRem != null ? listRem
      : listCap != null ? Math.max(0, listCap - count(s, 'reg')) : null;

    const ch = log.filter((l) => l.slot === s.key).slice(0, 50).map((l) =>
      `<div class="row">
        <div class="row-main">
          <span class="action-chip ${cls(l.type)}">${renderIcon(l.type)} ${esc(TEXT[l.type] || l.type)}</span>
          <b>${esc(l.name)}</b>
        </div>
        <div class="time">${new Date(l.ts).toLocaleString()}</div>
      </div>`).join('') || '<div class="empty-state" style="padding:8px 0;">No changes yet</div>';

    const cardHtml = `<details class="card ${s.key === latest ? 'latest' : ''}" data-key="${esc(s.key)}" ${open.has(s.key) || s.key === latest ? 'open' : ''}>
      <summary>
        <div class="summary-header">
          <span class="summary-title">
            <span class="material-symbols-outlined" style="color:var(--md-primary)">schedule</span>
            ${fmtTime(s.time)}
          ${uStatus === 'reg' ? `<span class="user-status-badge registered" style="margin:0;font-size:0.68rem;padding:2px 6px;"><span class="material-symbols-outlined" style="font-size:12px;">check_circle</span> You're in</span>`
            : uStatus === 'wait' ? `<span class="user-status-badge waitlisted" style="margin:0;font-size:0.68rem;padding:2px 6px;"><span class="material-symbols-outlined" style="font-size:12px;">hourglass_empty</span> Waitlisted</span>`
            : regOpen ? `<a href="${eventUrl(firstEventNumber(s))}" target="_blank" rel="noopener" class="header-btn" style="padding:3px 8px; font-size:0.72rem; text-decoration:none; margin-left:6px;border-radius:6px;" title="Register on CourtReserve" onclick="event.stopPropagation();"><span class="material-symbols-outlined" style="font-size:14px;">how_to_reg</span> Register</a>`
            : `<span class="chip chip-countdown" style="font-size:0.68rem;cursor:default;"><span class="material-symbols-outlined" style="font-size:12px;">lock_clock</span> ${getDaysUntilRegOpens(s.date) === 0 ? 'Opens today' : getDaysUntilRegOpens(s.date) === 1 ? 'Opens tomorrow' : `Opens ${getDaysUntilRegOpens(s.date)}d`}</span>`}</span>
          <span class="material-symbols-outlined expand-icon">expand_more</span>
        </div>
        <div class="badges-row">
          <span class="chip chip-relative"><span class="material-symbols-outlined" style="font-size:13px">event</span> ${relLabel}</span>
          <span class="chip chip-reg">${count(s, 'reg')} out of ${listCap || '?'} registered</span>
          <span class="chip chip-wait">${count(s, 'wait')} waitlist</span>
          ${listOpenSpots != null ? (listOpenSpots === 0 ? `<span class="chip chip-full"><span class="material-symbols-outlined" style="font-size:13px">block</span>Event FULL</span>` : `<span class="chip chip-open"><span class="material-symbols-outlined" style="font-size:13px">event_available</span> ${listOpenSpots} spots open</span>`) : ''}
          ${s.key === latest ? `<span class="chip chip-latest"><span class="material-symbols-outlined" style="font-size:14px">update</span> Last updated ${new Date(last[s.key]).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>` : ''}
          
        </div>
        <div class="event-subtitle">${eventLinks(s)}</div>
      </summary>
      <div class="card-body">
        ${hasPerEventData(s)
          ? renderPerEventSections(s) + `
          <!-- Activity Per Event -->
          <div class="box-container">
            <div class="box-title"><span class="material-symbols-outlined" style="font-size:16px; color:#1976d2">history</span> Event Activity</div>
            ${ch}
          </div>
        </div>`
          : `<div class="event-grid event-grid-stacked">
          <!-- Registered Roster -->
          <div class="box-container">
            <div class="box-title"><span class="material-symbols-outlined" style="font-size:16px; color:#2e7d32">group</span> Registered (${count(s, 'reg')})</div>
            ${renderRegRoster(s)}
          </div>

          <!-- Waitlist -->
          <div class="box-container">
            <div class="box-title"><span class="material-symbols-outlined" style="font-size:16px; color:#ed6c02">hourglass_empty</span> Waitlist (${count(s, 'wait')})</div>
            ${renderWaitlist(s)}
          </div>

          <!-- Activity Per Event -->
          <div class="box-container">
            <div class="box-title"><span class="material-symbols-outlined" style="font-size:16px; color:#1976d2">history</span> Event Activity</div>
            ${ch}
          </div>`
        }
      </div>
    </details>`;

    if (showDateHeader) {
      const formattedDate = new Date(`${s.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
      return `
        <div class="date-group-header">
          <span class="material-symbols-outlined" style="font-size:16px">calendar_month</span>
          ${formattedDate} (${relLabel})
        </div>
        ${cardHtml}
      `;
    }
    return cardHtml;
  }).join('') || '<div class="card" style="padding:16px;">No tracked events found.</div>';

  const full = log.slice(0, 300).map((l) =>
    `<div class="row">
      <div class="row-main">
        <span class="action-chip ${cls(l.type)}">${renderIcon(l.type)} ${esc(TEXT[l.type] || l.type)}</span>
        <b>${esc(l.name)}</b>
      </div>
      <div class="time">${esc(l.label)} \u00b7 ${esc(l.ev)} \u00b7 ${new Date(l.ts).toLocaleString()}</div>
    </div>`).join('') || '<div class="empty-state" style="padding:8px 0;">No changes recorded yet.</div>';

  return `
    <div class="section-title"><span class="material-symbols-outlined">event_upcoming</span> Tracked Events</div>
    ${slotsHtml}
    <div class="section-title"><span class="material-symbols-outlined">list_alt</span> Global Change Log</div>
    <div class="log-card">${full}</div>
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

  const rows = log.map((l) => `
    <div class="activity-log-row">
      <span class="act-icon material-symbols-outlined" style="color:${cls(l.type) === 'j' ? '#2e7d32' : cls(l.type) === 'l' ? '#c62828' : '#ed6c02'}; font-size:20px;">
        ${ICON[l.type] || 'info'}
      </span>
      <div class="act-body">
        <div class="act-name">${highlightName(l.name)} <span class="action-chip ${cls(l.type)}" style="font-size:0.72rem;">${esc(TEXT[l.type] || l.type)}</span></div>
        <div class="act-meta">${esc(l.ev)} · ${esc(l.label || '')} · ${new Date(l.ts).toLocaleString()}</div>
      </div>
    </div>
  `).join('');

  return `
    <div class="section-title"><span class="material-symbols-outlined">history</span> Recent Activity (Last ${log.length} changes)</div>
    <div class="activity-view-container">
      ${rows}
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

  currentData = d;
  initDateIfNeeded(d);
  renderCurrentView();

  const updatedTs = d.updated || d.lastRun || d.uploadedAt;
  document.getElementById('status').innerHTML = updatedTs 
    ? `<span class="material-symbols-outlined" style="font-size:12px">check_circle</span> Updated ${new Date(updatedTs).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}` 
    : '';
}


// ── Swipe handlers for all views ──
function attachSwipeHandlers() {
  const container = document.getElementById('viewContainer');
  if (!container || container.dataset.swipeBound === currentView) return;
  container.dataset.swipeBound = currentView;

  let startX = 0, startY = 0, swiping = false;
  const threshold = 60;

  container.addEventListener('touchstart', (e) => {
    if (e.target.closest('button') || e.target.closest('a') || e.target.closest('summary') || e.target.closest('input')) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    swiping = true;
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!swiping) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 10) {
      e.preventDefault();
    }
  }, { passive: false });

  container.addEventListener('touchend', (e) => {
    if (!swiping) return;
    swiping = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > threshold) {
      if (dx > 0) {
        navPrev();
      } else {
        navNext();
      }
    }
  });
}


async function load() {
  const reloadBtn = document.getElementById('reload');
  reloadBtn.classList.add('spinning');
  const app = document.getElementById('app');
  
  if (!src) { 
    app.innerHTML = '<div class="err">Set DATA_URL in this file or open with ?src=&lt;url to state.json&gt;</div>'; 
    reloadBtn.classList.remove('spinning');
    return; 
  }
  
  try {
    const r = await fetch(`${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    render(await r.json());
  } catch (e) { 
    app.innerHTML = `<div class="err">Failed to load data: ${esc(e.message)} (check bucket CORS / URL)</div>`; 
  } finally {
    reloadBtn.classList.remove('spinning');
  }
}

document.getElementById('app').addEventListener('toggle', (e) => {
  const k = e.target.dataset && e.target.dataset.key; if (!k) return;
  e.target.open ? open.add(k) : open.delete(k);
}, true);

document.getElementById('reload').onclick = load;
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
setInterval(load, 60000);
load();
