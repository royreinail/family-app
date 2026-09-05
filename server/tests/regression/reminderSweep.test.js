// Gap audit: sweepDueReminders is the mechanism that actually DELIVERS a
// requested reminder (server.js runs it on a 60s interval) — the part of
// the whole "remind me to X at T" feature the user actually experiences —
// and had zero test coverage anywhere in this suite. scheduleReminder
// (creating the row) and the timezone conversion it depends on are well
// covered (reminderTimezone.test.js); the sweep that reads it back out
// was not.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeMessenger } from '../setup/fakes.js';
import * as tasksRepo from '../../src/repositories/tasks.js';
import * as extractionLogRepo from '../../src/repositories/extractionLog.js';
import { sweepDueReminders } from '../../src/pipeline/reminders.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('sends a reminder whose time has arrived, to the sender who originally asked for it, and marks it sent', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const messenger = createFakeMessenger();
  const log = await extractionLogRepo.create(
    { familyId: family.id, rawInput: 'Remind me to pick up the dry cleaning', senderIdentifier: knownSender, externalMessageId: 'wamid.sweep-1' },
    pool
  );
  const task = await tasksRepo.create(
    {
      familyId: family.id, title: 'Reminder: pick up the dry cleaning', dueDate: '2026-09-05',
      reminderPolicy: 'requested', reminderDatetime: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago -- due
      sourceExtractionLogId: log.id,
    },
    pool
  );

  const sent = await sweepDueReminders({ pool, messenger });

  assert.equal(sent.length, 1);
  assert.equal(messenger.sent.length, 1);
  assert.equal(messenger.sent[0].to, knownSender);
  assert.equal(messenger.sent[0].text, 'Reminder: pick up the dry cleaning');

  const after = await tasksRepo.findAllForFamily(family.id, pool);
  assert.ok(after.find((t) => t.id === task.id).reminder_sent_at, 'must be marked sent so it never fires twice');
});

test('a reminder whose time has not arrived yet is left alone entirely', async () => {
  const { family } = await seedFamily(pool);
  const messenger = createFakeMessenger();
  await tasksRepo.create(
    {
      familyId: family.id, title: 'Reminder: future thing', dueDate: '2026-12-25',
      reminderPolicy: 'requested', reminderDatetime: new Date(Date.now() + 60 * 60_000).toISOString(), // 1 hour from now
    },
    pool
  );

  const sent = await sweepDueReminders({ pool, messenger });

  assert.equal(sent.length, 0);
  assert.equal(messenger.sent.length, 0);
});

test('a reminder already sent once is never re-sent, even though it stays "due" by time', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const messenger = createFakeMessenger();
  const log = await extractionLogRepo.create(
    { familyId: family.id, rawInput: 'Remind me', senderIdentifier: knownSender, externalMessageId: 'wamid.sweep-2' },
    pool
  );
  const task = await tasksRepo.create(
    {
      familyId: family.id, title: 'Reminder: already handled', dueDate: '2026-09-05',
      reminderPolicy: 'requested', reminderDatetime: new Date(Date.now() - 60_000).toISOString(),
      sourceExtractionLogId: log.id,
    },
    pool
  );
  await tasksRepo.markReminderSent(task.id, pool);

  const sent = await sweepDueReminders({ pool, messenger });

  assert.equal(sent.length, 0, 'findDueReminders excludes anything with reminder_sent_at already set');
  assert.equal(messenger.sent.length, 0);
});

test('a due reminder with no traceable sender (source log missing/no sender) is marked sent without crashing, but nothing is actually delivered', async () => {
  const { family } = await seedFamily(pool);
  const messenger = createFakeMessenger();
  // No sourceExtractionLogId at all -- a real gap in the data, not
  // something the sweep can recover from; documents the actual behavior
  // (marked sent so it's not retried forever) rather than assuming.
  const task = await tasksRepo.create(
    {
      familyId: family.id, title: 'Reminder: orphaned', dueDate: '2026-09-05',
      reminderPolicy: 'requested', reminderDatetime: new Date(Date.now() - 60_000).toISOString(),
    },
    pool
  );

  const sent = await sweepDueReminders({ pool, messenger });

  assert.equal(sent.length, 1);
  assert.equal(messenger.sent.length, 0, 'nothing to send to -- silently skipped, not sent to nobody');
  const after = await tasksRepo.findAllForFamily(family.id, pool);
  assert.ok(after.find((t) => t.id === task.id).reminder_sent_at, 'still marked sent so it is not retried forever');
});

test('multiple due reminders across different senders are each delivered to the right person in one sweep', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const otherSender = '+15559998888';
  const messenger = createFakeMessenger();
  const logA = await extractionLogRepo.create(
    { familyId: family.id, rawInput: 'Remind me A', senderIdentifier: knownSender, externalMessageId: 'wamid.sweep-3a' },
    pool
  );
  const logB = await extractionLogRepo.create(
    { familyId: family.id, rawInput: 'Remind me B', senderIdentifier: otherSender, externalMessageId: 'wamid.sweep-3b' },
    pool
  );
  await tasksRepo.create(
    { familyId: family.id, title: 'Reminder: A', dueDate: '2026-09-05', reminderPolicy: 'requested', reminderDatetime: new Date(Date.now() - 60_000).toISOString(), sourceExtractionLogId: logA.id },
    pool
  );
  await tasksRepo.create(
    { familyId: family.id, title: 'Reminder: B', dueDate: '2026-09-05', reminderPolicy: 'requested', reminderDatetime: new Date(Date.now() - 60_000).toISOString(), sourceExtractionLogId: logB.id },
    pool
  );

  const sent = await sweepDueReminders({ pool, messenger });

  assert.equal(sent.length, 2);
  assert.deepEqual(new Set(messenger.sent.map((m) => m.to)), new Set([knownSender, otherSender]));
});
