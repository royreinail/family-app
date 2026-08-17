import * as familiesRepo from '../repositories/families.js';

export function requireFamily(req, res, next) {
  if (!req.session?.familyId) {
    return res.status(401).json({ error: 'Not signed in.' });
  }
  req.familyId = req.session.familyId;
  next();
}

// Settings Home is PIN-gated on top of the Google session (architecture doc:
// "the PIN is a lightweight secondary gate, not a serious security
// boundary"). This just checks a short-lived flag the client sets after a
// successful /api/family/pin/verify call — enforced properly server-side by
// each settings-editing route calling requirePinVerified. Before onboarding
// step 6 sets a PIN at all, edits (e.g. adding family members in step 3)
// pass through unchallenged — there's nothing to verify against yet.
export async function requirePinVerified(req, res, next) {
  const family = await familiesRepo.findById(req.familyId);
  if (!family?.pin_hash) return next();
  if (!req.session?.pinVerifiedAt || Date.now() - req.session.pinVerifiedAt > 30 * 60 * 1000) {
    return res.status(401).json({ error: 'PIN verification required.' });
  }
  next();
}
