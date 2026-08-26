// Regression test for a real bug: "8.9.26, Commanders Day - Maccabiah for
// Roy, 9:00-18:00" was created as a 9:00-10:00 event instead of spanning
// the full range. Root cause: the extraction schema had no field at all
// for an end time -- pipeline.js always defaulted to a 1-hour block
// (addOneHour) regardless of what the message actually said. Fixed by
// adding llm.js's end_time field, used when present instead of the
// default.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import { confirmReply } from '../../src/pipeline/classify.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('an explicit time range is used as the real event duration, not a default 1-hour block', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Commanders Day - Maccabiah for Roy, 9:00-18:00 on 8.9.26': {
      title: 'Commanders Day - Maccabiah', date: '2026-09-08', time: '09:00', end_time: '18:00',
      person: 'Roy', category: 'activity', reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Commanders Day - Maccabiah for Roy, 9:00-18:00 on 8.9.26', externalMessageId: 'wamid.duration-regression-1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  const written = calendar.events.get(eventId);
  assert.equal(written.startDateTime, '2026-09-08T09:00:00');
  assert.equal(written.endDateTime, '2026-09-08T18:00:00', 'must span the full given range, not default to +1 hour');
});

test('no end_time given still defaults to a 1-hour block, unchanged from before', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dance class Thursday 4pm': {
      title: 'Dance class', date: '2026-08-20', time: '16:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class Thursday 4pm', externalMessageId: 'wamid.duration-regression-2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  const written = calendar.events.get(eventId);
  assert.equal(written.startDateTime, '2026-08-20T16:00:00');
  assert.equal(written.endDateTime, '2026-08-20T17:00:00');
});

test('an end_time earlier than the start time rolls over to the next day (an overnight range)', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Sleepover 9pm to 1am Friday': {
      title: 'Sleepover', date: '2026-08-21', time: '21:00', end_time: '01:00',
      person: null, category: null, reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Sleepover 9pm to 1am Friday', externalMessageId: 'wamid.duration-regression-3' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  const written = calendar.events.get(eventId);
  assert.equal(written.startDateTime, '2026-08-21T21:00:00');
  assert.equal(written.endDateTime, '2026-08-22T01:00:00', 'end time <= start time must roll to the next day, not land before the event starts');
});

test('confirmReply echoes the end time back when one was given', () => {
  assert.match(confirmReply({ title: 'Commanders Day', date: '2026-09-08', time: '09:00', end_time: '18:00' }), /09:00–18:00/);
  assert.doesNotMatch(confirmReply({ title: 'Dance class', date: '2026-08-20', time: '16:00' }), /–/);
});
