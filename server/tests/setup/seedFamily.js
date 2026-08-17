import * as familiesRepo from '../../src/repositories/families.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import * as botConfigRepo from '../../src/repositories/botConfig.js';
import * as sourceMappingsRepo from '../../src/repositories/sourceMappings.js';
import { seedDefaultRules } from '../../src/rules/defaultRules.js';

export async function seedFamily(pool, { knownSender = '+15551234567' } = {}) {
  const family = await familiesRepo.create({ name: 'Test Family', timezone: 'America/New_York' }, pool);
  const parent = await familyMembersRepo.create(
    { familyId: family.id, name: 'Dana', calendarColor: '#b3a3d9', kidIcon: '🦄', isParent: true },
    pool
  );
  const botConfig = await botConfigRepo.create(
    { familyId: family.id, phoneNumberId: 'test-phone-id', acceptedChatIds: [knownSender] },
    pool
  );
  await sourceMappingsRepo.create(
    { familyId: family.id, channelType: 'whatsapp', externalIdentifier: knownSender, familyMemberId: parent.id },
    pool
  );
  await seedDefaultRules(family.id, pool);
  return { family, parent, botConfig, knownSender };
}
