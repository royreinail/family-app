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
import { buildSystemPrompt } from '../../src/integrations/llm.js';

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
    { summary: 'All-day trip', start: { date: '2026-09-02' } }, // no dateTime -> explicit "(all day)" label, not a blank
  ];
  const reply = formatQueryReply(events, { dateFrom: '2026-09-02', dateTo: '2026-09-02' });
  assert.match(reply, /Dance class 16:00/);
  // Live bug report: a blank time here read as "the bot lost the time,"
  // not "this genuinely has no specific time" — label it explicitly.
  assert.match(reply, /All-day trip \(all day\)$/m, 'an all-day event is labeled explicitly, never rendered as a blank time');
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

// Live bug report — Issue 2: "מה יש לי" ("what do I have," self-referential)
// never got audience-filtered at all — D-1's own decision requires it. Root
// cause: the LLM had no signal for WHO was actually sending the message, so
// it had nothing to resolve a self-referential `person` to (a real gap, not
// an LLM mistake — matchSingleFamilyMember/matchMembersToEvent downstream
// already handle a resolved person name correctly, same as a named third
// party; nothing there needed to change). Fixed by telling the model who's
// sending (llm.js's buildSystemPrompt senderName param, threaded from
// webhook.js's already-resolved senderFamilyMember) — real classification
// quality (does the model actually recognize "לי"/"for me" as
// self-referential) isn't unit-tested, same boundary-layer convention as
// every other real LLM call; this covers that the system prompt actually
// carries the identity signal, and that the deterministic filtering
// downstream correctly scopes once the LLM does resolve it.
test('buildSystemPrompt tells the model who is sending, so it can resolve a self-referential "what do I have" to their own name', () => {
  const withSender = buildSystemPrompt(['Dana', 'Gaia'], 'Dana');
  assert.match(withSender, /Message sender: Dana/);
  assert.match(withSender, /resolve that to their own name, Dana/);

  const withoutSenderName = buildSystemPrompt(['Dana', 'Gaia'], undefined);
  assert.doesNotMatch(withoutSenderName, /Message sender:/, 'no sender identity known (e.g. no phone mapping yet) — nothing to add');

  const noMembersAtAll = buildSystemPrompt([], 'Dana');
  assert.doesNotMatch(noMembersAtAll, /Message sender:/, 'no known family members at all — the whole block (names + sender) is skipped, same as before this fix');
});

test('a self-referential query ("what do I have") scopes to just the sender\'s own events once person resolves to their name', async () => {
  const { family, parent, knownSender } = await seedFamily(pool); // parent = 'Dana', mapped to knownSender
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);
  const familyMembers = [parent, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dentist for Dana tomorrow 9am': {
      title: 'Dentist', date: '2026-09-02', time: '09:00', person: 'Dana', category: 'appointment',
      reminder_requested: false, reminder_datetime: null,
    },
    'Soccer for Theo tomorrow 5pm': {
      title: 'Soccer', date: '2026-09-02', time: '17:00', person: 'Theo', category: 'sports',
      reminder_requested: false, reminder_datetime: null,
    },
    // Simulates the LLM correctly resolving "what do I have" to the
    // sender's own name once told who's sending (buildSystemPrompt's
    // senderName) — the model's own Hebrew/English understanding of "לי"/
    // "for me" isn't itself unit-tested (same boundary-layer convention as
    // every other real LLM call); this covers what happens once it does.
    'What do I have tomorrow?': { type: 'query', date_from: '2026-09-02', date_to: '2026-09-02', person: 'Dana' },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dentist for Dana tomorrow 9am', externalMessageId: 'wamid.self-1a' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers }
  );
  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Soccer for Theo tomorrow 5pm', externalMessageId: 'wamid.self-1b' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'What do I have tomorrow?', externalMessageId: 'wamid.self-1c' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, calendarConnected: true }
  );

  assert.equal(result.events.length, 1, 'only the sender\'s own event, not the whole family\'s');
  assert.match(result.reply, /Dentist/);
  assert.doesNotMatch(result.reply, /Soccer/, "Theo's event must not leak into a self-referential query");
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

// Live bug report, end-to-end reproduction of Issues 1 + 2 together: "מה יש
// לי בשלישי" sent Friday 2026-09-04. (Issue 3, the all-day label, is a pure
// formatting concern already covered directly against formatQueryReply
// above — real Google Calendar's all-day shape, start:{date}/no dateTime,
// isn't something the fake calendar's flat internal storage can represent,
// so it's exercised at the formatter, not through the full pipeline.)
test('full reproduction: "מה יש לי בשלישי" resolves the correct Tuesday and scopes to the sender, not the LLM\'s own wrong answer', async () => {
  const { family, parent, knownSender } = await seedFamily(pool); // parent = 'Dana'
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);
  const familyMembers = [parent, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'פגישה למומחית תחום שמע בשלישי בשעה 7:30 בבוקר עבורי': {
      title: 'פגישה מומחית תחום שמע', date: '2026-09-08', time: '07:30', person: 'Dana', category: 'appointment',
      reminder_requested: false, reminder_datetime: null,
    },
    'חוג כדורגל לתיאו בשלישי בשעה 17:00': {
      title: 'חוג כדורגל', date: '2026-09-08', time: '17:00', person: 'Theo', category: 'sports',
      reminder_requested: false, reminder_datetime: null,
    },
    // The LLM's own weekday arithmetic is deliberately WRONG here (mirrors
    // the real report — the LLM landed on 2026-09-09, a Wednesday); the
    // point of this test is that classify.js's deterministic override
    // corrects it regardless of what the LLM itself returned.
    'מה יש לי בשלישי': { type: 'query', date_from: '2026-09-09', date_to: '2026-09-09', person: 'Dana' },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'פגישה למומחית תחום שמע בשלישי בשעה 7:30 בבוקר עבורי', externalMessageId: 'wamid.repro-1' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers }
  );
  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'חוג כדורגל לתיאו בשלישי בשעה 17:00', externalMessageId: 'wamid.repro-1b' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'מה יש לי בשלישי', externalMessageId: 'wamid.repro-2' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, calendarConnected: true }
  );

  // Issue 1 — the correct Tuesday (09-08), not the LLM's own wrong
  // Wednesday (09-09) the fake response deliberately returned.
  assert.equal(result.outcome, 'query');
  assert.match(result.reply, /2026-09-08/);
  assert.doesNotMatch(result.reply, /2026-09-09/);

  // Issue 2 — scoped to Dana (the sender) only; Theo's soccer must not
  // appear in Dana's own "what do I have" answer.
  assert.equal(result.events.length, 1);
  assert.match(result.reply, /פגישה מומחית תחום שמע/);
  assert.doesNotMatch(result.reply, /כדורגל/, "Theo's event must not leak into Dana's self-referential query");
});
