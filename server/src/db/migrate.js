// Runs schema.sql against whatever pool is currently set. Idempotent
// (every statement is `create table if not exists` / `create index if not
// exists`) so it's safe to run on every deploy — no separate migration
// framework needed at this scale (realistic ceiling ~8 tables, see
// architecture doc's rule-set scale note for the same reasoning applied to rules).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getPool } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(pool = getPool()) {
  const sql = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

// Allow `npm run migrate` to run this directly against DATABASE_URL.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createPool } = await import('./pool.js');
  const pool = createPool();
  await runMigrations(pool);
  console.log('Migrations applied.');
  await pool.end();
}
