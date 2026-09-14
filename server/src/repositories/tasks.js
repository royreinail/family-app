import { getPool } from '../db/pool.js';

export async function create(
  { familyId, title, dueDate, importance = 'Med', ownerFamilyMemberId, reminderPolicy = 'none', reminderDatetime, sourceExtractionLogId, reminderSenderIdentifier },
  pool = getPool()
) {
  const { rows } = await pool.query(
    `insert into tasks (family_id, title, due_date, importance, owner_family_member_id, reminder_policy, reminder_datetime, source_extraction_log_id, reminder_sender_identifier)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [familyId, title, dueDate ?? null, importance, ownerFamilyMemberId ?? null, reminderPolicy, reminderDatetime ?? null, sourceExtractionLogId ?? null, reminderSenderIdentifier ?? null]
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

export async function findById(id, pool = getPool()) {
  const { rows } = await pool.query(`select * from tasks where id = $1 and deleted_at is null`, [id]);
  return rows[0] ?? null;
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

// -- F2 (actionable reminders) ------------------------------------------------

// The wamid of the reminder message the bot just sent — so a later reply's
// message.context.id can be matched back to this exact task.
export async function setReminderMessageId(id, messageId, pool = getPool()) {
  await pool.query(`update tasks set reminder_message_id = $2 where id = $1`, [id, messageId]);
}

export async function findByReminderMessageId(messageId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from tasks where reminder_message_id = $1 and deleted_at is null limit 1`,
    [messageId]
  );
  return rows[0] ?? null;
}

// The parked follow-up state after "Snooze"/"Reschedule" without a target
// yet ("Snooze until when?"). Recency-bounded in JS, same reasoning as
// extractionLog's findRecentPendingFollowUp — a stray duration typed hours
// later shouldn't silently attach to a forgotten prompt.
export async function setPendingReminderAction(id, action, pool = getPool()) {
  await pool.query(`update tasks set reminder_pending_action = $2 where id = $1`, [id, action ?? null]);
}

export async function findRecentPendingReminderAction(
  { familyId, senderIdentifier, withinMs = 30 * 60 * 1000 },
  pool = getPool()
) {
  const { rows } = await pool.query(
    `select * from tasks
     where family_id = $1 and reminder_sender_identifier = $2
       and reminder_pending_action is not null and deleted_at is null
     order by reminder_sent_at desc nulls last, created_at desc limit 1`,
    [familyId, senderIdentifier]
  );
  const row = rows[0];
  if (!row) return null;
  const stamp = row.reminder_sent_at || row.created_at;
  return Date.now() - new Date(stamp).getTime() <= withinMs ? row : null;
}

// Snooze — move the reminder to a new instant and clear reminder_sent_at so
// the sweep fires it again. Deliberately does NOT touch the underlying
// calendar event (that's the separate "Reschedule" action). Also clears any
// parked pending-action state.
export async function rescheduleReminder(id, newReminderDatetimeIso, pool = getPool()) {
  const { rows } = await pool.query(
    `update tasks set reminder_datetime = $2, reminder_sent_at = null, reminder_pending_action = null
     where id = $1 returning *`,
    [id, newReminderDatetimeIso]
  );
  return rows[0];
}
