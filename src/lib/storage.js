/**
 * Thin promise-based wrapper around extension storage, plus small
 * TTL-cache helpers used for per-video scores and per-channel upload
 * cadence data. All data stays local to the browser (chrome.storage.local /
 * browser.storage.local) -- nothing here talks to the network.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});
  const C = AISlop.constants;
  const api = AISlop.browserApi;

  const MAX_SCORE_ENTRIES = 2000;
  const MAX_CHANNEL_ENTRIES = 500;

  function get(keys) {
    return Promise.resolve(api.storage.local.get(keys));
  }
  function set(obj) {
    return Promise.resolve(api.storage.local.set(obj));
  }
  function remove(keys) {
    return Promise.resolve(api.storage.local.remove(keys));
  }

  async function getSettings() {
    const stored = await get(C.STORAGE_KEYS.SETTINGS);
    return Object.assign({}, C.DEFAULT_SETTINGS, stored[C.STORAGE_KEYS.SETTINGS] || {});
  }

  async function setSettings(partial) {
    const current = await getSettings();
    const next = Object.assign({}, current, partial);
    await set({ [C.STORAGE_KEYS.SETTINGS]: next });
    return next;
  }

  function pruneMap(map, ttlKeyGetter, maxEntries) {
    const now = Date.now();
    const entries = Object.entries(map).filter(([, v]) => v && v.expiresAt > now);
    entries.sort((a, b) => b[1].expiresAt - a[1].expiresAt); // newest first
    const kept = entries.slice(0, maxEntries);
    return Object.fromEntries(kept);
  }

  async function getScoreCacheEntry(videoId) {
    const stored = await get(C.STORAGE_KEYS.SCORE_CACHE);
    const map = stored[C.STORAGE_KEYS.SCORE_CACHE] || {};
    const entry = map[videoId];
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    return null;
  }

  async function setScoreCacheEntry(videoId, value) {
    const stored = await get(C.STORAGE_KEYS.SCORE_CACHE);
    let map = stored[C.STORAGE_KEYS.SCORE_CACHE] || {};
    map[videoId] = { value, expiresAt: Date.now() + C.CACHE_TTL_MS.SCORE };
    map = pruneMap(map, null, MAX_SCORE_ENTRIES);
    await set({ [C.STORAGE_KEYS.SCORE_CACHE]: map });
  }

  async function getChannelCacheEntry(channelId) {
    const stored = await get(C.STORAGE_KEYS.CHANNEL_CACHE);
    const map = stored[C.STORAGE_KEYS.CHANNEL_CACHE] || {};
    const entry = map[channelId];
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    return null;
  }

  async function setChannelCacheEntry(channelId, value) {
    const stored = await get(C.STORAGE_KEYS.CHANNEL_CACHE);
    let map = stored[C.STORAGE_KEYS.CHANNEL_CACHE] || {};
    map[channelId] = { value, expiresAt: Date.now() + C.CACHE_TTL_MS.CHANNEL };
    map = pruneMap(map, null, MAX_CHANNEL_ENTRIES);
    await set({ [C.STORAGE_KEYS.CHANNEL_CACHE]: map });
  }

  async function getOverrides() {
    const stored = await get(C.STORAGE_KEYS.OVERRIDES);
    return stored[C.STORAGE_KEYS.OVERRIDES] || {};
  }

  async function setOverride(channelId, override) {
    const overrides = await getOverrides();
    if (!override) {
      delete overrides[channelId];
    } else {
      overrides[channelId] = override; // { trusted: bool, flagged: bool, channelTitle }
    }
    await set({ [C.STORAGE_KEYS.OVERRIDES]: overrides });
    return overrides;
  }

  async function clearCaches() {
    await remove([C.STORAGE_KEYS.SCORE_CACHE, C.STORAGE_KEYS.CHANNEL_CACHE]);
  }

  async function cacheStats() {
    const stored = await get([C.STORAGE_KEYS.SCORE_CACHE, C.STORAGE_KEYS.CHANNEL_CACHE]);
    const scoreMap = stored[C.STORAGE_KEYS.SCORE_CACHE] || {};
    const channelMap = stored[C.STORAGE_KEYS.CHANNEL_CACHE] || {};
    return {
      scoreEntries: Object.keys(scoreMap).length,
      channelEntries: Object.keys(channelMap).length,
    };
  }

  AISlop.storage = {
    get,
    set,
    remove,
    getSettings,
    setSettings,
    getScoreCacheEntry,
    setScoreCacheEntry,
    getChannelCacheEntry,
    setChannelCacheEntry,
    getOverrides,
    setOverride,
    clearCaches,
    cacheStats,
  };
})(typeof self !== 'undefined' ? self : this);
