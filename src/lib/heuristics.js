/**
 * Pure scoring engine. No network/storage access here on purpose -- it takes
 * a plain "VideoSignals" object and returns a score + human-readable reasons.
 * Keeping this side-effect-free makes it easy to reuse from the content
 * script (quick title-only pass), the background worker (full pass with
 * RSS/API data), and later a server-side re-scorer, without duplicating logic.
 *
 * VideoSignals shape (all fields optional except videoId/title):
 * {
 *   videoId, title, description, lengthSeconds,
 *   channelId, channelTitle,
 *   channelPublishedAt,      // ISO date the channel was created
 *   channelVideoCount,       // total uploads on the channel
 *   recentUploadDates,       // array of ISO date strings, most recent first
 *   recentUploadTitles,      // array of strings, parallel to recentUploadDates
 *   disclosedSynthetic,      // boolean, from YouTube's own disclosure label
 *   keywords,                // array of tag strings
 * }
 */
(function (root) {
  const AISlop = root.AISlop || (root.AISlop = {});
  const C = AISlop.constants;

  function clamp01(x) {
    return Math.max(0, Math.min(1, x));
  }

  function daysBetween(isoA, isoB) {
    const a = new Date(isoA).getTime();
    const b = new Date(isoB).getTime();
    if (Number.isNaN(a) || Number.isNaN(b)) return null;
    return Math.abs(a - b) / 86400000;
  }

  function median(nums) {
    if (!nums.length) return null;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // --- individual signal scorers -------------------------------------------
  // Each returns { subscore: 0..1, weight, reason } or null if not enough data.

  function scoreDisclosure(signals) {
    if (signals.disclosedSynthetic === true) {
      return {
        subscore: 1,
        weight: 40,
        reason: 'Creator disclosed this video contains altered or synthetic content (YouTube label)',
        positive: true,
      };
    }
    return null; // absence of the label is not evidence of anything either way
  }

  function scoreUploadCadence(signals) {
    const dates = signals.recentUploadDates;
    if (!dates || dates.length < 4) return null;
    const sorted = [...dates].sort((a, b) => new Date(b) - new Date(a));
    const gaps = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const g = daysBetween(sorted[i], sorted[i + 1]);
      if (g !== null) gaps.push(g);
    }
    if (gaps.length < 3) return null;
    const medGap = median(gaps);
    let subscore;
    if (medGap < 0.5) subscore = 1;
    else if (medGap < 1) subscore = 0.8;
    else if (medGap < 2) subscore = 0.5;
    else if (medGap < 4) subscore = 0.25;
    else subscore = 0;
    if (subscore === 0) return { subscore, weight: 20, reason: null };
    const perDay = (1 / medGap).toFixed(1);
    return {
      subscore,
      weight: 20,
      reason: `Channel uploads very frequently (~${perDay} videos/day recently)`,
      positive: true,
    };
  }

  function scoreChannelAgeVsVolume(signals) {
    const { channelPublishedAt, channelVideoCount } = signals;
    if (!channelPublishedAt || !channelVideoCount) return null;
    const ageDays = daysBetween(channelPublishedAt, new Date().toISOString());
    if (ageDays === null || ageDays < 1) return null;
    const ageMonths = ageDays / 30.44;
    const perMonth = channelVideoCount / ageMonths;
    let subscore;
    if (perMonth > 60) subscore = 1;
    else if (perMonth > 30) subscore = 0.7;
    else if (perMonth > 15) subscore = 0.4;
    else subscore = 0;
    // Established channels (3y+) sustaining high output is more plausible
    // for legitimate operations (news, clip shows), so soften the signal.
    if (ageMonths > 36) subscore *= 0.5;
    if (subscore < 0.15) return { subscore: 0, weight: 12, reason: null };
    return {
      subscore: clamp01(subscore),
      weight: 12,
      reason: `Channel is young and prolific (~${perMonth.toFixed(1)} videos/month)`,
      positive: true,
    };
  }

  function scoreTitlePatterns(signals) {
    const title = signals.title;
    if (!title) return null;
    let hits = 0;
    for (const re of C.CLICKBAIT_TITLE_PATTERNS) if (re.test(title)) hits++;
    const words = title.split(/\s+/).filter(Boolean);
    const capsWords = words.filter((w) => w.length > 2 && w === w.toUpperCase() && /[A-Z]/.test(w));
    const capsRatio = words.length ? capsWords.length / words.length : 0;
    if (capsRatio > 0.5) hits++;
    if (hits === 0) return { subscore: 0, weight: 10, reason: null };
    const subscore = clamp01(hits / 3);
    return {
      subscore,
      weight: 10,
      reason: 'Title uses clickbait / content-mill phrasing',
      positive: true,
    };
  }

  function scoreDescriptionPatterns(signals) {
    const desc = signals.description || '';
    const len = signals.lengthSeconds || 0;
    let hits = 0;
    let matchedBoilerplate = false;
    for (const re of C.DESCRIPTION_BOILERPLATE_PATTERNS) {
      if (re.test(desc)) {
        hits += 2; // strong tell, weight it more
        matchedBoilerplate = true;
      }
    }
    if (desc.trim().length < 50 && len > 8 * 60) hits++;
    const hasTimestamps = /\d{1,2}:\d{2}(:\d{2})?/.test(desc);
    if (len > 15 * 60 && !hasTimestamps && desc.trim().length < 300) hits++;
    if (hits === 0) return { subscore: 0, weight: 8, reason: null };
    return {
      subscore: clamp01(hits / 4),
      weight: 8,
      reason: matchedBoilerplate
        ? 'Description references AI-generation tools or stock-footage sources'
        : 'Long video with a very thin description and no chapter timestamps',
      positive: true,
    };
  }

  function scoreTitleTemplateUniformity(signals) {
    const titles = signals.recentUploadTitles;
    if (!titles || titles.length < 5) return null;
    let matches = 0;
    for (const t of titles) {
      if (C.CLICKBAIT_TITLE_PATTERNS.some((re) => re.test(t))) matches++;
    }
    const ratio = matches / titles.length;
    if (ratio < 0.34) return { subscore: 0, weight: 6, reason: null };
    return {
      subscore: clamp01(ratio),
      weight: 6,
      reason: 'Most recent uploads follow the same formulaic title template',
      positive: true,
    };
  }

  function scoreLengthDensityMismatch(signals) {
    const len = signals.lengthSeconds || 0;
    const title = signals.title || '';
    if (len < 15 * 60) return null;
    const genericTitle = title.length < 25 || /^(video|untitled)/i.test(title);
    if (!genericTitle) return { subscore: 0, weight: 4, reason: null };
    return {
      subscore: 0.6,
      weight: 4,
      reason: 'Unusually long video with a generic, low-effort title',
      positive: true,
    };
  }

  // Order here is what drives breakdown/reasons ordering in the UI. maxWeight
  // must match each scorer's own `weight` (duplicated here because a scorer
  // returns null -- no weight at all -- when it lacks enough data to run).
  // `unevaluatedHint` explains what's missing when a signal returns null.
  // `cleanReason` explains a signal that WAS evaluated but found no AI
  // evidence (i.e. the scorer returned `reason: null`) -- both are static
  // text, so they need to stay true regardless of which video triggered them.
  const SIGNAL_SCORERS = [
    {
      key: 'disclosure',
      label: "YouTube's own disclosure label",
      maxWeight: 40,
      fn: scoreDisclosure,
      unevaluatedHint: "No disclosure label present on this video -- absence isn't scored as evidence",
    },
    {
      key: 'uploadCadence',
      label: 'Upload cadence',
      maxWeight: 20,
      fn: scoreUploadCadence,
      unevaluatedHint: 'Needs at least 4 recent uploads from this channel',
      cleanReason: "Channel doesn't upload unusually often",
    },
    {
      key: 'channelAgeVsVolume',
      label: 'Channel age vs. output volume',
      maxWeight: 12,
      fn: scoreChannelAgeVsVolume,
      unevaluatedHint: 'Needs a YouTube Data API key (optional, set in Settings)',
      cleanReason: "Channel's age and upload volume look typical",
    },
    {
      key: 'titlePatterns',
      label: 'Title patterns',
      maxWeight: 10,
      fn: scoreTitlePatterns,
      unevaluatedHint: 'No title text available for this video',
      cleanReason: "Title doesn't use clickbait / content-mill phrasing",
    },
    {
      key: 'descriptionPatterns',
      label: 'Description patterns',
      maxWeight: 8,
      fn: scoreDescriptionPatterns,
      unevaluatedHint: 'No description text available for this video',
      cleanReason: "Description doesn't reference AI-generation tools or stock-footage sources",
    },
    {
      key: 'titleTemplateUniformity',
      label: 'Title template uniformity',
      maxWeight: 6,
      fn: scoreTitleTemplateUniformity,
      unevaluatedHint: 'Needs at least 5 recent upload titles from this channel',
      cleanReason: "Recent uploads don't follow a repeated title template",
    },
    {
      key: 'lengthDensityMismatch',
      label: 'Length vs. title mismatch',
      maxWeight: 4,
      fn: scoreLengthDensityMismatch,
      unevaluatedHint: 'Only applies to videos 15+ minutes long',
      cleanReason: "Title isn't generic/low-effort for a video this long",
    },
  ];

  /**
   * @param {object} signals VideoSignals
   * @param {object} [opts]
   * @param {string} [opts.strictness] 'lenient' | 'balanced' | 'strict'
   * @param {object} [opts.override] { trusted: bool, flagged: bool } manual video override
   * @returns {{ score:number, band:string, confidence:string, reasons:string[], overridden:boolean,
   *   totalWeight:number, breakdown:Array<{key:string, label:string, maxWeight:number, evaluated:boolean,
   *   weight?:number, subscore?:number, contribution?:number, reason?:string|null, hint?:string}> }}
   */
  function scoreVideo(signals, opts) {
    opts = opts || {};
    if (opts.override) {
      if (opts.override.trusted) {
        return {
          score: 0,
          band: 'human',
          confidence: 'manual',
          reasons: ['You marked this video as human-made'],
          overridden: true,
          breakdown: [],
          totalWeight: 0,
        };
      }
      if (opts.override.flagged) {
        return {
          score: 100,
          band: 'ai_generated',
          confidence: 'manual',
          reasons: ['You marked this video as AI slop'],
          overridden: true,
          breakdown: [],
          totalWeight: 0,
        };
      }
    }

    let weightedSum = 0;
    let totalWeight = 0;
    let usedSignals = 0;
    const reasons = [];
    const breakdown = [];

    for (const signal of SIGNAL_SCORERS) {
      const result = signal.fn(signals);
      if (!result) {
        breakdown.push({
          key: signal.key,
          label: signal.label,
          maxWeight: signal.maxWeight,
          evaluated: false,
          hint: signal.unevaluatedHint,
        });
        continue; // insufficient data for this signal, skip entirely
      }
      totalWeight += result.weight;
      weightedSum += result.weight * result.subscore;
      usedSignals++;
      const reasonText = result.reason || signal.cleanReason;
      if (reasonText) reasons.push(reasonText);
      breakdown.push({
        key: signal.key,
        label: signal.label,
        maxWeight: signal.maxWeight,
        evaluated: true,
        weight: result.weight,
        subscore: result.subscore,
        contribution: Math.round(result.weight * result.subscore),
        reason: result.reason || null,
      });
    }

    const score = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) : 0;

    let confidence = 'low';
    if (totalWeight >= 70) confidence = 'high';
    else if (totalWeight >= 35) confidence = 'medium';

    const strictness = opts.strictness || 'balanced';
    const bands = (C.STRICTNESS_BANDS && C.STRICTNESS_BANDS[strictness]) || C.STRICTNESS_BANDS.balanced;
    let band = 'human';
    for (const b of bands) {
      if (score >= b.min) {
        band = b.id;
        break;
      }
    }

    return { score, band, confidence, reasons, overridden: false, breakdown, totalWeight };
  }

  /**
   * Cheap synchronous pass usable immediately for feed/search thumbnails,
   * before any network fetch (channel RSS) has resolved. Only looks at
   * title text. Callers should replace this with the full scoreVideo()
   * result once it becomes available.
   */
  function quickScoreFromTitle(title, opts) {
    return scoreVideo({ title }, opts);
  }

  /**
   * Blends a video's heuristic score with its community vote counts.
   * Pure -- no network access, consistent with the rest of this file.
   * @param {object} result scoreVideo() output
   * @param {{aiVotes:number, humanVotes:number, total:number, communityScore:number|null}|null} community
   * @param {object} [opts]
   * @param {string} [opts.strictness]
   * @returns {object} a new result object; does not mutate `result`
   */
  function blendCommunityScore(result, community, opts) {
    if (!result || result.overridden) return result;
    if (!community || !community.total) return result;
    opts = opts || {};

    const weight = Math.min(0.5, community.total / 10);
    const blendedScore = Math.round(result.score * (1 - weight) + community.communityScore * weight);

    const strictness = opts.strictness || 'balanced';
    const bands = (C.STRICTNESS_BANDS && C.STRICTNESS_BANDS[strictness]) || C.STRICTNESS_BANDS.balanced;
    let band = 'human';
    for (const b of bands) {
      if (blendedScore >= b.min) {
        band = b.id;
        break;
      }
    }

    const communityVotes = { ai: community.aiVotes || 0, human: community.humanVotes || 0, total: community.total };
    const reasons = result.reasons.concat([
      `Community: ${communityVotes.human} of ${communityVotes.total} votes say human-made, ${communityVotes.ai} say AI-generated`,
    ]);

    return Object.assign({}, result, {
      score: blendedScore,
      band,
      reasons,
      communityVotes,
      communityBlendWeight: weight,
    });
  }

  AISlop.heuristics = { scoreVideo, quickScoreFromTitle, blendCommunityScore, median, daysBetween };
})(typeof self !== 'undefined' ? self : this);
