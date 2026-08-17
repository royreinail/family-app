// In-memory Postgres-compatible DB for tests (pg-mem). Lets the acceptance
// fixtures exercise the real repositories/pipeline/rule-engine code — same
// SQL, same pool interface — without needing a real Postgres server running
// in CI or on a laptop. Production always uses a real `pg` Pool (see db/pool.js).
import { newDb } from 'pg-mem';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(path.join(__dirname, '../../src/db/schema.sql'), 'utf8');

export function createTestPool() {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({ name: 'gen_random_uuid', returns: 'uuid', implementation: () => randomUUID(), impure: true });
  db.registerExtension('pgcrypto', () => {});

  const schemaWithoutCreateExtension = schemaSql.replace(/create extension.*;\n/i, '');
  db.public.none(schemaWithoutCreateExtension);

  const { Pool } = db.adapters.createPg();
  return new Pool();
}
