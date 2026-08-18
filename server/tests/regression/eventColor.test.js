// Regression coverage for "color coding should match between our UI and
// the Calendar event" — resolveEventColorId is the deterministic app-code
// piece that turns an extracted `person` name into the Calendar colorId of
// the matching family member, falling back to one default when the person
// is missing, unmatched, or ambiguous.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import { resolveEventColorId } from '../../src/pipeline/classify.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import { DEFAULT_COLOR_ID, GOOGLE_EVENT_COLORS } from '../../src/integrations/googleColors.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('resolveEventColorId matches a named person to their assigned color', () => {
  const members = [
    { name: 'Mia', calendar_color: GOOGLE_EVENT_COLORS[0].hex },
    { name: 'Theo', calendar_color: GOOGLE_EVENT_COLORS[1].hex },
  ];
  assert.equal(resolveEventColorId('Mia', members), GOOGLE_EVENT_COLORS[0].colorId);
  assert.equal(resolveEventColorId('theo', members), GOOGLE_EVENT_COLORS[1].colorId); // case-insensitive
});

test('resolveEventColorId falls back to the default for no match, no person, or an ambiguous multi-match', () => {
  const members = [
    { name: 'Mia', calendar_color: GOOGLE_EVENT_COLORS[0].hex },
    { name: 'Theo', calendar_color: GOOGLE_EVENT_COLORS[1].hex },
  ];
  assert.equal(resolveEventColorId(null, members), DEFAULT_COLOR_ID);
  assert.equal(resolveEventColorId('Someone else', members), DEFAULT_COLOR_ID);
  assert.equal(resolveEventColorId('Mia and Theo', members), DEFAULT_COLOR_ID); // matches both, ambiguous
});

test('a real write threads the matched family member\'s color through to the Calendar event', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const member = await familyMembersRepo.create(
    { familyId: family.id, name: 'Mia', calendarColor: GOOGLE_EVENT_COLORS[3].hex, kidIcon: '🦄' },
    pool
  );

  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    "Mia's dance class Thursday 4pm": {
      title: 'Dance class', date: '2026-08-20', time: '16:00', person: 'Mia', category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: "Mia's dance class Thursday 4pm", externalMessageId: 'wamid.color-regression-1' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [member] }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).colorId, GOOGLE_EVENT_COLORS[3].colorId);
});
