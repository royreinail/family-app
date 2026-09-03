// The seven acceptance fixtures from the build brief, as real runnable
// tests. Each asserts both the outcome AND (where applicable) which rule
// fired — these must keep passing as the rules table changes later; that's
// the point of having them as tests rather than a spec table.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as extractionLogRepo from '../../src/repositories/extractionLog.js';
import * as tasksRepo from '../../src/repositories/tasks.js';

// Fresh in-memory DB per test — source_mappings enforces a global unique
// (channel_type, external_identifier), which is correct for the real app
// (one WhatsApp number belongs to one family) but means fixtures can't share
// a pool across tests while reusing the same fake sender number.
let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

function msgId() {
  return `wamid.${randomUUID()}`;
}

async function send({ familyId, sender, text, deps, externalMessageId, replyToExtractionLogId }) {
  return handleIncomingMessage(
    { familyId, senderIdentifier: sender, text, externalMessageId: externalMessageId ?? msgId(), replyToExtractionLogId },
    { pool, ...deps }
  );
}

test('1. clean event (date+time) -> written to Calendar + one confirm reply, extraction_classification date+time branch', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dance class Thursday 4pm': {
      title: 'Dance class', date: '2026-08-20', time: '16:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await send({
    familyId: family.id, sender: knownSender, text: 'Dance class Thursday 4pm',
    deps: { llmExtract: llm.extract, calendar, messenger },
  });

  assert.equal(result.outcome, 'written');
  assert.equal(result.destination, 'calendar');
  assert.equal(result.rule.name, 'extraction_classification:date_time');
  assert.equal(calendar.events.size, 1);
  assert.equal(messenger.sent.length, 1);
  assert.match(messenger.sent[0].text, /Dance class.*added/i);
});

test('2. date, no time (todo-shaped) -> written to tasks tentative + qualify reply, extraction_classification date-only branch', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Bring $10 for the field trip by Friday': {
      title: 'Bring $10 for the field trip', date: '2026-08-21', time: null, person: null, category: 'todo',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await send({
    familyId: family.id, sender: knownSender, text: 'Bring $10 for the field trip by Friday',
    deps: { llmExtract: llm.extract, calendar, messenger },
  });

  assert.equal(result.outcome, 'needs_time');
  assert.equal(result.destination, 'tasks');
  assert.equal(result.rule.name, 'extraction_classification:date_only');
  assert.equal(calendar.events.size, 0);
  const tasks = await tasksRepo.findAllForFamily(family.id, pool);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].due_date.toISOString().slice(0, 10), '2026-08-21');
  assert.equal(messenger.sent.length, 1);
  assert.match(messenger.sent[0].text, /what time/i);
});

test('3. no usable date ("thanks!") -> no write, no reply, extraction_classification nothing-usable branch', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'thanks!': {
      title: null, date: null, time: null, person: null, category: null,
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await send({
    familyId: family.id, sender: knownSender, text: 'thanks!',
    deps: { llmExtract: llm.extract, calendar, messenger },
  });

  assert.equal(result.outcome, 'stopped');
  assert.equal(result.rule.name, 'extraction_classification:nothing_usable');
  assert.equal(calendar.events.size, 0);
  const tasks = await tasksRepo.findAllForFamily(family.id, pool);
  assert.equal(tasks.length, 0);
  assert.equal(messenger.sent.length, 0);
});

test('4. duplicate external_message_id -> no write, no reply, stopped, no LLM call, duplicate_message gate', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Piano recital Saturday 2pm': {
      title: 'Piano recital', date: '2026-08-22', time: '14:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });
  const sharedId = msgId();

  const first = await send({
    familyId: family.id, sender: knownSender, text: 'Piano recital Saturday 2pm',
    externalMessageId: sharedId, deps: { llmExtract: llm.extract, calendar, messenger },
  });
  assert.equal(first.outcome, 'written');
  assert.equal(llm.calls.length, 1);
  assert.equal(messenger.sent.length, 1);

  const second = await send({
    familyId: family.id, sender: knownSender, text: 'Piano recital Saturday 2pm',
    externalMessageId: sharedId, deps: { llmExtract: llm.extract, calendar, messenger },
  });

  assert.equal(second.outcome, 'stopped');
  assert.equal(second.rule.name, 'duplicate_message');
  assert.equal(llm.calls.length, 1, 'LLM must not be called for the duplicate');
  assert.equal(messenger.sent.length, 1, 'no reply for the duplicate');
  assert.equal(calendar.events.size, 1, 'no second calendar write');

  const secondLog = await extractionLogRepo.findByExternalId({ familyId: family.id, externalMessageId: sharedId }, pool);
  assert.equal(secondLog.state, 'stopped');
});

