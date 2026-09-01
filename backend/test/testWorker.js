import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(ROOT, '..', 'src', 'index.js');
const SCHEMA_PATH = path.join(ROOT, '..', 'schema.sql');

const DEFAULT_BINDINGS = {
  IP_SALT: 'test-ip-salt',
  TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
  VOTE_TOKEN_SECRET: 'test-vote-token-secret',
  ADMIN_TOKEN: 'test-admin-token',
};

// D1's .exec() splits on newlines and chokes on comment-only lines, so
// schema.sql (which has both) can't be applied with a single .exec() call.
// Strip `--` comment lines, then run each `;`-separated statement via
// .prepare().run() instead.
function splitStatements(sql) {
  const noComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return noComments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function makeTestWorker(bindings) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: WORKER_PATH,
    d1Databases: ['DB'],
    bindings: Object.assign({}, DEFAULT_BINDINGS, bindings || {}),
  });
  const db = await mf.getD1Database('DB');
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  for (const statement of splitStatements(schema)) {
    await db.prepare(statement).run();
  }
  return { mf, db };
}
