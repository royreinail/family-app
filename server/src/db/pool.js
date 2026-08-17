// Single place that knows how to get a Postgres connection pool.
// Production wires this to a real `pg` Pool via DATABASE_URL (Railway sets
// this automatically for its managed Postgres add-on). Tests inject an
// in-memory pg-mem pool instead — see tests/setup/testDb.js — so the whole
// pipeline/repository layer runs unmodified in both places.
import pg from 'pg';

let pool = null;

export function createPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  pool = new pg.Pool({
    connectionString,
    ssl: process.env.PGSSL === 'false' ? false : { rejectUnauthorized: false },
  });
  return pool;
}

export function setPool(customPool) {
  pool = customPool;
}

export function getPool() {
  if (!pool) throw new Error('DB pool not initialized. Call createPool() or setPool() first.');
  return pool;
}
