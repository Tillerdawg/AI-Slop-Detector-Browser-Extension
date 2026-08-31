#!/usr/bin/env node
/**
 * Cross-platform Python launcher: modern Mac/Linux installs typically only
 * have `python3` on PATH, while the official Windows installer typically
 * only provides `python`. Tries each in turn so `npm run icons` works
 * either way, then runs the given script with any remaining args.
 */
const { spawnSync } = require('child_process');

const CANDIDATES = ['python3', 'python'];
const scriptArgs = process.argv.slice(2);

function has(cmd) {
  const probe = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !probe.error;
}

const interpreter = CANDIDATES.find(has);
if (!interpreter) {
  console.error(
    `Couldn't find a Python interpreter (tried: ${CANDIDATES.join(', ')}). Install Python 3 and make sure it's on PATH.`
  );
  process.exit(1);
}

const result = spawnSync(interpreter, scriptArgs, { stdio: 'inherit' });
process.exit(result.status ?? 1);
