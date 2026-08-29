#!/usr/bin/env node
/** Minimal sanity check: parse every source .js file for syntax errors. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'src');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(SRC, []);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
    console.log('OK   ' + path.relative(SRC, f));
  } catch (e) {
    failed++;
    console.error('FAIL ' + path.relative(SRC, f));
    console.error(e.stderr ? e.stderr.toString() : e.message);
  }
}
if (failed) {
  console.error(`\n${failed} file(s) failed to parse.`);
  process.exit(1);
}
console.log(`\nAll ${files.length} files parsed OK.`);
