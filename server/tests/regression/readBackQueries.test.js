// Regression coverage for A1 (enhancement backlog, claude-code-enhancements.md):
// the bot could previously only write to the calendar, never answer a
// question about what's already there. Modeled as a second tool
// (llm.js's record_query, alongside the existing record_extraction) so the
// LLM picks which one applies in the same single call — genuine intent
// classification ("what's on tomorrow?" vs. "Dentist tomorrow 9am"), same
// lesson as item 10's reminder-intent fix, not a keyword trigger. Real
// extraction/classification quality isn't unit-tested (same boundary-layer
// convention as every other real LLM call in this codebase) — this covers
// the deterministic app code around it: routing, the two decided filters
// (D-1: reuse the dashboard's audience filter; person-scoping via the same
// matchMembersToEvent the dashboard card-color fix already relies on), and
// reply formatting.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import { formatQueryReply } from '../../src/pipeline/classify.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('formatQueryReply: no matches, a general query, and a person-scoped query', () => {
  assert.equal(formatQueryReply([], { dateFrom: '2026-09-02', dateTo: '2026-09-02' }), 'Nothing on the calendar, 2026-09-02.');
  assert.equal(
    formatQueryReply([], { personName: 'Gaia', dateFrom: '2026-09-02', dateTo: '2026-09-05' }),
    'Nothing on the calendar for Gaia, 2026-09-02 to 2026-09-05.'
  );
  const events = [
    { summary: 'Dance class', start: { dateTime: '2026-09-02T16:00:00' } },
    { summary: 'All-day trip', start: { date: '2026-09-02' } }, // no dateTime -> no time shown
  ];
  const reply = formatQueryReply(events, { dateFrom: '2026-09-02', dateTo: '2026-09-02' });
  assert.match(reply, /Dance class 16:00/);
  assert.match(reply, /All-day trip$/m, 'an all-day event lists with no time, not a blank/garbled one');
});

test('a natural-language query routes to a read, not a write, and never touches the calendar to create anything', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    "What's on tomorrow?": { type: 'query', date_from: '2026-09-02', date_to: '2026-09-02', person: null },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: "What's on tomorrow?", externalMessageId: 'wamid.query-1' },
    { pool, llmExtract: llm.extract, calendar, messenger, calendarConnected: true }
  );

  assert.equal(result.outcome, 'query');
  assert.equal(calendar.events.size, 0, 'a read-back query must never create anything');
  assert.equal(messenger.sent.length, 1);
});

test('a query lists real events already on the calendar', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dentist tomorrow 9am': {
      title: 'Dentist', date: '2026-09-02', time: '09:00', person: null, category: 'appointment',
      reminder_requested: false, reminder_datetime: null,
    },
    "What's on tomorrow?": { type: 'query', date_from: '2026-09-02', date_to: '2026-09-02', person: null },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dentist tomorrow 9am', externalMessageId: 'wamid.query-2a' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent] }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: "What's on tomorrow?", externalMessageId: 'wamid.query-2b' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent], calendarConnected: true }
  );

  assert.equal(result.outcome, 'query');
  assert.equal(result.events.length, 1);
  assert.match(result.reply, /Dentist 09:00/);
});

// D-1: reuse the exact same audience filter the kid dashboard uses.
test('a query never surfaces a parent_only event', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dentist tomorrow 9am, just for me': {
      title: 'Dentist', date: '2026-09-02', time: '09:00', person: null, category: 'appointment',
      reminder_requested: false, reminder_datetime: null, audience: 'parent_only',
    },
    "What's on tomorrow?": { type: 'query', date_from: '2026-09-02', date_to: '2026-09-02', person: null },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dentist tomorrow 9am, just for me', externalMessageId: 'wamid.query-3a' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: "What's on tomorrow?", externalMessageId: 'wamid.query-3b' },
    { pool, llmExtract: llm.extract, calendar, messenger, calendarConnected: true }
  );

  assert.equal(result.events.length, 0);
  assert.match(result.reply, /^Nothing on the calendar/);
});

// Person-scoping ("what does Gaia have Tuesday?") reuses matchMembersToEvent
// — the same personId-first resolution the dashboard card-color fix relies
// on, so an event whose title never even says the person's name is still
// correctly scoped to them.
test('a person-scoped query only returns that person\'s events, matched via personId not just text', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const gaia = await familyMembersRepo.create({ familyId: family.id, name: 'Gaia', calendarColor: '#d60000', kidIcon: '🦊' }, pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);
  const familyMembers = [gaia, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Art therapy for Gaia Tuesday 4pm': {
      title: 'Art therapy', date: '2026-09-02', time: '16:00', person: 'Gaia', category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
    'Soccer for Theo Tuesday 5pm': {
      title: 'Soccer', date: '2026-09-02', time: '17:00', person: 'Theo', category: 'sports',
      reminder_requested: false, reminder_datetime: null,
    },
    'What does Gaia have Tuesday?': { type: 'query', date_from: '2026-09-02', date_to: '2026-09-02', person: 'Gaia' },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Art therapy for Gaia Tuesday 4pm', externalMessageId: 'wamid.query-4a' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers }
  );
  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Soccer for Theo Tuesday 5pm', externalMessageId: 'wamid.query-4b' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'What does Gaia have Tuesday?', externalMessageId: 'wamid.query-4c' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, calendarConnected: true }
  );

  assert.equal(result.events.length, 1);
  assert.match(result.reply, /for Gaia/);
  assert.match(result.reply, /Art therapy/);
  assert.doesNotMatch(result.reply, /Soccer/, "Theo's event must not leak into Gaia's scoped answer");
});

test('a query gets a clean "connect Calendar first" reply, not a raw API failure, when Calendar isn\'t connected', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    "What's on tomorrow?": { type: 'query', date_from: '2026-09-02', date_to: '2026-09-02', person: null },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: "What's on tomorrow?", externalMessageId: 'wamid.query-5' },
    { pool, llmExtract: llm.extract, calendar, messenger, calendarConnected: false }
  );

  assert.equal(result.outcome, 'query_failed');
  assert.match(messenger.sent.at(-1).text, /connect/i);
  assert.doesNotMatch(messenger.sent.at(-1).text, /API|error|Error/, 'must not leak a raw API-shaped message for a simple not-connected case');
});
