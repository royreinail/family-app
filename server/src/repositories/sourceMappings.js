import { getPool } from '../db/pool.js';
import { normalizePhone } from './botConfig.js';

export async function findByIdentifier({ familyId, channelType, externalIdentifier }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from source_mappings
     where family_id = $1 and channel_type = $2 and external_identifier = $3 and deleted_at is null`,
    [familyId, channelType, normalizePhone(externalIdentifier)]
  );
  return rows[0] ?? null;
}

export async function create({ familyId, channelType, externalIdentifier, familyMemberId }, pool = getPool()) {
  const { rows } = await pool.query(
    `insert into source_mappings (family_id, channel_type, external_identifier, family_member_id)
     values ($1,$2,$3,$4) returning *`,
    [familyId, channelType, normalizePhone(externalIdentifier), familyMemberId]
  );
  return rows[0];
}

// D1 (proactive daily briefing) — the reverse direction of findByIdentifier:
// given a family member (a parent), what WhatsApp number do they actually
// receive messages at? A parent with no mapping on file simply can't be
// briefed — the sweep skips them rather than guessing a number.
export async function findByFamilyMemberId({ familyId, channelType, familyMemberId }, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from source_mappings
     where family_id = $1 and channel_type = $2 and family_member_id = $3 and deleted_at is null
     limit 1`,
    [familyId, channelType, familyMemberId]
  );
  return rows[0] ?? null;
}

export async function findAllForFamily(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from source_mappings where family_id = $1 and deleted_at is null`,
    [familyId]
  );
  return rows;
}

// Item 6's forwarded-sender default (and the correction paths built on top
// of it) can only ever fire when a real (number -> family member) row
// exists here — and until now, nothing in the app ever called create()
// above: WhatsApp connection (onboarding step 5 / Settings > WhatsApp
// Connection) only ever recorded the number on bot_config's accepted-senders
// allowlist, never who it belongs to. Real bug caught in live testing: a
// forwarded message's person-default and color assignment both silently
// no-op'd because senderFamilyMember always resolved to null. Called from
// the WhatsApp-connect route now, for both the first-time confirm and a
// later re-link (e.g. Settings, to fix a number connected before this
// existed) — same normalized-digits matching isAcceptedSender already uses,
// since Meta's webhook payload and a human-typed "+1 555…" number are
// different strings for the same number otherwise.
export async function upsertSender({ familyId, channelType, externalIdentifier, familyMemberId }, pool = getPool()) {
  const existing = await findByIdentifier({ familyId, channelType, externalIdentifier }, pool);
  if (existing) {
    const { rows } = await pool.query(
      `update source_mappings set family_member_id = $2 where id = $1 returning *`,
      [existing.id, familyMemberId]
    );
    return rows[0];
  }
  return create({ familyId, channelType, externalIdentifier, familyMemberId }, pool);
}
