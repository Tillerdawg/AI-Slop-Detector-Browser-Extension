import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(ROOT, '..', 'src', 'index.js');
const SCHEMA_PATH = path.join(ROOT, '..', 'schema.sql');

const DEFAULT_BINDINGS = {
  IP_SALT: 'test-ip-salt',
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

// `omit` is a list of binding names to leave out entirely -- setting a key to
// `undefined` is not the same as the binding being absent from `env`, and the
// fail-closed checks for missing secrets need the genuinely-absent case.
export async function makeTestWorker(bindings, omit) {
  const merged = Object.assign({}, DEFAULT_BINDINGS, bindings || {});
  for (const key of omit || []) delete merged[key];
  const mf = new Miniflare({
    modules: true,
    scriptPath: WORKER_PATH,
    d1Databases: ['DB'],
    bindings: merged,
  });
  const db = await mf.getD1Database('DB');
  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  for (const statement of splitStatements(schema)) {
    await db.prepare(statement).run();
  }
  return { mf, db };
}
