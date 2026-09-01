#!/usr/bin/env node
/**
 * Lightweight sanity tests for the scoring engine, run directly with Node
 * (no browser needed) via vm so constants.js/heuristics.js's shared
 * `self.AISlop` namespace pattern works exactly as it does in the extension.
 * Run: node test/heuristics.test.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB = path.join(__dirname, '..', 'src', 'lib');
const sandbox = {};
sandbox.self = sandbox;
vm.createContext(sandbox);

for (const file of ['constants.js', 'heuristics.js']) {
  const code = fs.readFileSync(path.join(LIB, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

const { heuristics } = sandbox.AISlop;

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('FAIL: ' + msg);
  }
}

// 1. A creator-disclosed synthetic video should be flagged strongly regardless of anything else.
{
  const r = heuristics.scoreVideo({
    title: 'A perfectly normal, well written title',
    description: 'A thoughtful, detailed description with real content.',
    disclosedSynthetic: true,
  });
  assert(r.band === 'ai_generated' || r.band === 'ai_assisted', 'disclosed synthetic video should be flagged (got ' + r.band + ')');
  assert(r.score >= 40, 'disclosed synthetic video should score reasonably high (got ' + r.score + ')');
}

// 2. A vanilla, low-signal video should land in the human/uncertain range, not get flagged as AI.
{
  const r = heuristics.scoreVideo({
    title: 'My trip to the mountains last weekend',
    description: 'Some personal thoughts about my hiking trip, includes timestamps 0:00 intro 2:30 summit.',
    lengthSeconds: 600,
  });
  assert(r.band === 'human' || r.band === 'uncertain', 'low-signal video should not be flagged as AI (got ' + r.band + ')');
}

// 3. Extremely high upload cadence (many videos/day) should push the score up.
{
  const now = Date.now();
  const dates = [];
  for (let i = 0; i < 10; i++) dates.push(new Date(now - i * 4 * 60 * 60 * 1000).toISOString()); // every 4h
  const r = heuristics.scoreVideo({
    title: 'Top 10 facts about the ocean you did not know',
    recentUploadDates: dates,
  });
  assert(r.score > 20, 'high-cadence + clickbait title should score above baseline (got ' + r.score + ')');
}

// 4. Manual "trusted" override always wins, even with disclosure true.
{
  const r = heuristics.scoreVideo(
    { title: 'x', disclosedSynthetic: true },
    { override: { trusted: true } }
  );
  assert(r.band === 'human' && r.overridden === true, 'trusted override should force human band');
}

// 5. Manual "flagged" override always wins.
{
  const r = heuristics.scoreVideo(
    { title: 'A totally normal title' },
    { override: { flagged: true } }
  );
  assert(r.band === 'ai_generated' && r.overridden === true, 'flagged override should force ai_generated band');
}

// 6. Strictness changes band cutoffs for the same numeric score.
{
  const signals = { title: 'Top 10 shocking facts you won\'t believe', description: '' };
  const lenient = heuristics.scoreVideo(signals, { strictness: 'lenient' });
  const strict = heuristics.scoreVideo(signals, { strictness: 'strict' });
  assert(lenient.score === strict.score, 'strictness should not change the raw score');
  const order = { human: 0, uncertain: 1, ai_assisted: 2, ai_generated: 3 };
  assert(order[strict.band] >= order[lenient.band], 'strict mode should never be less aggressive than lenient for the same score');
}

// 7. scoreVideo() exposes a per-signal breakdown, in a fixed order, one entry per signal.
{
  const r = heuristics.scoreVideo({ title: 'A perfectly normal title' });
  assert(Array.isArray(r.breakdown), 'result should include a breakdown array');
  assert(r.breakdown.length === 7, 'breakdown should have one entry per signal (got ' + (r.breakdown && r.breakdown.length) + ')');
  assert(r.breakdown[0].key === 'disclosure', 'first breakdown entry should be the disclosure signal (got ' + (r.breakdown[0] && r.breakdown[0].key) + ')');
}

// 8. A signal with insufficient data is marked unevaluated but still reports its max weight;
//    a signal that did fire reports its weight/subscore/contribution.
{
  const r = heuristics.scoreVideo({ title: 'A perfectly normal title', disclosedSynthetic: true });
  const uploadCadence = r.breakdown.find((b) => b.key === 'uploadCadence');
  assert(uploadCadence && uploadCadence.evaluated === false, 'uploadCadence has no upload dates, should be unevaluated');
  assert(uploadCadence && uploadCadence.maxWeight === 20, 'uploadCadence maxWeight should be 20 (got ' + (uploadCadence && uploadCadence.maxWeight) + ')');
  const disclosure = r.breakdown.find((b) => b.key === 'disclosure');
  assert(disclosure && disclosure.evaluated === true, 'disclosure signal fired, should be evaluated');
  assert(disclosure && disclosure.weight === 40 && disclosure.subscore === 1 && disclosure.contribution === 40, 'disclosure breakdown entry should report weight 40, subscore 1, contribution 40 (got ' + JSON.stringify(disclosure) + ')');
}

// 9. totalWeight is the sum of weights of only the evaluated signals (matches what confidence is derived from).
{
  const r = heuristics.scoreVideo({ title: 'A perfectly normal title', disclosedSynthetic: true });
  const evaluatedWeightSum = r.breakdown.filter((b) => b.evaluated).reduce((sum, b) => sum + b.weight, 0);
  assert(r.totalWeight === evaluatedWeightSum, 'totalWeight should equal the sum of evaluated signals\' weights (got ' + r.totalWeight + ' vs ' + evaluatedWeightSum + ')');
}

// 10. An overridden result (manual trust/flag) has no signal breakdown -- it wasn't derived from signals.
{
  const r = heuristics.scoreVideo({ title: 'x' }, { override: { trusted: true } });
  assert(Array.isArray(r.breakdown) && r.breakdown.length === 0, 'overridden result should have an empty breakdown');
  assert(r.totalWeight === 0, 'overridden result should have totalWeight 0');
}

// 9b. A clean (evaluated, no AI evidence found) signal explains itself in `reasons`,
//     directly supporting a human-made verdict, instead of generic filler text.
{
  const r = heuristics.scoreVideo({
    title: 'My trip to the mountains last weekend',
    description: 'Some personal thoughts about my hiking trip, includes timestamps 0:00 intro 2:30 summit.',
    lengthSeconds: 600,
  });
  const titlePatterns = r.breakdown.find((b) => b.key === 'titlePatterns');
  assert(titlePatterns.evaluated === true, 'titlePatterns should be evaluated for a video with a title');
  assert(!titlePatterns.reason, 'titlePatterns should have no AI-evidence reason for a clean title');
  assert(r.reasons.some((reason) => /clickbait|content-mill/i.test(reason)), 'reasons should include an explicit "no clickbait" explanation (got ' + JSON.stringify(r.reasons) + ')');
  assert(!r.reasons.includes('No strong AI-content signals detected'), 'reasons should no longer fall back to generic filler when clean signals explain themselves');
}

// 10b. An unevaluated breakdown entry explains what's missing, not just "not enough data".
{
  const r = heuristics.scoreVideo({ title: 'A perfectly normal title' });
  const uploadCadence = r.breakdown.find((b) => b.key === 'uploadCadence');
  assert(typeof uploadCadence.hint === 'string' && uploadCadence.hint.length > 0, 'unevaluated entries should carry a hint explaining why (got ' + JSON.stringify(uploadCadence) + ')');
}

// 11. blendCommunityScore: no community data is a no-op.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' });
  const blended = heuristics.blendCommunityScore(base, null);
  assert(blended.score === base.score, 'blendCommunityScore(result, null) should not change the score');
  assert(blended.communityVotes === undefined, 'no communityVotes field when there is no community data');
}

// 12. blendCommunityScore: zero total votes is a no-op.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' });
  const blended = heuristics.blendCommunityScore(base, { aiVotes: 0, humanVotes: 0, total: 0, communityScore: null });
  assert(blended.score === base.score, 'zero votes should not change the score');
}

// 13. blendCommunityScore: a manual override always bypasses blending.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' }, { override: { trusted: true } });
  const blended = heuristics.blendCommunityScore(base, { aiVotes: 20, humanVotes: 0, total: 20, communityScore: 100 });
  assert(blended.score === 0 && blended.band === 'human', 'a manual override must not be perturbed by community votes');
}

// 14. blendCommunityScore: weight ramps with vote count and caps at 0.5.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' }); // score 0, no signals fired
  const fewVotes = heuristics.blendCommunityScore(base, { aiVotes: 1, humanVotes: 0, total: 1, communityScore: 100 });
  const manyVotes = heuristics.blendCommunityScore(base, { aiVotes: 20, humanVotes: 0, total: 20, communityScore: 100 });
  assert(fewVotes.communityBlendWeight < manyVotes.communityBlendWeight, 'more votes should mean more blend weight');
  assert(manyVotes.communityBlendWeight === 0.5, 'blend weight caps at 0.5 regardless of vote count');
  assert(fewVotes.score < manyVotes.score, 'more AI votes at higher weight should pull the score up further');
}

// 15. blendCommunityScore: exposes raw counts and a human-readable reason.
{
  const base = heuristics.scoreVideo({ title: 'A normal title' });
  const blended = heuristics.blendCommunityScore(base, { aiVotes: 3, humanVotes: 7, total: 10, communityScore: 30 });
  assert(blended.communityVotes.ai === 3 && blended.communityVotes.human === 7 && blended.communityVotes.total === 10, 'raw vote counts should be exposed');
  assert(blended.reasons.some((r) => r.includes('Community')), 'a community-vote reason should be appended');
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
