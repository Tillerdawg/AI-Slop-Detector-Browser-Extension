/**
 * Extracts video/channel data for the currently loaded watch page.
 *
 * Originally this parsed YouTube's inline `ytInitialPlayerResponse` JS
 * state, but YouTube no longer embeds that as literal parseable JSON text
 * in a <script> tag (it's assembled at runtime instead), which broke that
 * approach outright. This instead reads YouTube's schema.org VideoObject
 * metadata (`<meta itemprop="...">` / `<link itemprop="...">` tags in
 * <head>, present for SEO) plus the URL for the video ID -- plain HTML,
 * far less likely to shift under us than internal JS state, and the video
 * ID from the URL means we practically never come back with nothing.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});
  const C = AISlop.constants;

  function metaContent(selector) {
    const el = document.querySelector(selector);
    const val = el && el.getAttribute('content');
    return val ? val.trim() : '';
  }

  function parseIsoDuration(iso) {
    if (!iso) return 0;
    const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?/);
    if (!m) return 0;
    const h = parseInt(m[1] || '0', 10);
    const min = parseInt(m[2] || '0', 10);
    const s = parseFloat(m[3] || '0');
    return h * 3600 + min * 60 + s;
  }

  function extractChannelId() {
    const direct = metaContent('meta[itemprop="channelId"]');
    if (direct) return direct;
    const channelLink = [...document.querySelectorAll('link[itemprop="url"]')]
      .map((l) => l.getAttribute('href'))
      .find((h) => h && /\/channel\//.test(h));
    const m = channelLink && channelLink.match(/\/channel\/([\w-]+)/);
    return m ? m[1] : '';
  }

  function extractChannelTitle() {
    const viaSchema = metaContent('link[itemprop="name"]');
    if (viaSchema) return viaSchema;
    const el = document.querySelector('ytd-channel-name a, #channel-name a, #owner a, ytd-video-owner-renderer a');
    return el ? el.textContent.trim() : '';
  }

  /**
   * Format-independent best-effort scan across every inline <script> tag's
   * text for YouTube's own creator-disclosed "altered or synthetic content"
   * label (see AI_DISCLOSURE_PHRASES in constants.js). Just a substring
   * search, so it doesn't depend on any particular JSON structure existing.
   */
  function scanForDisclosure() {
    const scripts = document.querySelectorAll('script:not([src])');
    for (const s of scripts) {
      const text = s.textContent;
      if (!text) continue;
      const lower = text.toLowerCase();
      if (C.AI_DISCLOSURE_PHRASES.some((phrase) => lower.indexOf(phrase) !== -1)) return true;
    }
    return false;
  }

  /** @returns {object|null} VideoSignals for the currently loaded watch page, or null if not a watch page. */
  function extractWatchPageData() {
    const videoId = new URL(location.href).searchParams.get('v');
    if (!videoId) return null;

    const title = metaContent('meta[itemprop="name"]') || document.title.replace(/ - YouTube$/, '').trim();
    const description = metaContent('meta[itemprop="description"]');
    const publishedAt = metaContent('meta[itemprop="datePublished"]') || metaContent('meta[itemprop="uploadDate"]');
    const lengthSeconds = parseIsoDuration(metaContent('meta[itemprop="duration"]'));

    return {
      videoId,
      title,
      description,
      lengthSeconds,
      channelId: extractChannelId(),
      channelTitle: extractChannelTitle(),
      keywords: [],
      publishedAt,
      disclosedSynthetic: scanForDisclosure(),
    };
  }

  AISlop.pageData = { extractWatchPageData };
})(typeof self !== 'undefined' ? self : this);
