import { getPool } from '../db/pool.js';
import bcrypt from 'bcryptjs';

export async function create({ name, timezone = 'UTC' }, pool = getPool()) {
  const { rows } = await pool.query(
    `insert into families (name, timezone) values ($1,$2) returning *`,
    [name, timezone]
  );
  return rows[0];
}

export async function findById(id, pool = getPool()) {
  const { rows } = await pool.query(`select * from families where id = $1 and deleted_at is null`, [id]);
  return rows[0] ?? null;
}

export async function updateTimezone(id, timezone, pool = getPool()) {
  const { rows } = await pool.query(`update families set timezone = $2 where id = $1 returning *`, [id, timezone]);
  return rows[0];
}

export async function setPin(id, pin, pool = getPool()) {
  const pinHash = bcrypt.hashSync(pin, 10);
  const { rows } = await pool.query(`update families set pin_hash = $2 where id = $1 returning *`, [id, pinHash]);
  return rows[0];
}

export async function verifyPin(id, pin, pool = getPool()) {
  const family = await findById(id, pool);
  if (!family?.pin_hash) return false;
  return bcrypt.compareSync(pin, family.pin_hash);
}

// -- Multi-parent support (backlog 1.3) --------------------------------------

export async function findByInviteCode(code, pool = getPool()) {
  const { rows } = await pool.query(`select * from families where invite_code = $1 and deleted_at is null`, [code]);
  return rows[0] ?? null;
}

// Uppercase, digit-heavy, and excludes visually-confusable characters
// (0/O, 1/I/L) since this is meant to be read off one phone screen and
// typed into another by hand, not just tapped through a link.
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateInviteCode() {
  return Array.from({ length: 8 }, () => INVITE_CODE_ALPHABET[Math.floor(Math.random() * INVITE_CODE_ALPHABET.length)]).join('');
}

// Idempotent: returns the family's existing code if it already has one,
// otherwise mints and persists a new one. Checked-then-insert (not a raw
// unique-constraint-violation catch) so behavior doesn't depend on how a
// given pg driver/pg-mem surfaces that error.
export async function ensureInviteCode(id, pool = getPool()) {
  const family = await findById(id, pool);
  if (family?.invite_code) return family.invite_code;

  let code;
  for (let attempt = 0; attempt < 5 && !code; attempt++) {
    const candidate = generateInviteCode();
    const collision = await findByInviteCode(candidate, pool);
    if (!collision) code = candidate;
  }
  if (!code) throw new Error('Could not generate a unique invite code');

  const { rows } = await pool.query(`update families set invite_code = $2 where id = $1 returning *`, [id, code]);
  return rows[0].invite_code;
}
