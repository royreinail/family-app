// A3 — multi-event extraction: a forwarded message can describe more than
// one event/date at once. Extraction's `additional_events` array must not
// be silently dropped the way a single-event schema always dropped anything
// beyond the first (same failure class as the already-fixed duration bug).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as tasksRepo from '../../src/repositories/tasks.js';
import { formatAdditionalEventsNote } from '../../src/pipeline/classify.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

function baseCandidate(overrides = {}) {
  return {
    title: 'Swimming', date: '2026-09-08', time: '16:00', end_time: null, person: null, category: 'activity',
    reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🏊',
    additional_events: [], ...overrides,
  };
}

test('formatAdditionalEventsNote: empty list, a written item, and a needs_time item', () => {
  assert.equal(formatAdditionalEventsNote([]), '');
  const note = formatAdditionalEventsNote([
    { status: 'written', candidate: { title: 'Art class', date: '2026-09-10', time: '17:00', person: 'Mia' } },
    { status: 'needs_time', candidate: { title: 'Field trip', date: '2026-09-12', person: null } },
  ]);
  assert.match(note, /^Also found 2 more in that message:/);
  assert.match(note, /Art class, 2026-09-10 17:00 for Mia — added ✅/);
  assert.match(note, /Field trip, 2026-09-12 — needs a time \(added as a task\)/);
});

test('a message with additional_events writes every one of them and sends a second summary message', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Swimming Tue 4pm, art class Thu 5pm, field trip Friday': baseCandidate({
      additional_events: [
        { title: 'Art class', date: '2026-09-10', time: '17:00', end_time: null, person: null, audience: 'family', activity_icon: '🎨' },
        { title: 'Field trip', date: '2026-09-12', time: null, end_time: null, person: null, audience: 'family', activity_icon: '🚌' },
      ],
    }),
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Swimming Tue 4pm, art class Thu 5pm, field trip Friday', externalMessageId: 'wamid.1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written'); // primary
  assert.equal(calendar.events.size, 2, 'primary + the one additional event with a time');
  const tasks = await tasksRepo.findAllForFamily(family.id, pool);
  assert.equal(tasks.length, 1, 'the date-only additional item became a tentative task');
  assert.equal(tasks[0].title, 'Field trip');

  assert.equal(messenger.sent.length, 2, 'primary confirm + one combined additional-events note');
  assert.match(messenger.sent[0].text, /Swimming.*added/i);
  assert.match(messenger.sent[1].text, /Also found 2 more/);
  assert.match(messenger.sent[1].text, /Art class.*added/);
  assert.match(messenger.sent[1].text, /Field trip.*needs a time/);
});

test('additional_events: [] (the overwhelmingly common single-event case) sends only the one primary message', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({ 'Dance class Thursday 4pm': baseCandidate({ title: 'Dance class', additional_events: [] }) });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class Thursday 4pm', externalMessageId: 'wamid.2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(calendar.events.size, 1);
  assert.equal(messenger.sent.length, 1, 'no second message when there was nothing additional');
});

test('an additional item with no date at all is skipped (not written, not counted) rather than crashing', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Swimming Tue 4pm, also something vague': baseCandidate({
      additional_events: [{ title: null, date: null, time: null, end_time: null, person: null, audience: 'family', activity_icon: '📌' }],
    }),
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Swimming Tue 4pm, also something vague', externalMessageId: 'wamid.3' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(calendar.events.size, 1, 'only the primary — the dateless additional item contributed nothing');
  assert.equal(messenger.sent.length, 1, 'no second message when every additional item was unusable');
});

test('additional events inherit the forwarded-sender person default and the explicit "parents only" keyword, same as the primary item', async () => {
  const { family, parent, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'forwarded schedule, just us parents': baseCandidate({
      person: null,
      audience: 'family',
      additional_events: [
        { title: 'Extra thing', date: '2026-09-10', time: '17:00', end_time: null, person: null, audience: 'family', activity_icon: '📌' },
      ],
    }),
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'forwarded schedule, just us parents', externalMessageId: 'wamid.4', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, senderFamilyMember: parent, familyMembers: [parent] }
  );

  assert.equal(calendar.events.size, 2);
  const written = [...calendar.events.values()].find((e) => e.title === 'Extra thing');
  assert.equal(written.personId, parent.id, 'forwarded-sender default applied to the additional item too');
  assert.equal(written.audience, 'parent_only', 'explicit "just us parents" keyword applied to the additional item too');
});
