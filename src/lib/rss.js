/**
 * Fetches a channel's public "uploads" RSS/Atom feed
 * (https://www.youtube.com/feeds/videos.xml?channel_id=...) to derive an
 * upload-cadence signal without needing a YouTube Data API key. This is an
 * unauthenticated, no-quota, publicly documented endpoint intended for feed
 * readers, so we throttle + cache aggressively (see background.js) to stay
 * a polite, low-volume consumer of it.
 *
 * No DOMParser is used here (Chrome MV3 service workers have no DOM), so
 * parsing is done with small, well-anchored regexes against the feed's very
 * regular Atom structure. Good enough for our purposes (dates + titles);
 * not a general-purpose XML parser.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unescapeXml(str) {
    return String(str || '').replace(/&(amp|lt|gt|quot|apos|#39|#x27);/g, (m, ent) => {
      if (ent === '#39' || ent === '#x27') return "'";
      return ENTITIES[ent] !== undefined ? ENTITIES[ent] : m;
    });
  }

  function extractTag(block, tag) {
    const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
    const m = block.match(re);
    return m ? unescapeXml(m[1].trim()) : null;
  }

  /**
   * @param {string} channelId
   * @returns {Promise<{recentUploadDates:string[], recentUploadTitles:string[]}|null>}
   */
  async function fetchChannelFeed(channelId) {
    if (!channelId) return null;
    const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
    let res;
    try {
      res = await fetch(url, { credentials: 'omit' });
    } catch (e) {
      return null;
    }
    if (!res || !res.ok) return null;
    const text = await res.text();
    const entryBlocks = text.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    const dates = [];
    const titles = [];
    for (const block of entryBlocks) {
      const published = extractTag(block, 'published');
      const title = extractTag(block, 'title') || extractTag(block, 'media:title');
      if (published) dates.push(published);
      if (title) titles.push(title);
    }
    if (dates.length === 0) return null;
    return { recentUploadDates: dates, recentUploadTitles: titles };
  }

  AISlop.rss = { fetchChannelFeed };
})(typeof self !== 'undefined' ? self : this);
