/**
 * Entry point wired up as the last content script in manifest `js` order.
 * Coordinates the watch-page panel and the feed/thumbnail scanner, reacting
 * to YouTube's SPA navigation events and to live settings changes from the
 * options page.
 */
(function () {
  const AISlop = self.AISlop;
  const C = AISlop.constants;
  const api = AISlop.browserApi;

  let settings = C.DEFAULT_SETTINGS;
  let thumbnailScanner = null;
  let currentWatchVideoId = null;
  let lastResult = null;
  let lastSignals = null;

  function isWatchPage() {
    return location.pathname === '/watch';
  }

  async function refreshWatchPanel(forceRefresh) {
    if (!settings.enabled || !isWatchPage()) {
      AISlop.panel.removePanel();
      lastResult = null;
      lastSignals = null;
      return;
    }
    let signals = AISlop.pageData.extractWatchPageData();
    if (!signals || !signals.videoId) return;

    // Right after an SPA navigation, YouTube can take a beat to swap in the
    // new page's <head> metadata; a generic/empty title means we likely read
    // it mid-swap. One short retry avoids permanently caching a bad score.
    if (!signals.title || signals.title === 'YouTube') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const retried = AISlop.pageData.extractWatchPageData();
      if (retried && retried.videoId === signals.videoId) signals = retried;
    }
    currentWatchVideoId = signals.videoId;

    // Show an instant title-only estimate while the full (network-backed) score resolves.
    // Computed (and exposed to the popup) even if the on-page panel is turned off.
    const quick = AISlop.heuristics.quickScoreFromTitle(signals.title, { strictness: settings.strictness });
    if (currentWatchVideoId === signals.videoId) applyResult(signals, quick);

    let result;
    try {
      result = await api.runtime.sendMessage({
        type: C.MESSAGE_TYPES.GET_SCORE,
        videoId: signals.videoId,
        signals,
        forceRefresh: !!forceRefresh,
        // Watch-page only: thumbnails must never trigger a community lookup.
        includeCommunity: true,
      });
    } catch (e) {
      return;
    }
    if (!result || result.error || result.disabled) return;
    // The user may have navigated to a different video while this was in flight.
    if (currentWatchVideoId !== signals.videoId) return;
    applyResult(signals, result);
  }

  function applyResult(signals, result) {
    lastResult = result;
    lastSignals = signals;
    if (settings.showOnWatchPage) {
      AISlop.panel.renderWatchPanel(
        result,
        {
          onMarkTrusted: () => applyOverride(signals, { trusted: true, videoTitle: signals.title }),
          onMarkFlagged: () => applyOverride(signals, { flagged: true, videoTitle: signals.title }),
          onClearOverride: () => applyOverride(signals, null),
          onVote: (vote) => applyVote(signals, vote),
        },
        settings
      );
    } else {
      AISlop.panel.removePanel();
    }
  }

  async function applyOverride(signals, override) {
    if (!signals.videoId) return;
    await api.runtime.sendMessage({
      type: C.MESSAGE_TYPES.SET_OVERRIDE,
      videoId: signals.videoId,
      override,
    });
    await refreshWatchPanel(true);
  }

  async function applyVote(signals, vote) {
    if (!signals.videoId) return;
    await api.runtime.sendMessage({
      type: C.MESSAGE_TYPES.SET_COMMUNITY_VOTE,
      videoId: signals.videoId,
      channelId: signals.channelId,
      vote,
    });
    await refreshWatchPanel(true);
  }

  function startThumbnailScanner() {
    if (!thumbnailScanner) thumbnailScanner = AISlop.scanner.makeThumbnailScanner(() => settings);
    if (settings.enabled && settings.showOnThumbnails) {
      thumbnailScanner.start();
    } else {
      thumbnailScanner.stop();
    }
  }

  function applySettings(next) {
    settings = Object.assign({}, C.DEFAULT_SETTINGS, next);
    startThumbnailScanner();
    refreshWatchPanel(false);
  }

  async function init() {
    settings = await api.runtime.sendMessage({ type: C.MESSAGE_TYPES.GET_SETTINGS }).catch(() => C.DEFAULT_SETTINGS);
    if (!settings) settings = C.DEFAULT_SETTINGS;
    startThumbnailScanner();
    refreshWatchPanel(false);
  }

  // YouTube is a single-page app; full document loads don't happen between
  // videos. It fires this custom event on every internal navigation.
  document.addEventListener('yt-navigate-finish', () => {
    refreshWatchPanel(false);
    if (thumbnailScanner) thumbnailScanner.rescan();
  });

  // Live-react to settings changes made from the options page / popup.
  api.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[C.STORAGE_KEYS.SETTINGS]) return;
    applySettings(changes[C.STORAGE_KEYS.SETTINGS].newValue || C.DEFAULT_SETTINGS);
  });

  // The popup can't run this content script's logic itself, so it asks us
  // (via the background/tabs messaging bridge) for whatever we've already
  // computed for the current video.
  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== C.MESSAGE_TYPES.PING_CURRENT) return undefined;
    sendResponse({ isWatchPage: isWatchPage(), result: lastResult, signals: lastSignals });
    return true;
  });

  init();
})();
