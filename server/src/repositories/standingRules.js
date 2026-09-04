// C1 (standing rules taught in conversation) — a "pending rule record in
// the DB" per D-3's required flow: a rule detected by the LLM is held here
// with status 'pending' until the sender confirms it with a bare yes/no
// reply (matched directly against this row — never a second LLM call, see
// pipeline.js's resolveStandingRule), then flips to 'active' (applied to
// every future matching message) or 'discarded' (kept, not deleted, so
// there's a real record of what was proposed and turned down).
import { getPool } from '../db/pool.js';

export async function create(
  { familyId, ruleText, ruleKind, matchKeyword, field, value, paramName, paramValue, senderIdentifier },
  pool = getPool()
) {
  const { rows } = await pool.query(
    `insert into standing_rules
       (family_id, rule_text, rule_kind, match_keyword, field, value, param_name, param_value, sender_identifier)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [familyId, ruleText, ruleKind, matchKeyword ?? null, field ?? null, value ?? null, paramName ?? null, paramValue ?? null, senderIdentifier ?? null]
  );
  return rows[0];
}

// The most recent still-pending rule this sender proposed — the yes/no
// reply resolves THIS one. Recency-bounded (same 30-minute convention as
// A2's findRecentPendingDisambiguation) so a bare "yes" sent long after an
// unrelated, forgotten proposal doesn't silently confirm it.
export async function findRecentPending({ familyId, senderIdentifier, withinMs = 30 * 60 * 1000 }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from standing_rules
     where family_id = $1 and sender_identifier = $2 and status = 'pending' and deleted_at is null
     order by created_at desc limit 1`,
    [familyId, senderIdentifier]
  );
  const row = rows[0];
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.created_at).getTime();
  return ageMs <= withinMs ? row : null;
}

export async function confirm(id, pool = getPool()) {
  const { rows } = await pool.query(
    `update standing_rules set status = 'active', confirmed_at = now() where id = $1 returning *`,
    [id]
  );
  return rows[0];
}

export async function discard(id, pool = getPool()) {
  const { rows } = await pool.query(`update standing_rules set status = 'discarded' where id = $1 returning *`, [id]);
  return rows[0];
}

// Active event-default rules whose match_keyword should be checked against
// each new capture — see classify.js's applyStandingRuleDefaults.
export async function findActiveByKind({ familyId, ruleKind }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from standing_rules where family_id = $1 and rule_kind = $2 and status = 'active' and deleted_at is null
     order by created_at asc`,
    [familyId, ruleKind]
  );
  return rows;
}

// D1 — the most recently confirmed value for a named timing parameter
// (currently only 'briefing_send_time'); null when no active rule has set
// it, so the caller falls back to its own hardcoded default.
export async function findActiveParam({ familyId, paramName }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from standing_rules
     where family_id = $1 and rule_kind = 'timing_param' and param_name = $2 and status = 'active' and deleted_at is null
     order by created_at desc limit 1`,
    [familyId, paramName]
  );
  return rows[0] ?? null;
}

// "show my rules" — ordered oldest-first so the displayed numbering (and
// "delete rule N") stays stable across repeated listings, same reasoning as
// any other numbered-list-then-pick-by-index flow in this codebase (A2's
// disambiguation).
export async function findActiveForFamily(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from standing_rules where family_id = $1 and status = 'active' and deleted_at is null
     order by created_at asc`,
    [familyId]
  );
  return rows;
}

export async function softDelete(id, familyId, pool = getPool()) {
  const { rowCount } = await pool.query(
    `update standing_rules set deleted_at = now() where id = $1 and family_id = $2 and deleted_at is null`,
    [id, familyId]
  );
  return rowCount > 0;
}
