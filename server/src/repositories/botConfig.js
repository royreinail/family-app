import { getPool } from '../db/pool.js';

export async function findByFamilyId(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from bot_config where family_id = $1 and deleted_at is null limit 1`,
    [familyId]
  );
  return rows[0] ?? null;
}

export async function findByPhoneNumberId(phoneNumberId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from bot_config where phone_number_id = $1 and deleted_at is null limit 1`,
    [phoneNumberId]
  );
  return rows[0] ?? null;
}

export async function create(
  { familyId, phoneNumberId, wabaId, botDisplayNumber, webhookVerifyToken, acceptedChatIds = [] },
  pool = getPool()
) {
  const { rows } = await pool.query(
    `insert into bot_config (family_id, phone_number_id, waba_id, bot_display_number, webhook_verify_token, accepted_chat_ids)
     values ($1,$2,$3,$4,$5,$6) returning *`,
    [familyId, phoneNumberId ?? null, wabaId ?? null, botDisplayNumber ?? null, webhookVerifyToken ?? null, acceptedChatIds]
  );
  return rows[0];
}

// Backfills phone_number_id/waba_id/bot_display_number from the current
// environment onto an existing row. Phase 1 is one shared WhatsApp bot
// number per deployment (env vars), not something set per-family through
// onboarding, so this keeps a family's row in sync with whatever the
// deployment's env vars say, self-healing rows created before this existed.
export async function syncFromEnv(id, pool = getPool()) {
  const { rows } = await pool.query(
    `update bot_config set
       phone_number_id = coalesce($2, phone_number_id),
       waba_id = coalesce($3, waba_id),
       bot_display_number = coalesce(bot_display_number, $4)
     where id = $1 returning *`,
    [id, process.env.WHATSAPP_PHONE_NUMBER_ID ?? null, process.env.WHATSAPP_WABA_ID ?? null, process.env.WHATSAPP_DISPLAY_NUMBER ?? null]
  );
  return rows[0];
}

export async function addAcceptedChatId(id, chatId, pool = getPool()) {
  const { rows } = await pool.query(
    `update bot_config set accepted_chat_ids = array_append(accepted_chat_ids, $2), connected_at = coalesce(connected_at, now())
     where id = $1 and not ($2 = any(accepted_chat_ids)) returning *`,
    [id, chatId]
  );
  return rows[0];
}

export function isAcceptedSender(botConfig, senderIdentifier) {
  return !!botConfig?.accepted_chat_ids?.includes(senderIdentifier);
}
