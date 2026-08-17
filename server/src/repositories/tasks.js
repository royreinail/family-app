import { getPool } from '../db/pool.js';

export async function create(
  { familyId, title, dueDate, importance = 'Med', ownerFamilyMemberId, reminderPolicy = 'none', reminderDatetime, sourceExtractionLogId },
  pool = getPool()
) {
  const { rows } = await pool.query(
    `insert into tasks (family_id, title, due_date, importance, owner_family_member_id, reminder_policy, reminder_datetime, source_extraction_log_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [familyId, title, dueDate ?? null, importance, ownerFamilyMemberId ?? null, reminderPolicy, reminderDatetime ?? null, sourceExtractionLogId ?? null]
  );
  return rows[0];
}

export async function findAllForFamily(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from tasks where family_id = $1 and deleted_at is null order by due_date asc nulls last, created_at asc`,
    [familyId]
  );
  return rows;
}

export async function findBySourceExtractionLogId(extractionLogId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from tasks where source_extraction_log_id = $1 and deleted_at is null`,
    [extractionLogId]
  );
  return rows[0] ?? null;
}

export async function softDelete(id, pool = getPool()) {
  await pool.query(`update tasks set deleted_at = now() where id = $1`, [id]);
}

export async function markDone(id, pool = getPool()) {
  const { rows } = await pool.query(`update tasks set status = 'done' where id = $1 returning *`, [id]);
  return rows[0];
}

export async function findDueReminders(pool = getPool()) {
  const { rows } = await pool.query(
    `select * from tasks
     where deleted_at is null and reminder_policy = 'requested'
       and reminder_datetime is not null and reminder_datetime <= now()
       and reminder_sent_at is null`
  );
  return rows;
}

export async function markReminderSent(id, pool = getPool()) {
  await pool.query(`update tasks set reminder_sent_at = now() where id = $1`, [id]);
}
