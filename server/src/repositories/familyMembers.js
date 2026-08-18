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

// Both scoped by familyId, not just id — without this, one family could
// edit/delete another family's member by ID alone, violating the
// family_id-on-every-table isolation principle (future-proofing item 1).
export async function update(id, familyId, { name, calendarColor, kidIcon, photoUrl }, pool = getPool()) {
  const { rows } = await pool.query(
    `update family_members set
       name = coalesce($3, name),
       calendar_color = coalesce($4, calendar_color),
       kid_icon = coalesce($5, kid_icon),
       photo_url = coalesce($6, photo_url)
     where id = $1 and family_id = $2 and deleted_at is null returning *`,
    [id, familyId, name ?? null, calendarColor ?? null, kidIcon ?? null, photoUrl ?? null]
  );
  return rows[0] ?? null;
}

export async function softDelete(id, familyId, pool = getPool()) {
  const { rowCount } = await pool.query(
    `update family_members set deleted_at = now() where id = $1 and family_id = $2 and deleted_at is null`,
    [id, familyId]
  );
  return rowCount > 0;
}
