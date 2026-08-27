// Regression test for a real production bug caught in live testing: item 6's
// forwarded-sender default (and its color assignment) silently never fired
// for any real message. Root cause: `source_mappings` — the table
// webhook.js's senderFamilyMember lookup depends on — had an insert function
// (sourceMappingsRepo.create) that nothing in the app ever called. Onboarding's
// "Connect WhatsApp" step (and its Settings Home reuse) only ever recorded a
// number on bot_config's accepted-senders allowlist, never who it belongs to.
//
// Two bugs fixed together, since the second made even a fix for the first
// look broken:
//   1. Nothing ever wrote to source_mappings — fixed by having
//      POST /bot-config/confirm accept a familyMemberId and call the new
//      sourceMappingsRepo.upsertSender (routes/botConfig.js).
//   2. Even once written, a lookup would have failed anyway: WhatsApp's
//      webhook gives sender numbers as bare digits (no "+", no spaces/dashes
//      — see botConfig.js's normalizePhone), but onboarding's phone field
//      invites a human "+1 555-123-4567" format. source_mappings stored and
//      matched on the raw typed string, so an exact-string lookup against
//      the webhook's bare-digit sender would never hit even a real row.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as familiesRepo from '../../src/repositories/families.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import * as botConfigRepo from '../../src/repositories/botConfig.js';
import * as sourceMappingsRepo from '../../src/repositories/sourceMappings.js';
import { seedDefaultRules } from '../../src/rules/defaultRules.js';
import { hexToColorId, DEFAULT_COLOR_ID } from '../../src/integrations/googleColors.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('upsertSender creates a mapping, and a later call re-links it rather than erroring on the duplicate', async () => {
  const family = await familiesRepo.create({ name: 'Test Family' }, pool);
  const dana = await familyMembersRepo.create({ familyId: family.id, name: 'Dana', calendarColor: '#b3a3d9', kidIcon: '🦄' }, pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);

  const created = await sourceMappingsRepo.upsertSender(
    { familyId: family.id, channelType: 'whatsapp', externalIdentifier: '+1 555-123-4567', familyMemberId: dana.id },
    pool
  );
  assert.equal(created.family_member_id, dana.id);

  // Re-linking the same number (a mis-assigned first attempt, corrected)
  // must update the existing row, not throw on the unique constraint.
  const relinked = await sourceMappingsRepo.upsertSender(
    { familyId: family.id, channelType: 'whatsapp', externalIdentifier: '+1 555-123-4567', familyMemberId: theo.id },
    pool
  );
  assert.equal(relinked.family_member_id, theo.id);

  const all = await sourceMappingsRepo.findAllForFamily(family.id, pool);
  assert.equal(all.length, 1, 'still one mapping for the number, not two');
});

test('a number saved in onboarding\'s human-typed format is still found by the webhook\'s bare-digit sender id', async () => {
  const family = await familiesRepo.create({ name: 'Test Family' }, pool);
  const dana = await familyMembersRepo.create({ familyId: family.id, name: 'Dana', calendarColor: '#b3a3d9', kidIcon: '🦄' }, pool);

  // Exactly what a parent would type into WhatsAppStep's number field.
  await sourceMappingsRepo.upsertSender(
    { familyId: family.id, channelType: 'whatsapp', externalIdentifier: '+1 (555) 123-4567', familyMemberId: dana.id },
    pool
  );

  // Exactly the shape Meta's webhook sends as message.from.
  const found = await sourceMappingsRepo.findByIdentifier(
    { familyId: family.id, channelType: 'whatsapp', externalIdentifier: '15551234567' },
    pool
  );
  assert.ok(found, 'must resolve despite the format mismatch between onboarding input and the webhook payload');
  assert.equal(found.family_member_id, dana.id);
});

test('POST /bot-config/confirm-equivalent flow: linking a number to a family member makes the forwarded-sender default actually fire', async () => {
  // Mirrors seedFamily's own setup, but WITHOUT its baked-in source_mappings
  // row, to reproduce the real-world starting state every existing family
  // was actually in before this fix: connected (accepted_chat_ids has the
  // number) but with no source_mappings row at all.
  const family = await familiesRepo.create({ name: 'Test Family', timezone: 'Asia/Jerusalem' }, pool);
  const roy = await familyMembersRepo.create({ familyId: family.id, name: 'רואי', calendarColor: '#f5511d', kidIcon: '🧑' }, pool);
  const sender = '972501234567';
  await botConfigRepo.create({ familyId: family.id, phoneNumberId: 'test-phone-id', acceptedChatIds: [sender] }, pool);
  await seedDefaultRules(family.id, pool);

  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Commanders Day flyer': {
      title: 'Commanders Day', date: '2026-09-08', time: '09:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  // Before onboarding is fixed to call upsertSender, this is the real
  // production bug: no mapping exists, so the default silently never fires.
  const beforeLink = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: sender, text: 'Commanders Day flyer', externalMessageId: 'wamid.link-1', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [roy], senderFamilyMember: null }
  );
  assert.doesNotMatch(beforeLink.reply, /רואי|assumed/, 'reproduces the bug: no mapping means no default and no owner in the confirmation');
  assert.equal(
    [...calendar.events.values()][0].colorId,
    DEFAULT_COLOR_ID,
    'reproduces the bug: with no mapping, color falls back to default instead of רואי\'s real orange'
  );

  // The actual fix: routes/botConfig.js's POST /bot-config/confirm now does
  // exactly this upsert once a family member is picked for the number.
  await sourceMappingsRepo.upsertSender({ familyId: family.id, channelType: 'whatsapp', externalIdentifier: sender, familyMemberId: roy.id }, pool);

  // Same message again, this time resolving senderFamilyMember the way
  // webhook.js's real lookup would, now that the mapping exists.
  const mapping = await sourceMappingsRepo.findByIdentifier({ familyId: family.id, channelType: 'whatsapp', externalIdentifier: sender }, pool);
  const afterLink = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: sender, text: 'Commanders Day flyer', externalMessageId: 'wamid.link-2', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [roy], senderFamilyMember: mapping ? roy : null }
  );
  assert.equal(afterLink.outcome, 'written');
  assert.match(afterLink.reply, /for רואי \(assumed/, 'owner now stated in the confirmation, as designed');
  const [, secondEvent] = [...calendar.events.values()];
  assert.equal(secondEvent.colorId, hexToColorId('#f5511d'), "event carries רואי's real assigned color, not the default");
});
