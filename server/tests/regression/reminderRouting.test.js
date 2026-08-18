// Regression test for a real production bug: "remind me to do the laundry
// at 22:30 today" created a Calendar event titled "laundry" instead of
// going through tasks + the reminder mechanism. See
// isReminderOnlyMessage/extraction_classification:pure_reminder.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as tasksRepo from '../../src/repositories/tasks.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('a pure reminder request ("remind me to X at T") goes to tasks, not Calendar', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Remind me to do the laundry at 22:30 today': {
      title: 'do the laundry', date: '2026-08-18', time: '22:30', person: null, category: null,
      reminder_requested: true, reminder_datetime: '2026-08-18T22:30:00',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Remind me to do the laundry at 22:30 today', externalMessageId: 'wamid.reminder-routing-1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  assert.equal(result.destination, 'tasks', 'should not become a Calendar event');
  assert.equal(result.rule.name, 'extraction_classification:pure_reminder');
  assert.equal(calendar.events.size, 0, 'no Calendar event should be created at all');

  const tasks = await tasksRepo.findAllForFamily(family.id, pool);
  assert.equal(tasks.length, 1, 'exactly one task — not a duplicate reminder-carrier row');
  assert.equal(tasks[0].reminder_policy, 'requested');
  assert.equal(tasks[0].reminder_datetime.toISOString(), '2026-08-18T22:30:00.000Z');
  assert.equal(messenger.sent.length, 1);
  assert.match(messenger.sent[0].text, /remind you/i);
});

test('a real event plus an unrelated reminder still writes to Calendar (fixture 7 shape preserved)', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Remind me to pack the gym bag Thursday night, gym class is Friday 9am': {
      title: 'Gym class', date: '2026-08-27', time: '09:00', person: null, category: 'activity',
      reminder_requested: true, reminder_datetime: '2026-08-26T20:00:00',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Remind me to pack the gym bag Thursday night, gym class is Friday 9am', externalMessageId: 'wamid.reminder-routing-2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  assert.equal(result.destination, 'calendar', 'the real event should still be written to Calendar');
  assert.equal(calendar.events.size, 1);
  assert.ok(result.reminder, 'a separate reminder-carrier task should still be scheduled');
  assert.equal(result.reminder.reminder_datetime.toISOString(), '2026-08-26T20:00:00.000Z');
});
