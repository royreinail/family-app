import { getPool } from '../db/pool.js';

export async function create({ familyId, rawInput, senderIdentifier, externalMessageId, replyToExternalId }, pool = getPool()) {
  const { rows } = await pool.query(
    `insert into extraction_log (family_id, raw_input, sender_identifier, external_message_id, reply_to_external_id, state)
     values ($1,$2,$3,$4,$5,'received') returning *`,
    [familyId, rawInput, senderIdentifier ?? null, externalMessageId, replyToExternalId ?? null]
  );
  return rows[0];
}

export async function findDuplicate({ familyId, externalMessageId, excludeId }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from extraction_log
     where family_id = $1 and external_message_id = $2 and id <> $3 and deleted_at is null
     order by created_at asc limit 1`,
    [familyId, externalMessageId, excludeId]
  );
  return rows[0] ?? null;
}

export async function updateState(id, { state, aiCandidate, resultingEventRef, firedRule, error }, pool = getPool()) {
  const { rows } = await pool.query(
    `update extraction_log set
       state = coalesce($2, state),
       ai_candidate = coalesce($3::jsonb, ai_candidate),
       resulting_event_ref = coalesce($4::jsonb, resulting_event_ref),
       fired_rule = coalesce($5, fired_rule),
       error = coalesce($6, error),
       updated_at = now()
     where id = $1 returning *`,
    [id, state ?? null, aiCandidate ? JSON.stringify(aiCandidate) : null, resultingEventRef ? JSON.stringify(resultingEventRef) : null, firedRule ?? null, error ?? null]
  );
  return rows[0];
}

export async function findById(id, pool = getPool()) {
  const { rows } = await pool.query(`select * from extraction_log where id = $1`, [id]);
  return rows[0] ?? null;
}

export async function findByExternalId({ familyId, externalMessageId }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from extraction_log where family_id = $1 and external_message_id = $2 and deleted_at is null
     order by created_at desc limit 1`,
    [familyId, externalMessageId]
  );
  return rows[0] ?? null;
}

// Most recent successful write (event or task) from this sender — used by "undo".
export async function findLatestWrittenBySender({ familyId, senderIdentifier }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from extraction_log
     where family_id = $1 and sender_identifier = $2 and deleted_at is null
       and state in ('written','needs_time')
     order by created_at desc limit 1`,
    [familyId, senderIdentifier]
  );
  return rows[0] ?? null;
}
