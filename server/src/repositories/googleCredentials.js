import { getPool } from '../db/pool.js';

export async function findByFamilyId(familyId, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from google_credentials where family_id = $1 and deleted_at is null order by created_at desc limit 1`,
    [familyId]
  );
  return rows[0] ?? null;
}

// Backward-compat lookup for backlog 1.3: every family created before
// family_parents existed still has exactly one google_credentials row (sign-in
// and calendar-connect have always been the same OAuth action — see auth.js),
// so this lets a returning founding parent be matched to their existing
// family even before family_parents has been backfilled for them.
export async function findByEmail(googleAccountEmail, pool = getPool()) {
  const { rows } = await pool.query(
    `select * from google_credentials where google_account_email = $1 and deleted_at is null order by created_at desc limit 1`,
    [googleAccountEmail]
  );
  return rows[0] ?? null;
}

export async function upsert({ familyId, googleAccountEmail, accessToken, refreshToken, scope, expiryDate, calendarId = 'primary' }, pool = getPool()) {
  const existing = await findByFamilyId(familyId, pool);
  if (existing) {
    const { rows } = await pool.query(
      `update google_credentials set
         google_account_email = $2, access_token = $3, refresh_token = coalesce($4, refresh_token),
         scope = $5, expiry_date = $6, calendar_id = $7
       where id = $1 returning *`,
      [existing.id, googleAccountEmail, accessToken, refreshToken ?? null, scope, expiryDate ?? null, calendarId]
    );
    return rows[0];
  }
  const { rows } = await pool.query(
    `insert into google_credentials (family_id, google_account_email, access_token, refresh_token, scope, expiry_date, calendar_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    [familyId, googleAccountEmail, accessToken, refreshToken ?? null, scope, expiryDate ?? null, calendarId]
  );
  return rows[0];
}

// Backlog 2.1 — just the target calendar, leaves tokens untouched. Returns
// null if the family hasn't connected Google Calendar at all yet, so the
// route can tell "nothing to update" apart from a real write failure.
export async function setCalendarId(familyId, calendarId, pool = getPool()) {
  const { rows } = await pool.query(
    `update google_credentials set calendar_id = $2 where family_id = $1 and deleted_at is null returning *`,
    [familyId, calendarId]
  );
  return rows[0] ?? null;
}
