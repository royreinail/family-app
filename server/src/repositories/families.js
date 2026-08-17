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
