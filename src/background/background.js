/**
 * Background service worker (Chrome) / event page (Firefox).
 *
 * Chrome loads only this one file as `service_worker`, so it must pull in
 * the shared lib files itself via importScripts(). Firefox instead lists
 * every lib file directly in manifest.background.scripts (a background page
 * has no importScripts -- it's a Window, not a Worker), so this file must
 * skip the import there. `typeof window === 'undefined'` reliably tells
 * apart a real service worker (Chrome) from a background page (Firefox).
 */
if (typeof window === 'undefined' && typeof importScripts === 'function') {
  importScripts(
    '../lib/constants.js',
    '../lib/browserApi.js',
    '../lib/heuristics.js',
    '../lib/storage.js',
    '../lib/rss.js',
    '../lib/dataApi.js'
  );
}

(function () {
  const AISlop = self.AISlop;
  const C = AISlop.constants;
  const api = AISlop.browserApi;
  const M = C.MESSAGE_TYPES;

  // --- rate-limited, deduped channel-data queue -----------------------------
  const queue = [];
  const inFlight = new Map(); // channelId -> Promise<data>
  let processing = false;
  let lastFetchAt = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function processQueue() {
    if (processing) return;
    processing = true;
    while (queue.length) {
      if (queue.length > C.RSS_MAX_QUEUE) {
        // Under heavy scroll, newest requests (what's on screen now) matter
        // more than stale ones queued while scrolling past -- drop the rest.
        const dropped = queue.splice(0, queue.length - C.RSS_MAX_QUEUE);
        for (const t of dropped) t.resolve(null);
      }
      const task = queue.shift();
      const wait = Math.max(0, lastFetchAt + C.RSS_MIN_INTERVAL_MS - Date.now());
      if (wait > 0) await sleep(wait);
      lastFetchAt = Date.now();

      let data = null;
      try {
        data = await AISlop.storage.getChannelCacheEntry(task.channelId);
        if (!data) {
          if (task.apiKey) {
            const stats = await AISlop.dataApi.getChannelStats(task.channelId, task.apiKey);
            let uploads = null;
            if (stats && stats.uploadsPlaylistId) {
              uploads = await AISlop.dataApi.getRecentUploads(stats.uploadsPlaylistId, task.apiKey, 15);
            }
            data = Object.assign({}, stats || {}, uploads || {});
            if (Object.keys(data).length === 0) data = null;
          } else {
            data = await AISlop.rss.fetchChannelFeed(task.channelId);
          }
          if (data) await AISlop.storage.setChannelCacheEntry(task.channelId, data);
        }
      } catch (e) {
        data = null;
      }
      task.resolve(data);
    }
    processing = false;
  }

  function getChannelData(channelId, apiKey) {
    if (!channelId) return Promise.resolve(null);
    if (inFlight.has(channelId)) return inFlight.get(channelId);
    const p = new Promise((resolve) => {
      queue.push({ channelId, apiKey, resolve });
      processQueue();
    }).finally(() => inFlight.delete(channelId));
    inFlight.set(channelId, p);
    return p;
  }

  async function computeFullScore(signals, settings) {
    const overrides = await AISlop.storage.getOverrides();
    const override = signals.videoId ? overrides[signals.videoId] : null;
    let channelData = null;
    if (settings.useChannelCadence && signals.channelId && !(override && override.trusted) && !(override && override.flagged)) {
      channelData = await getChannelData(signals.channelId, settings.youtubeApiKey);
    }
    const merged = Object.assign({}, signals, channelData || {});
    return AISlop.heuristics.scoreVideo(merged, { strictness: settings.strictness, override });
  }

  async function handleMessage(message) {
    switch (message && message.type) {
      case M.GET_SETTINGS:
        return AISlop.storage.getSettings();

      case M.GET_SCORE: {
        const settings = await AISlop.storage.getSettings();
        if (!settings.enabled) return { disabled: true };
        if (!message.forceRefresh) {
          const cached = await AISlop.storage.getScoreCacheEntry(message.videoId);
          if (cached) return cached;
        }
        const result = await computeFullScore(message.signals || {}, settings);
        const payload = Object.assign({}, result, {
          videoId: message.videoId,
          channelId: message.signals && message.signals.channelId,
          channelTitle: message.signals && message.signals.channelTitle,
          title: message.signals && message.signals.title,
          computedAt: Date.now(),
        });
        await AISlop.storage.setScoreCacheEntry(message.videoId, payload);
        return payload;
      }

      case M.SET_OVERRIDE: {
        const overrides = await AISlop.storage.setOverride(message.videoId, message.override);
        return { ok: true, overrides };
      }

      case M.CLEAR_CACHE:
        await AISlop.storage.clearCaches();
        return { ok: true };

      case M.CACHE_STATS:
        return AISlop.storage.cacheStats();

      case M.TEST_API_KEY:
        return AISlop.dataApi.testApiKey(message.apiKey);

      default:
        return { error: 'Unknown message type: ' + (message && message.type) };
    }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message)
      .then(sendResponse)
      .catch((err) => sendResponse({ error: String(err && err.message ? err.message : err) }));
    return true; // keep the message channel open for the async sendResponse above
  });
})();
