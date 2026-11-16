/* CourtReserve Watcher — tiny haptic ticks for taps.
 *
 * navigator.vibrate is a no-op on browsers that do not support it (iOS Safari, most desktops),
 * so haptic() is safe to call from any click handler. Patterns are deliberately short: this is
 * accent feedback for an action, not an alert.
 */
(() => {
  const supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

  window.haptic = (pattern = 8) => {
    if (!supported || document.visibilityState === 'hidden') return false;
    try {
      return navigator.vibrate(pattern);
    } catch (_) {
      return false;
    }
  };

  // Page navigation leaves this document immediately; vibrate on the way out. (A delegated
  // listener keeps every page's drawer / bottom bar covered without repeating this per page.)
  document.addEventListener('click', (event) => {
    if (event.target.closest('a.nav-menu-item, a.bottom-nav-item')) window.haptic();
  });
})();
