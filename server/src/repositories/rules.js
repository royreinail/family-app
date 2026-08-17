import { getPool } from '../db/pool.js';

export async function findActive({ familyId, ruleType, triggerType }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from rules
     where family_id = $1 and rule_type = $2 and trigger_type = $3
       and enabled = true and deleted_at is null
     order by priority asc`,
    [familyId, ruleType, triggerType]
  );
  return rows;
}

export async function create(rule, pool = getPool()) {
  const { rows } = await pool.query(
    `insert into rules (family_id, rule_type, trigger_type, name, conditions, action, priority, enabled)
     values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8) returning *`,
    [rule.familyId, rule.ruleType, rule.triggerType, rule.name, JSON.stringify(rule.conditions), JSON.stringify(rule.action), rule.priority ?? 100, rule.enabled ?? true]
  );
  return rows[0];
}

// Soft-delete-then-insert "edit" — an edited rule becomes a new row with the
// old one soft-deleted (architecture doc: no separate rule-versioning system).
export async function replace(oldRuleId, newRule, pool = getPool()) {
  await pool.query(`update rules set deleted_at = now() where id = $1`, [oldRuleId]);
  return create(newRule, pool);
}

export async function findAllForFamily(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from rules where family_id = $1 and deleted_at is null order by rule_type, trigger_type, priority`,
    [familyId]
  );
  return rows;
}
