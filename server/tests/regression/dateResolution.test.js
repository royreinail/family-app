// Regression test for a real production bug found in live testing:
// "tomorrow" resolved to the day after tomorrow. Deliberately makes the fake
// LLM return that exact wrong answer (simulating an LLM date-arithmetic
// slip) and asserts the deterministic override in classify.js corrects it —
// see overrideObviousRelativeDate.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import { todayInTimeZone, addDays } from '../../src/pipeline/classify.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('"tomorrow" resolves to the correct date even when the LLM gets the arithmetic wrong', async () => {
  const { family, knownSender } = await seedFamily(pool); // timezone: America/New_York
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();

  const trueToday = todayInTimeZone('America/New_York');
  const trueTomorrow = addDays(trueToday, 1);
  const wrongDayAfterTomorrow = addDays(trueToday, 2); // the exact bug observed in live testing

  const llm = createFakeLlm({
    'Dance class tomorrow 4pm': {
      title: 'Dance class', date: wrongDayAfterTomorrow, time: '16:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class tomorrow 4pm', externalMessageId: 'wamid.date-regression-1' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'America/New_York' }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).startDateTime.slice(0, 10), trueTomorrow, 'event should land on the real tomorrow, not the LLM\'s wrong guess');
});

test('"today" resolves to the reference date itself, overriding a wrong LLM guess', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();

  const trueToday = todayInTimeZone('America/New_York');
  const wrongTomorrow = addDays(trueToday, 1);

  const llm = createFakeLlm({
    'Piano recital today 6pm': {
      title: 'Piano recital', date: wrongTomorrow, time: '18:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Piano recital today 6pm', externalMessageId: 'wamid.date-regression-2' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'America/New_York' }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).startDateTime.slice(0, 10), trueToday);
});
