// Single place that guarantees a family is fully, correctly configured —
// bot_config synced from env vars, default rules seeded. Called from every
// place a family gets touched (sign-in, session check, bot-config routes)
// so any family reaches a working state regardless of when it was created,
// and so this logic has exactly one implementation to test instead of being
// duplicated (and drifting) across route handlers.
//
// This exists because of a real production bug: seedDefaultRules() was
// only ever called from a test helper, never from the real sign-in route,
// so every real family had an empty rules table and silently got the
// rule engine's hardcoded fallback behavior instead of its real rules.
// See family-app-architecture.md's Phase 1 build log for the full story.
import * as botConfigRepo from '../repositories/botConfig.js';
import * as rulesRepo from '../repositories/rules.js';
import { seedDefaultRules } from '../rules/defaultRules.js';

export async function ensureFamilySetup(familyId, pool) {
  let config = await botConfigRepo.findByFamilyId(familyId, pool);
  if (!config) config = await botConfigRepo.create({ familyId }, pool);
  await botConfigRepo.syncFromEnv(config.id, pool);

  const existingRules = await rulesRepo.findAllForFamily(familyId, pool);
  if (existingRules.length === 0) await seedDefaultRules(familyId, pool);
}
