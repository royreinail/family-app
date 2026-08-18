import { Router } from 'express';
import * as familiesRepo from '../repositories/families.js';
import * as familyMembersRepo from '../repositories/familyMembers.js';
import * as familyParentsRepo from '../repositories/familyParents.js';
import { requireFamily, requirePinVerified } from './middleware.js';

const PALETTE = ['#b3a3d9', '#e6ab84', '#a3bf9a', '#e2b6c4', '#8fc4c0', '#f0cf8e'];
const ICONS = ['🦄', '🚀', '⚽', '🐢', '🌸', '🐳', '🎨', '🦋'];

export function familyRouter() {
  const router = Router();
  router.use(requireFamily);

  router.get('/family', async (req, res) => {
    const family = await familiesRepo.findById(req.familyId);
    res.json({ id: family.id, name: family.name, timezone: family.timezone, pinSet: !!family.pin_hash });
  });

  router.get('/family/palette', (req, res) => res.json({ colors: PALETTE, icons: ICONS }));

  router.put('/family/timezone', async (req, res) => {
    const { timezone } = req.body;
    if (!timezone) return res.status(400).json({ error: 'timezone is required' });
    const family = await familiesRepo.updateTimezone(req.familyId, timezone);
    res.json({ id: family.id, timezone: family.timezone });
  });

  router.post('/family/pin', async (req, res) => {
    const { pin } = req.body;
    if (!/^\d{4}$/.test(pin || '')) return res.status(400).json({ error: 'PIN must be 4 digits' });
    await familiesRepo.setPin(req.familyId, pin);
    req.session.pinVerifiedAt = Date.now();
    res.json({ ok: true });
  });

  router.post('/family/pin/verify', async (req, res) => {
    const { pin } = req.body;
    const ok = await familiesRepo.verifyPin(req.familyId, pin || '');
    if (ok) req.session.pinVerifiedAt = Date.now();
    res.json({ ok });
  });

  // "Forgot PIN" — the app already sits behind Google sign-in (requireFamily
  // above already proved that), so recovery just re-issues a verified
  // session and lets the client go straight to "Set new PIN". No separate
  // security-question/email-code step.
  router.post('/family/pin/forgot', async (req, res) => {
    req.session.pinVerifiedAt = Date.now();
    res.json({ ok: true });
  });

  // Backlog 1.3 — "Invite a Co-Parent" (Settings + a late onboarding step).
  // Mints the family's invite code on first request, same shareable code
  // every time after. Not PIN-gated: this only reveals a join code to
  // someone already signed into the family, same trust level as the other
  // plain-GET settings endpoints (family-members, bot-config).
  router.get('/family/invite', async (req, res) => {
    const code = await familiesRepo.ensureInviteCode(req.familyId);
    const parents = await familyParentsRepo.findAllForFamily(req.familyId);
    const joinUrl = `${process.env.WEB_APP_URL || ''}/join/${code}`;
    res.json({ code, joinUrl, parentCount: parents.length });
  });

  router.get('/family-members', async (req, res) => {
    const members = await familyMembersRepo.findAllForFamily(req.familyId);
    res.json({ members });
  });

  router.post('/family-members', requirePinVerified, async (req, res) => {
    const { name, calendarColor, kidIcon, isParent } = req.body;
    if (!name || !calendarColor || !kidIcon) return res.status(400).json({ error: 'name, calendarColor, kidIcon are required' });
    const member = await familyMembersRepo.create({ familyId: req.familyId, name, calendarColor, kidIcon, isParent: !!isParent });
    res.status(201).json({ member });
  });

  router.put('/family-members/:id', requirePinVerified, async (req, res) => {
    const { name, calendarColor, kidIcon, photoUrl } = req.body;
    const member = await familyMembersRepo.update(req.params.id, req.familyId, { name, calendarColor, kidIcon, photoUrl });
    if (!member) return res.status(404).json({ error: 'Family member not found' });
    res.json({ member });
  });

  router.delete('/family-members/:id', requirePinVerified, async (req, res) => {
    const removed = await familyMembersRepo.softDelete(req.params.id, req.familyId);
    if (!removed) return res.status(404).json({ error: 'Family member not found' });
    res.status(204).end();
  });

  return router;
}
