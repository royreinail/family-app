// Regression test for a real production bug: seedDefaultRules() was only
// ever called from tests/setup/seedFamily.js (a test-only shortcut), never
// from the real sign-in route — so every family created through actual
// onboarding had an empty rules table and the pipeline silently fell back
// to "stop, no reply" for every message. The acceptance fixtures never
// caught this because they all use seedFamily.js, which bypasses the exact
// code path that was broken. This test deliberately does NOT use that
// helper — it creates a family the same minimal way routes/auth.js does,
// then asserts ensureFamilySetup() (what auth.js actually calls) leaves it
// in a genuinely working state.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import * as familiesRepo from '../../src/repositories/families.js';
import * as botConfigRepo from '../../src/repositories/botConfig.js';
import * as sourceMappingsRepo from '../../src/repositories/sourceMappings.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import * as rulesRepo from '../../src/repositories/rules.js';
import { ensureFamilySetup } from '../../src/services/familySetup.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'env-phone-id';
  process.env.WHATSAPP_WABA_ID = 'env-waba-id';
});

test('ensureFamilySetup seeds rules and bot_config for a family created the real (minimal) way', async () => {
  // This mirrors exactly what routes/auth.js does on first sign-in:
  // create a bare family row, nothing else — no rules, no bot_config.
  const family = await familiesRepo.create({ name: 'Real Signup Family' }, pool);

  const rulesBefore = await rulesRepo.findAllForFamily(family.id, pool);
  assert.equal(rulesBefore.length, 0, 'sanity check: a freshly created family really does start with zero rules');

  await ensureFamilySetup(family.id, pool);

  const rulesAfter = await rulesRepo.findAllForFamily(family.id, pool);
  assert.ok(rulesAfter.length >= 7, 'default gate + assessment rules should be seeded');
  assert.ok(rulesAfter.some((r) => r.name === 'extraction_classification:date_time'));
  assert.ok(rulesAfter.some((r) => r.name === 'duplicate_message'));

  const config = await botConfigRepo.findByFamilyId(family.id, pool);
  assert.ok(config, 'bot_config row should exist');
  assert.equal(config.phone_number_id, 'env-phone-id', 'phone_number_id should be synced from the environment');
  assert.equal(config.waba_id, 'env-waba-id');
});

test('a real end-to-end message through a freshly signed-up family gets a reply, not silent "stopped"', async () => {
  // No seedFamily.js shortcut here — build the family the way a real user does.
  const family = await familiesRepo.create({ name: 'Real Signup Family 2' }, pool);
  await ensureFamilySetup(family.id, pool);

  const sender = '+15559990001';
  const parent = await familyMembersRepo.create(
    { familyId: family.id, name: 'Parent', calendarColor: '#b3a3d9', kidIcon: '🦄', isParent: true },
    pool
  );
  await sourceMappingsRepo.create(
    { familyId: family.id, channelType: 'whatsapp', externalIdentifier: sender, familyMemberId: parent.id },
    pool
  );
  const config = await botConfigRepo.findByFamilyId(family.id, pool);
  await botConfigRepo.addAcceptedChatId(config.id, sender);

  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dance class Thursday 4pm': {
      title: 'Dance class', date: '2026-08-20', time: '16:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: sender, text: 'Dance class Thursday 4pm', externalMessageId: 'wamid.regression-test-1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written', 'a real signed-up family should actually write the event, not silently stop');
  assert.equal(messenger.sent.length, 1, 'and actually send the confirmation reply');
});
