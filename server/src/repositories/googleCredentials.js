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

// Real bug caught in live testing: `upsert` is called on *every* OAuth
// round-trip — first connect, a reconnect after a dead refresh token
// (isReauthRequiredError's flow), any later re-sign-in — none of which ever
// pass `calendarId` (auth.js's callback only ever passes the token fields).
// With a hardcoded `calendarId = 'primary'` default and an unconditional
// `calendar_id = $7` in the UPDATE, every one of those silently overwrote
// backlog 2.1's whole point: a family explicitly picks the shared family
// calendar in Settings once, then a routine reconnect quietly resets it
// back to 'primary' (the signed-in account's own calendar) with no
// notification at all — exactly what was reported ("still logged on my
// calendar, not the family calendar"). `calendarId` now defaults to `null`
// ("caller didn't specify one — leave whatever's already there alone") and
// the UPDATE coalesces onto the existing value instead of blindly
// overwriting; only the INSERT path (a genuinely new row, nothing to
// preserve) still needs a real fallback.
export async function upsert({ familyId, googleAccountEmail, accessToken, refreshToken, scope, expiryDate, calendarId = null }, pool = getPool()) {
  const existing = await findByFamilyId(familyId, pool);
  if (existing) {
    const { rows } = await pool.query(
      `update google_credentials set
         google_account_email = $2, access_token = $3, refresh_token = coalesce($4, refresh_token),
         scope = $5, expiry_date = $6, calendar_id = coalesce($7, calendar_id)
       where id = $1 returning *`,
      [existing.id, googleAccountEmail, accessToken, refreshToken ?? null, scope, expiryDate ?? null, calendarId]
    );
    return rows[0];
  }
  const { rows } = await pool.query(
    `insert into google_credentials (family_id, google_account_email, access_token, refresh_token, scope, expiry_date, calendar_id)
     values ($1,$2,$3,$4,$5,$6,$7) returning *`,
    // No existing row to preserve here, so a genuinely new connection still
    // needs a real starting value — 'primary' (the pre-2.1 default) when
    // the caller hasn't specified one.
    [familyId, googleAccountEmail, accessToken, refreshToken ?? null, scope, expiryDate ?? null, calendarId ?? 'primary']
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
