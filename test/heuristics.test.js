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

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
