/**
 * Finds video thumbnails on feed/search/channel/related pages and drives
 * badges for them. Uses IntersectionObserver so we only ever request a full
 * (network-backed) score for thumbnails the user actually scrolls to, and a
 * MutationObserver to pick up YouTube's infinite-scroll / SPA-navigation DOM
 * churn.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});
  const C = AISlop.constants;
  const api = AISlop.browserApi;

  const FEED_SELECTORS = [
    'ytd-rich-item-renderer',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-video-renderer',
  ];
  const SEEN_ATTR = 'data-aislop-seen';

  // YouTube renders ads through the same item renderers we scan; skip them
  // entirely rather than rating an ad as "AI content".
  const AD_DESCENDANT_SELECTOR =
    'ytd-ad-slot-renderer, ytd-display-ad-renderer, ytd-promoted-sparkles-web-renderer, ytd-in-feed-ad-layout-renderer, ytd-companion-slot-renderer';

  function isAdElement(el) {
    return el.matches(AD_DESCENDANT_SELECTOR) || !!el.querySelector(AD_DESCENDANT_SELECTOR);
  }

  /**
   * Reads title/link/channel out of an item renderer. YouTube has two
   * markup generations in the wild simultaneously: the newer class-based
   * "yt-lockup-view-model" (no stable element IDs, but conveniently embeds
   * the video ID in a `content-id-<id>` class) and the older ID-based
   * renderer (`#video-title`, `a#thumbnail`). Newer is tried first, with
   * the legacy selectors as a fallback for any surface still using it.
   */
  function extractThumbInfo(el) {
    let title = null;
    let href = null;
    let badgeHost = null;

    const titleHeading = el.querySelector('h3.ytLockupMetadataViewModelHeadingReset, h3[class*="ytLockupMetadataViewModelHeading"]');
    if (titleHeading) {
      title = (titleHeading.getAttribute('title') || titleHeading.textContent || '').trim();
      const titleLink = titleHeading.querySelector('a[href*="/watch?v="]');
      const thumbLink = el.querySelector('a.ytLockupViewModelContentImage, a[class*="ytLockupViewModelContentImage"]');
      href = (titleLink && titleLink.getAttribute('href')) || (thumbLink && thumbLink.getAttribute('href'));
      badgeHost = thumbLink || titleLink;
    }

    if (!title || !href) {
      const legacyTitleEl = el.querySelector('#video-title, a#video-title, span#video-title, yt-formatted-string#video-title');
      const legacyLinkEl = el.querySelector('a#thumbnail, a#video-title-link') || (legacyTitleEl && legacyTitleEl.closest('a'));
      if (legacyTitleEl && !title) title = legacyTitleEl.textContent.trim();
      if (legacyLinkEl && !href) href = legacyLinkEl.getAttribute('href');
      if (!badgeHost) badgeHost = el.querySelector('a#thumbnail') || el.querySelector('#thumbnail');
    }

    let videoId = null;
    const videoIdMatch = href && href.match(/[?&]v=([\w-]{6,})/);
    if (videoIdMatch) {
      videoId = videoIdMatch[1];
    } else {
      const hostWithId = el.querySelector('[class*="content-id-"]');
      const m = hostWithId && hostWithId.className.match(/content-id-([\w-]{6,})/);
      if (m) videoId = m[1];
    }

    let channelTitle = '';
    let channelId = null;
    const avatarEl = el.querySelector('[aria-label^="Go to channel "]');
    if (avatarEl) channelTitle = avatarEl.getAttribute('aria-label').replace(/^Go to channel /, '').trim();
    const channelLinkEl = el.querySelector('ytd-channel-name a, #channel-name a, a[href^="/channel/"]');
    if (channelLinkEl) {
      if (!channelTitle) channelTitle = channelLinkEl.textContent.trim();
      const m = channelLinkEl.getAttribute('href') && channelLinkEl.getAttribute('href').match(/\/channel\/([\w-]+)/);
      if (m) channelId = m[1];
    }
    if (!channelTitle) {
      const handleLinkEl = el.querySelector('a[href^="/@"]');
      if (handleLinkEl) channelTitle = handleLinkEl.textContent.trim();
    }

    if (!badgeHost) badgeHost = el;
    return { videoId, title: title || '', channelId, channelTitle, badgeHost };
  }

  function collectNewElements(scanRoot) {
    const found = [];
    for (const sel of FEED_SELECTORS) {
      scanRoot.querySelectorAll(`${sel}:not([${SEEN_ATTR}])`).forEach((el) => {
        el.setAttribute(SEEN_ATTR, '1');
        if (!isAdElement(el)) found.push(el);
      });
    }
    return found;
  }

  function makeThumbnailScanner(getSettings) {
    let io = null;
    let mo = null;
    let debounceTimer = null;

    function processElement(el) {
      const settings = getSettings();
      if (!settings.showOnThumbnails) return;
      const info = extractThumbInfo(el);
      if (!info.videoId || !info.title) return;

      const badge = AISlop.badge.ensureBadge(info.badgeHost);
      const quick = AISlop.heuristics.quickScoreFromTitle(info.title, { strictness: settings.strictness });
      AISlop.badge.setBadgeResult(badge, quick);

      api.runtime
        .sendMessage({
          type: C.MESSAGE_TYPES.GET_SCORE,
          videoId: info.videoId,
          signals: {
            videoId: info.videoId,
            title: info.title,
            channelId: info.channelId,
            channelTitle: info.channelTitle,
          },
        })
        .then((result) => {
          if (result && !result.error && !result.disabled) {
            AISlop.badge.setBadgeResult(badge, result);
          }
        })
        .catch(() => {});
    }

    function scan() {
      if (!io) return; // torn down by stop() before this (debounced) call fired
      const settings = getSettings();
      if (!settings.showOnThumbnails) return;
      const els = collectNewElements(document);
      for (const el of els) io.observe(el);
    }

    function scheduleScan() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(scan, 250);
    }

    function start() {
      if (io) return; // already running
      io = new IntersectionObserver(
        (entries, obs) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            obs.unobserve(entry.target);
            processElement(entry.target);
          }
        },
        { root: null, rootMargin: '200px', threshold: 0 }
      );
      mo = new MutationObserver(scheduleScan);
      mo.observe(document.body, { childList: true, subtree: true });
      scan();
    }

    function stop() {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      if (mo) mo.disconnect();
      if (io) io.disconnect();
      mo = null;
      io = null;
      AISlop.badge.removeBadges();
      document.querySelectorAll(`[${SEEN_ATTR}]`).forEach((el) => el.removeAttribute(SEEN_ATTR));
    }

    function rescan() {
      scheduleScan();
    }

    return { start, stop, rescan };
  }

  AISlop.scanner = { makeThumbnailScanner, extractThumbInfo };
})(typeof self !== 'undefined' ? self : this);
