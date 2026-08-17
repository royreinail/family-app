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