test('5. unknown sender -> no write, no reply, no LLM call, unknown_sender gate', async () => {
  const { family } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Soccer practice Monday 5pm': {
      title: 'Soccer practice', date: '2026-08-24', time: '17:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await send({
    familyId: family.id, sender: '+19995550000', text: 'Soccer practice Monday 5pm',
    deps: { llmExtract: llm.extract, calendar, messenger },
  });

  assert.equal(result.outcome, 'stopped');
  assert.equal(result.rule.name, 'unknown_sender');
  assert.equal(llm.calls.length, 0, 'LLM must not be called for an unknown sender');
  assert.equal(messenger.sent.length, 0);
  assert.equal(calendar.events.size, 0);
});

test('6. reply-correction ("no, 5pm") edits the linked event via extraction_log.id, not a rule match', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dentist Tuesday 4pm': {
      title: 'Dentist', date: '2026-08-25', time: '16:00', person: null, category: 'appointment',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const original = await send({
    familyId: family.id, sender: knownSender, text: 'Dentist Tuesday 4pm',
    deps: { llmExtract: llm.extract, calendar, messenger },
  });
  assert.equal(original.outcome, 'written');
  const originalLogId = original.log.id;

  const correction = await send({
    familyId: family.id, sender: knownSender, text: 'no, 5pm',
    replyToExtractionLogId: originalLogId,
    deps: { llmExtract: llm.extract, calendar, messenger },
  });

  assert.equal(correction.outcome, 'corrected');
  assert.equal(correction.rule, undefined, 'correction is not a rule match');
  assert.equal(correction.updatedCandidate.time, '17:00');
  assert.equal(llm.calls.length, 1, 'the correction reply itself must not trigger a second LLM call');

  const updatedLog = await extractionLogRepo.findById(originalLogId, pool);
  assert.equal(updatedLog.state, 'corrected');
  assert.equal(updatedLog.ai_candidate.time, '17:00');

  const eventId = updatedLog.resulting_event_ref.external_id;
  // The fake's updateEvent unwraps the real Google patch shape
  // (start.dateTime/end.dateTime) into the same flat startDateTime field
  // createEvent stores directly — one consistent internal shape for every
  // field the fake tracks (see fakes.js), not two depending on how the
  // event was last written.
  assert.equal(calendar.events.get(eventId).startDateTime, '2026-08-25T17:00:00');
});

test('7. explicit reminder ask -> confirms the write AND schedules a reminder at reminder_datetime', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Remind me to pack the gym bag Thursday night, gym class is Friday 9am': {
      title: 'Gym class', date: '2026-08-27', time: '09:00', person: null, category: 'activity',
      reminder_requested: true, reminder_datetime: '2026-08-26T20:00:00',
    },
  });

  const result = await send({
    familyId: family.id, sender: knownSender,
    text: 'Remind me to pack the gym bag Thursday night, gym class is Friday 9am',
    deps: { llmExtract: llm.extract, calendar, messenger },
  });

  // Outcome 1: the event itself was written and confirmed.
  assert.equal(result.outcome, 'written');
  assert.equal(calendar.events.size, 1);
  assert.equal(messenger.sent.length, 1);
  assert.match(messenger.sent[0].text, /added/i);

  // Outcome 2: a reminder was scheduled for reminder_datetime, distinct from the write above.
  assert.ok(result.reminder, 'a reminder should have been scheduled');
  assert.equal(result.reminder.reminder_policy, 'requested');
  assert.equal(result.reminder.reminder_datetime.toISOString(), '2026-08-26T20:00:00.000Z');

  const tasks = await tasksRepo.findAllForFamily(family.id, pool);
  const reminderTask = tasks.find((t) => t.id === result.reminder.id);
  assert.ok(reminderTask, 'reminder should be persisted and findable');
  assert.equal(reminderTask.reminder_sent_at, null, 'reminder has not fired yet');
});
