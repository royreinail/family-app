import { getPool } from '../db/pool.js';

export async function create({ familyId, name, calendarColor, kidIcon, isParent = false }, pool = getPool()) {
  const { rows } = await pool.query(
    `insert into family_members (family_id, name, calendar_color, kid_icon, is_parent)
     values ($1,$2,$3,$4,$5) returning *`,
    [familyId, name, calendarColor, kidIcon, isParent]
  );
  return rows[0];
}

export async function findAllForFamily(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from family_members where family_id = $1 and deleted_at is null order by created_at asc`,
    [familyId]
  );
  return rows;
}

export async function findById(id, pool = getPool()) {
  const { rows } = await pool.query(`select * from family_members where id = $1 and deleted_at is null`, [id]);
  return rows[0] ?? null;
}

export async function update(id, { name, calendarColor, kidIcon, photoUrl }, pool = getPool()) {
  const { rows } = await pool.query(
    `update family_members set
       name = coalesce($2, name),
       calendar_color = coalesce($3, calendar_color),
       kid_icon = coalesce($4, kid_icon),
       photo_url = coalesce($5, photo_url)
     where id = $1 returning *`,
    [id, name ?? null, calendarColor ?? null, kidIcon ?? null, photoUrl ?? null]
  );
  return rows[0];
}

export async function softDelete(id, pool = getPool()) {
  await pool.query(`update family_members set deleted_at = now() where id = $1`, [id]);
}
