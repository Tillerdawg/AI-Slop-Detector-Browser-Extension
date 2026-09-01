/**
 * Shared constants for the AI Slop Detector extension.
 * Loaded as a classic (non-module) script in every context (background,
 * content script, popup, options) so it must only ever attach to a shared
 * namespace object -- never use import/export here.
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});

  const STORAGE_KEYS = {
    SETTINGS: 'aislop_settings',
    SCORE_CACHE: 'aislop_score_cache', // per-video score cache
    CHANNEL_CACHE: 'aislop_channel_cache', // per-channel upload-cadence cache
    OVERRIDES: 'aislop_overrides', // user's manual trust/flag list, keyed by videoId
    VOTES: 'aislop_votes', // local-only record of the user's own community vote per videoId
    CLIENT_ID: 'aislop_client_id', // random per-install UUID, sent with votes
    COMMUNITY_CACHE: 'aislop_community_cache', // per-video community vote-count cache (short TTL)
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    showOnWatchPage: true,
    showOnThumbnails: true,
    showInPopup: true,
    useChannelCadence: true, // fetch channel RSS feed for upload-frequency signal
    strictness: 'balanced', // 'lenient' | 'balanced' | 'strict'
    youtubeApiKey: '', // optional, enables richer channel stats instead of RSS scraping
    communityApiUrl: '', // optional community-ratings backend base URL (empty = disabled)
  };

  // Cutoff bands, tunable by strictness. Values are the *minimum* score (0-100)
  // needed to fall into that band, checked from highest to lowest.
  const STRICTNESS_BANDS = {
    lenient: [
      { min: 80, id: 'ai_generated' },
      { min: 60, id: 'ai_assisted' },
      { min: 35, id: 'uncertain' },
      { min: 0, id: 'human' },
    ],
    balanced: [
      { min: 70, id: 'ai_generated' },
      { min: 45, id: 'ai_assisted' },
      { min: 20, id: 'uncertain' },
      { min: 0, id: 'human' },
    ],
    strict: [
      { min: 55, id: 'ai_generated' },
      { min: 32, id: 'ai_assisted' },
      { min: 12, id: 'uncertain' },
      { min: 0, id: 'human' },
    ],
  };

  const RATING_BANDS = {
    ai_generated: { label: 'Likely AI-Generated', emoji: '\u{1F6D1}', color: '#e0483d', short: 'AI-Generated' },
    ai_assisted: { label: 'Likely AI-Assisted', emoji: '\u{26A0}\u{FE0F}', color: '#e0913d', short: 'AI-Assisted' },
    uncertain: { label: 'Mixed / Uncertain', emoji: '\u{2753}', color: '#d9c23c', short: 'Uncertain' },
    human: { label: 'Likely Human-Made', emoji: '\u{2705}', color: '#3da35d', short: 'Human-Made' },
  };

  // Substrings we look for (case-insensitive) inside the raw YouTube page
  // payload to catch YouTube's own creator-disclosed "altered or synthetic
  // content" label. This is deliberately a *list* of loosely-related
  // candidates (visible UI copy + likely internal identifiers) rather than a
  // single fixed JSON path, because YouTube's internal schema changes over
  // time and a brittle exact-path lookup would silently stop working.
  const AI_DISCLOSURE_PHRASES = [
    'altered or synthetic',
    'meaningfully altered',
    'realistic altered',
    'synthetic media',
    'synthetic content',
    'creator disclosed',
    'creatordisclos',
    'disclosedsynthetic',
    'contains altered or synthetic',
  ];

  // Weak-but-useful textual tells that a description was written by / for an
  // AI content pipeline, or credits fully-stock-sourced footage.
  const DESCRIPTION_BOILERPLATE_PATTERNS = [
    /generated (with|using|by)\s+(ai|artificial intelligence)/i,
    /created (with|using)\s+(ai|artificial intelligence)/i,
    /text[- ]to[- ]speech/i,
    /voice(over)? (generated|created) (with|by|using)/i,
    /this video (was|is) (created|made|generated) (with|using|by)\s+(an?\s+)?(ai|artificial intelligence)/i,
    /footage from (pexels|pixabay|videvo|storyblocks|envato|shutterstock|motion ?array)/i,
    /images? (from|via|courtesy of) (midjourney|dall-?e|stable diffusion)/i,
  ];

  // Clickbait / content-mill title phrasing frequently seen on templated
  // channels (not proof of AI on its own -- one of several weighted signals).
  const CLICKBAIT_TITLE_PATTERNS = [
    /you won'?t believe/i,
    /this will (blow your mind|shock you|change your life)/i,
    /^top \d+/i,
    /^\d+ (amazing|incredible|insane|crazy|shocking|unbelievable) /i,
    /gone wrong/i,
    /the (truth|story|secret) (about|behind)/i,
    /^why (everyone|no one|nobody|you)/i,
    /^what (happens|if) /i,
    /\bexplained\b$/i,
    /\bin \d{4}\b$/i,
    /facts (about|you)/i,
    /full documentary$/i,
  ];

  const CACHE_TTL_MS = {
    SCORE: 12 * 60 * 60 * 1000, // 12h - per-video score
    CHANNEL: 24 * 60 * 60 * 1000, // 24h - per-channel upload cadence
    COMMUNITY: 10 * 60 * 1000, // 10min - community vote counts (kept short so votes don't go stale for hours)
  };

  const RSS_MIN_INTERVAL_MS = 1500; // min gap between outbound RSS fetches (politeness throttle)
  const RSS_MAX_QUEUE = 40; // don't let the fetch queue grow unbounded while scrolling

  const MESSAGE_TYPES = {
    GET_SCORE: 'AISLOP_GET_SCORE', // content -> background: request full score for a video
    QUICK_SCORE: 'AISLOP_QUICK_SCORE', // content: title-only score, computed inline, no message needed
    GET_SETTINGS: 'AISLOP_GET_SETTINGS',
    SETTINGS_CHANGED: 'AISLOP_SETTINGS_CHANGED',
    SET_OVERRIDE: 'AISLOP_SET_OVERRIDE',
    CLEAR_CACHE: 'AISLOP_CLEAR_CACHE',
    CACHE_STATS: 'AISLOP_CACHE_STATS',
    TEST_API_KEY: 'AISLOP_TEST_API_KEY',
    PING_CURRENT: 'AISLOP_PING_CURRENT', // popup -> content script: "what's your current video's result?"
    SET_COMMUNITY_VOTE: 'AISLOP_SET_COMMUNITY_VOTE', // content -> background: cast/change a community vote
  };

  AISlop.constants = {
    STORAGE_KEYS,
    DEFAULT_SETTINGS,
    STRICTNESS_BANDS,
    RATING_BANDS,
    AI_DISCLOSURE_PHRASES,
    DESCRIPTION_BOILERPLATE_PATTERNS,
    CLICKBAIT_TITLE_PATTERNS,
    CACHE_TTL_MS,
    RSS_MIN_INTERVAL_MS,
    RSS_MAX_QUEUE,
    MESSAGE_TYPES,
  };
})(typeof self !== 'undefined' ? self : this);
