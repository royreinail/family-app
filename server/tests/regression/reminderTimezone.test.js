// Regression test for a real production bug Roy hit: "remind me to do the
// laundry at 22:30 today" (family in Asia/Jerusalem, UTC+3 in August)
// arrived at 1:30am instead of 22:30. Root cause: reminder_datetime is a
// naive local wall-clock string from the LLM (same convention as date/time
// elsewhere), but unlike those fields -- which only ever reach Google
// Calendar alongside an explicit timeZone -- it was inserted straight into
// a `timestamptz` column with no offset attached, so Postgres interpreted
// it as the *server's* UTC, not the family's zone. 22:30 got stored as
// 22:30 UTC, which is 01:30 the next day in Jerusalem (UTC+3) -- exactly
// what Roy saw. See classify.js's localDateTimeToUtcIso for the fix.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as tasksRepo from '../../src/repositories/tasks.js';
import { localDateTimeToUtcIso, todayInTimeZone } from '../../src/pipeline/classify.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('localDateTimeToUtcIso converts a local wall-clock time to the correct UTC instant', () => {
  // Asia/Jerusalem is UTC+3 in August (IDT) -- 22:30 local is 19:30 UTC,
  // three hours *earlier*, not later.
  assert.equal(localDateTimeToUtcIso('2026-08-19', '22:30', 'Asia/Jerusalem'), '2026-08-19T19:30:00.000Z');
  // A negative-offset zone to confirm the correction runs both directions:
  // America/New_York is UTC-4 in August (EDT) -- 22:30 local is 02:30 UTC
  // the *next* day.
  assert.equal(localDateTimeToUtcIso('2026-08-19', '22:30', 'America/New_York'), '2026-08-20T02:30:00.000Z');
  // UTC itself must be a no-op.
  assert.equal(localDateTimeToUtcIso('2026-08-19', '22:30', 'UTC'), '2026-08-19T22:30:00.000Z');
});

test('a reminder set for 22:30 in Asia/Jerusalem fires at 22:30 Jerusalem time, not 22:30 UTC', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  // Real, pre-existing flakiness caught: this used raw UTC
  // (new Date().toISOString().slice(0,10)) for "today," but the pipeline
  // deterministically resolves "today" against the FAMILY's own timezone
  // (overrideObviousRelativeDate -> todayInTimeZone('Asia/Jerusalem')).
  // Those two disagree for part of every day whenever Jerusalem's local
  // date has already rolled over but UTC's hasn't (e.g. 22:00-24:00 UTC in
  // summer) — exactly the class of bug this whole file exists to guard
  // against, just relocated into the test's own fixture instead of the
  // app. Compute "today" the same way the app actually will.
  const today = todayInTimeZone('Asia/Jerusalem');
  const llm = createFakeLlm({
    'Remind me to do the laundry at 22:30 today': {
      title: 'do the laundry', date: today, time: '22:30', person: null, category: null,
      reminder_requested: true, reminder_datetime: `${today}T22:30:00`,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Remind me to do the laundry at 22:30 today', externalMessageId: 'wamid.reminder-tz-1' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem' }
  );

  assert.equal(result.outcome, 'written');
  assert.equal(result.destination, 'tasks');

  const tasks = await tasksRepo.findAllForFamily(family.id, pool);
  assert.equal(tasks.length, 1);
  // The bug: this used to equal `${today}T22:30:00.000Z` (22:30 UTC, i.e.
  // 1:30am the next day in Jerusalem) instead of the correct UTC instant.
  const expectedUtc = localDateTimeToUtcIso(today, '22:30', 'Asia/Jerusalem');
  assert.equal(tasks[0].reminder_datetime.toISOString(), expectedUtc);
  assert.notEqual(tasks[0].reminder_datetime.toISOString(), `${today}T22:30:00.000Z`, 'must not be stored as naive 22:30 UTC');
});

test('a standalone requested reminder (event + separate reminder, fixture 7 shape) also converts to the family timezone', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Remind me to pack the gym bag Thursday night, gym class is Friday 9am': {
      title: 'Gym class', date: '2026-08-28', time: '09:00', person: null, category: 'activity',
      reminder_requested: true, reminder_datetime: '2026-08-27T20:00:00',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Remind me to pack the gym bag Thursday night, gym class is Friday 9am', externalMessageId: 'wamid.reminder-tz-2' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem' }
  );

  assert.equal(result.outcome, 'written');
  assert.equal(result.destination, 'calendar');
  assert.ok(result.reminder);
  assert.equal(result.reminder.reminder_datetime.toISOString(), localDateTimeToUtcIso('2026-08-27', '20:00', 'Asia/Jerusalem'));
});
