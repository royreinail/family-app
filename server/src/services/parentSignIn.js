// Backlog 1.3 (multi-parent support) — resolves which family a signing-in
// Google account belongs to. Split out from routes/auth.js on purpose: this
// branching is the actual bug-prone part of multi-parent sign-in (get it
// wrong and a returning parent's cookie expiring spawns a duplicate family,
// or a joining parent lands in a brand-new one instead of the shared one),
// while the surrounding code in auth.js is just Google token exchange that
// can't be unit-tested without mocking the Google API anyway. This function
// takes an already-known email/invite code and has zero network calls, so
// it's fully testable against the real repository/DB layer.
//
// Checked in order:
//   1. Already mid-flow in this exact browser session (e.g. ConnectCalendarStep
//      re-running this same OAuth flow) — keep using that family.
//   2. A returning parent, cookie expired/new device — matched by email
//      against family_parents; falls back to google_credentials for parents
//      who signed up before family_parents existed, so a returning
//      single-parent user's cookie expiring never spawns a duplicate family.
//   3. A brand new Google account arriving with a valid invite code — joins
//      that family instead of creating a new one.
// Returns null (caller creates a new family) if none of the above match.
import * as familiesRepo from '../repositories/families.js';
import * as familyParentsRepo from '../repositories/familyParents.js';
import * as googleCredentialsRepo from '../repositories/googleCredentials.js';

export async function resolveFamilyForSignIn({ email, sessionFamilyId, inviteCode }) {
  if (sessionFamilyId) {
    const family = await familiesRepo.findById(sessionFamilyId);
    if (family) return family;
  }

  const parentRecord = await familyParentsRepo.findByEmail(email);
  if (parentRecord) {
    const family = await familiesRepo.findById(parentRecord.family_id);
    if (family) return family;
  } else {
    const legacyCredentials = await googleCredentialsRepo.findByEmail(email);
    if (legacyCredentials) {
      const family = await familiesRepo.findById(legacyCredentials.family_id);
      if (family) return family;
    }
  }

  if (inviteCode) {
    const family = await familiesRepo.findByInviteCode(inviteCode);
    if (family) return family;
  }

  return null;
}
