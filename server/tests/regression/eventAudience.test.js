// Regression coverage for backlog 4.1-4.3 (event audience & kid
// visibility). The LLM makes its own family/parent_only judgment call
// (llm.js's system prompt, untested here the same way llm.js's real API
// call always has been — see overrideExplicitAudienceKeyword's own test
// below for the one deterministic piece on top of it). What's covered here:
// the deterministic keyword override, the default when a candidate has no
// audience at all (old fixtures, or a genuinely ambiguous LLM read), the
// pure kid-board filter, and the real write threading audience through to
// the Calendar event's extendedProperties.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import { overrideExplicitAudienceKeyword, shouldShowOnKidBoard } from '../../src/pipeline/classify.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('overrideExplicitAudienceKeyword forces parent_only when the message says so explicitly', () => {
  const candidate = { title: 'Date night', audience: 'family' };
  assert.equal(overrideExplicitAudienceKeyword('Date night Friday 7pm, just us parents', candidate).audience, 'parent_only');
  assert.equal(overrideExplicitAudienceKeyword('Dinner Friday, parents only', candidate).audience, 'parent_only');
  assert.equal(overrideExplicitAudienceKeyword('Meeting Tuesday, adults only please', candidate).audience, 'parent_only');
});

test('overrideExplicitAudienceKeyword leaves the LLM\'s own read alone when no explicit phrase is present', () => {
  const candidate = { title: 'Soccer practice', audience: 'family' };
  assert.deepEqual(overrideExplicitAudienceKeyword('Soccer practice Thursday 5pm', candidate), candidate);
});

test('shouldShowOnKidBoard hides parent_only events and shows everything else', () => {
  assert.equal(shouldShowOnKidBoard({ extendedProperties: { private: { audience: 'parent_only' } } }), false);
  assert.equal(shouldShowOnKidBoard({ extendedProperties: { private: { audience: 'family' } } }), true);
  assert.equal(shouldShowOnKidBoard({ extendedProperties: {} }), true, 'no audience metadata at all must default to shown, not hidden');
  assert.equal(shouldShowOnKidBoard({}), true);
});

test('a real write with no explicit keyword defaults to family (visible) even when the LLM omits audience entirely', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Soccer practice Thursday 5pm': {
      title: 'Soccer practice', date: '2026-08-20', time: '17:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
      // Deliberately no `audience` field -- mirrors an old fixture shape /
      // an LLM response from before this field existed.
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Soccer practice Thursday 5pm', externalMessageId: 'wamid.audience-regression-1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).audience, 'family');
});

test('a real write for an explicitly parent-only message threads parent_only through to the Calendar write', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Date night Friday 7pm, just us parents': {
      title: 'Date night', date: '2026-08-21', time: '19:00', person: null, category: null,
      reminder_requested: false, reminder_datetime: null, audience: 'family', // LLM guessed wrong; keyword override should still catch it
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Date night Friday 7pm, just us parents', externalMessageId: 'wamid.audience-regression-2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).audience, 'parent_only');
});
