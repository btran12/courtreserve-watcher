/* CourtReserve Watcher — activity feed page.
 *
 * The watcher page used to carry a Day / Activity tab pair. Activity is a standalone page now
 * (activity.html) and is reached from the page menu, so this file only owns the feed.
 */
(() => {
  const page = document.getElementById('activityPage');
  if (!page) return;

  const DATA_URL = 'https://d22bq7zsasshul.cloudfront.net/courtreserve-watcher/state.json';
  const src = new URLSearchParams(location.search).get('src') || DATA_URL;
  const LOG_LIMIT = 200;

  const ICON = {
    joined: 'add_circle',
    left: 'remove_circle',
    'waitlist-joined': 'hourglass_top',
    'waitlist-left': 'door_back',
    promoted: 'arrow_upward',
    demoted: 'arrow_downward',
    removed: 'delete',
  };
  const TEXT = {
    joined: 'joined',
    left: 'left',
    'waitlist-joined': 'joined the waitlist',
    'waitlist-left': 'left the waitlist',
    promoted: 'moved from waitlist to registered',
    demoted: 'moved from registered to waitlist',
    removed: 'event no longer listed',
  };
  // Short verbs keep the compact rows on one line (the icon carries the direction).
  const SHORT = {
    'waitlist-joined': 'waitlist',
    'waitlist-left': 'left waitlist',
    promoted: 'promoted',
    demoted: 'demoted',
    removed: 'unlisted',
  };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cls = (t) => (t === 'joined' || t === 'promoted' ? 'j' : t === 'left' || t === 'removed' ? 'l' : 'w');

  // Groups rows by the calendar day a change was detected.
  function dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }
  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
  }

  const el = {
    content: document.getElementById('activityContent'),
    status: document.getElementById('activityStatus'),
    refresh: document.getElementById('activityRefresh'),
  };

  let data = null;
  let loading = true;
  let error = '';

  function renderLog(d) {
    const log = (d.log || []).filter((l) => l.type !== 'tracking').slice(0, LOG_LIMIT);
    if (!log.length) {
      return `<div class="activity-view-container"><div class="box-container" style="text-align:center; padding:48px 16px;">
        <span class="material-symbols-outlined" style="font-size:48px; color:#bdbdbd; margin-bottom:8px;">history</span>
        <h3 style="margin:0 0 6px 0; color:var(--md-on-surface);">No activity recorded yet</h3>
        <p style="color:var(--md-on-surface-variant); font-size:0.875rem; margin:0;">Changes will appear here as the watcher detects them.</p>
      </div></div>`;
    }

    let lastDay = '';
    const rows = log.map((l) => {
      const tone = cls(l.type) === 'j' ? '#2e7d32' : cls(l.type) === 'l' ? '#c62828' : '#ed6c02';
      const meta = [l.label, l.ev].filter(Boolean).join(' \u00b7 ');
      const day = dayKey(l.ts);
      const separator = day !== lastDay
        ? `<div class="activity-day-separator"><span>${esc(dayLabel(l.ts))}</span></div>`
        : '';
      lastDay = day;
      return `${separator}
      <div class="activity-log-row">
        <span class="act-icon material-symbols-outlined" style="color:${tone}">${ICON[l.type] || 'info'}</span>
        <span class="act-name">${esc(l.name)}</span>
        <span class="action-chip ${cls(l.type)}">${esc(SHORT[l.type] || TEXT[l.type] || l.type)}</span>
        <span class="act-meta" title="${esc(meta)}">${esc(meta)}</span>
        <span class="act-time">${new Date(l.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
      </div>`;
    }).join('');

    return `
      <div class="section-title"><span class="material-symbols-outlined">history</span> Recent Activity (Last ${log.length} changes)</div>
      <div class="activity-view-container">
        <div class="activity-log-card">${rows}</div>
      </div>`;
  }

  function render() {
    if (!el.content) return;
    if (loading && !data) {
      el.content.innerHTML = `<div class="checkin-loading">
        <span class="material-symbols-outlined">progress_activity</span>
        Loading activity…
      </div>`;
      return;
    }
    if (error && !data) {
      el.content.innerHTML = `<div class="err">Failed to load activity: ${esc(error)}. Use the refresh button to try again.</div>`;
      return;
    }
    el.content.innerHTML = renderLog(data);
  }

  function updateStatus() {
    if (!el.status) return;
    const ts = data && (data.updated || data.lastRun || data.uploadedAt);
    el.status.innerHTML = ts
      ? `<span class="material-symbols-outlined" style="font-size:12px">check_circle</span> Updated ${new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
  }

  async function load() {
    el.refresh?.classList.add('spinning');
    loading = true;
    try {
      const r = await fetch(`${src}${src.includes('?') ? '&' : '?'}t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
      error = '';
      updateStatus();
    } catch (e) {
      error = (e && e.message) || 'request failed';
    } finally {
      loading = false;
      el.refresh?.classList.remove('spinning');
      render();
    }
  }

  el.refresh?.addEventListener('click', () => {
    haptic();
    load();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
  setInterval(load, 60000);
  render();
  load();
})();
