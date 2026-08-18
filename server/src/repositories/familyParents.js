// Backlog 1.3 (multi-parent support) — which Google accounts are authorized
// to sign into which family. Separate from google_credentials (the family's
// one shared Calendar connection) on purpose: see schema.sql's comment on
// family_parents for why these don't grow together.
import { getPool } from '../db/pool.js';

export async function findByEmail(googleAccountEmail, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from family_parents where google_account_email = $1 and deleted_at is null`,
    [googleAccountEmail]
  );
  return rows[0] ?? null;
}

export async function create({ familyId, googleAccountEmail }, pool = getPool()) {
  const { rows } = await pool.query(
    `insert into family_parents (family_id, google_account_email) values ($1,$2) returning *`,
    [familyId, googleAccountEmail]
  );
  return rows[0];
}

export async function findAllForFamily(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from family_parents where family_id = $1 and deleted_at is null order by created_at asc`,
    [familyId]
  );
  return rows;
}
