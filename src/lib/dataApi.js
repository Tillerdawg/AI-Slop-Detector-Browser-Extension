/**
 * Optional YouTube Data API v3 integration. Entirely opt-in: only used when
 * the user pastes their own free API key into the options page. Provides
 * richer/more reliable channel stats (creation date, total video count,
 * subscriber count) than the RSS-scraping fallback, at ~1 quota unit per
 * call against a 10,000/day free quota.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});

  const BASE = 'https://www.googleapis.com/youtube/v3';

  async function safeJson(res) {
    if (!res || !res.ok) return null;
    try {
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  /**
   * @returns {Promise<{channelPublishedAt, channelVideoCount, uploadsPlaylistId, subscriberCount}|null>}
   */
  async function getChannelStats(channelId, apiKey) {
    if (!channelId || !apiKey) return null;
    const url = `${BASE}/channels?part=snippet,statistics,contentDetails&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(apiKey)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      return null;
    }
    const json = await safeJson(res);
    const item = json && json.items && json.items[0];
    if (!item) return null;
    return {
      channelPublishedAt: item.snippet && item.snippet.publishedAt,
      channelVideoCount: item.statistics && Number(item.statistics.videoCount),
      subscriberCount: item.statistics && !item.statistics.hiddenSubscriberCount ? Number(item.statistics.subscriberCount) : null,
      uploadsPlaylistId: item.contentDetails && item.contentDetails.relatedPlaylists && item.contentDetails.relatedPlaylists.uploads,
    };
  }

  /**
   * @returns {Promise<{recentUploadDates:string[], recentUploadTitles:string[]}|null>}
   */
  async function getRecentUploads(uploadsPlaylistId, apiKey, maxResults) {
    if (!uploadsPlaylistId || !apiKey) return null;
    const url = `${BASE}/playlistItems?part=snippet&playlistId=${encodeURIComponent(uploadsPlaylistId)}&maxResults=${maxResults || 15}&key=${encodeURIComponent(apiKey)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      return null;
    }
    const json = await safeJson(res);
    if (!json || !Array.isArray(json.items)) return null;
    const dates = [];
    const titles = [];
    for (const it of json.items) {
      const s = it.snippet;
      if (!s) continue;
      if (s.publishedAt) dates.push(s.publishedAt);
      if (s.title) titles.push(s.title);
    }
    if (dates.length === 0) return null;
    return { recentUploadDates: dates, recentUploadTitles: titles };
  }

  /** Lightweight validation call used by the options page "Test key" button. */
  async function testApiKey(apiKey) {
    if (!apiKey) return { ok: false, message: 'No key provided' };
    const url = `${BASE}/channels?part=id&id=UC_x5XG1OV2P6uZZ5FSM9Ttw&key=${encodeURIComponent(apiKey)}`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      return { ok: false, message: 'Network error reaching Google APIs' };
    }
    if (res.ok) return { ok: true, message: 'Key works' };
    if (res.status === 400 || res.status === 403) return { ok: false, message: 'Key rejected (invalid or quota/restriction issue)' };
    return { ok: false, message: `Unexpected response (HTTP ${res.status})` };
  }

  AISlop.dataApi = { getChannelStats, getRecentUploads, testApiKey };
})(typeof self !== 'undefined' ? self : this);
