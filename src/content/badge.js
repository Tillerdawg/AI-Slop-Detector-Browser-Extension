/**
 * Small corner badge overlaid on video thumbnails in feeds/search results.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});
  const C = AISlop.constants;

  const BADGE_CLASS = 'aislop-badge';
  const HOST_MARK_ATTR = 'data-aislop-host';

  function bandInfo(band) {
    return C.RATING_BANDS[band] || C.RATING_BANDS.uncertain;
  }

  function buildBadgeEl(pending) {
    const el = document.createElement('div');
    el.className = BADGE_CLASS + (pending ? ' aislop-badge--pending' : '');
    el.textContent = pending ? '…' : '';
    return el;
  }

  /**
   * Ensures `thumbEl`'s nearest positioned ancestor can host an absolutely
   * positioned badge, creates (or reuses) the badge, and returns it.
   */
  function ensureBadge(hostEl) {
    if (!hostEl) return null;
    let cs = getComputedStyle(hostEl);
    if (cs.position === 'static') hostEl.style.position = 'relative';
    hostEl.setAttribute(HOST_MARK_ATTR, '1');
    let badge = hostEl.querySelector(':scope > .' + BADGE_CLASS);
    if (!badge) {
      badge = buildBadgeEl(true);
      hostEl.appendChild(badge);
    }
    return badge;
  }

  function setBadgePending(badge) {
    if (!badge) return;
    badge.className = BADGE_CLASS + ' aislop-badge--pending';
    badge.textContent = '';
    badge.removeAttribute('title');
  }

  function setBadgeResult(badge, result) {
    if (!badge || !result) return;
    const info = bandInfo(result.band);
    badge.className = BADGE_CLASS + ' aislop-badge--' + result.band;
    badge.textContent = info.emoji + ' ' + info.short;
    badge.style.setProperty('--aislop-color', info.color);
    const reasonText = (result.reasons || []).map((r) => '• ' + r).join('\n');
    badge.title = `${info.label}\n${reasonText}`;
  }

  function removeBadges(root2) {
    (root2 || document).querySelectorAll('.' + BADGE_CLASS).forEach((b) => b.remove());
  }

  AISlop.badge = { ensureBadge, setBadgePending, setBadgeResult, removeBadges, bandInfo };
})(typeof self !== 'undefined' ? self : this);
