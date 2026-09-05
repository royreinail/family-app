// Real gap caught live: Roy's own A1 query hit a dead Google refresh token
// (GaxiosError invalid_grant) and got the generic "try again in a bit" —
// misleading, since retrying can never succeed until the family
// reconnects. Auditing every calendar-touching path for the same
// distinction dashboard.js already makes (isReauthRequiredError) also
// found that NONE of the three calendar.createEvent call sites had any
// error handling at all — an uncaught throw meant the sender got zero
// reply, worse than the "wrong message" A1 gave.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as tasksRepo from '../../src/repositories/tasks.js';
import { calendarErrorReply } from '../../src/pipeline/classify.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

function deadTokenError() {
  return new Error('invalid_grant');
}

test('calendarErrorReply: a dead token gets an actionable reconnect message, anything else gets a generic retry', () => {
  assert.match(calendarErrorReply(deadTokenError()), /reconnect it from Settings/);
  assert.match(calendarErrorReply(new Error('ECONNRESET')), /try again in a bit/);
  assert.match(calendarErrorReply(new Error('ECONNRESET'), { action: 'write' }), /Couldn't add that/);
});

test('a real Calendar write failure now gets an honest reply instead of total silence', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  calendar.createEvent = async () => { throw deadTokenError(); };
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dance class Thursday 4pm': {
      title: 'Dance class', date: '2026-08-20', time: '16:00', end_time: null, person: null, category: 'activity',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '💃',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class Thursday 4pm', externalMessageId: 'wamid.err1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'failed');
  assert.equal(messenger.sent.length, 1, 'the sender gets a reply, not silence');
  assert.match(messenger.sent[0].text, /reconnect it from Settings/);
});

test('a Calendar failure while promoting a needs_time event does not delete the parked task, and replies honestly', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Bring $10 for the field trip by Friday': {
      title: 'Bring $10 for the field trip', date: '2026-08-21', time: null, person: null, category: 'todo',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const parked = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Bring $10 for the field trip by Friday', externalMessageId: 'wamid.err2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(parked.outcome, 'needs_time');
  const tasksBefore = await tasksRepo.findAllForFamily(family.id, pool);
  assert.equal(tasksBefore.length, 1);

  // Now the calendar write fails when the time answer arrives.
  calendar.createEvent = async () => { throw deadTokenError(); };
  const completed = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: '4pm', externalMessageId: 'wamid.err3' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(completed.outcome, 'failed');
  assert.match(messenger.sent[1].text, /reconnect it from Settings/);
  const tasksAfter = await tasksRepo.findAllForFamily(family.id, pool);
  assert.equal(tasksAfter.length, 1, 'the parked placeholder task must survive a failed promotion, not be deleted before the write even succeeded');
});

// Gap audit: the write path above got 4 dedicated tests for exactly this
// scenario after being found live — but A1's own read (calendar.listEvents
// inside handleReadBackQuery) and A2's own search (calendar.listEvents
// inside handleManagementRequest) never got the equivalent treatment,
// despite this whole file existing BECAUSE Roy's real report was an A1
// query hitting this exact error. Both already call calendarErrorReply
// (confirmed by reading pipeline.js directly, not assumed) — these
// confirm it end to end, not just that the pure function itself works.
test('A1 read-back query: a dead token gets the actionable reconnect message, not the generic retry', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  calendar.listEvents = async () => { throw deadTokenError(); };
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    "What's on tomorrow?": { type: 'query', date_from: '2026-09-05', date_to: '2026-09-05', person: null },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: "What's on tomorrow?", externalMessageId: 'wamid.err-a1-1' },
    { pool, llmExtract: llm.extract, calendar, messenger, calendarConnected: true }
  );

  assert.equal(result.outcome, 'failed');
  assert.match(messenger.sent[0].text, /reconnect it from Settings/);
});

test('A1 read-back query: a transient Calendar hiccup gets the generic retry message, not a raw error', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  calendar.listEvents = async () => { throw new Error('ECONNRESET'); };
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    "What's on tomorrow?": { type: 'query', date_from: '2026-09-05', date_to: '2026-09-05', person: null },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: "What's on tomorrow?", externalMessageId: 'wamid.err-a1-2' },
    { pool, llmExtract: llm.extract, calendar, messenger, calendarConnected: true }
  );

  assert.equal(result.outcome, 'failed');
  assert.match(messenger.sent[0].text, /try again in a bit/);
  assert.doesNotMatch(messenger.sent[0].text, /ECONNRESET/, 'never leak the raw error to the sender');
});

test('A2 cancel/reschedule search: a dead token gets the actionable reconnect message', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  calendar.listEvents = async () => { throw deadTokenError(); };
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Cancel dance class': { type: 'management', management_action: 'cancel', event_description: 'dance class', date_hint: null, new_date: null, new_time: null },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Cancel dance class', externalMessageId: 'wamid.err-a2-1' },
    { pool, llmExtract: llm.extract, calendar, messenger, calendarConnected: true }
  );

  assert.equal(result.outcome, 'failed');
  assert.match(messenger.sent[0].text, /reconnect it from Settings/);
});

test('a single failing additional_events item is named as failed in the note, without losing the primary write or the other additional items', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const realCreateEvent = calendar.createEvent;
  calendar.createEvent = async (evt) => {
    if (evt.title === 'Art class') throw new Error('transient Calendar hiccup');
    return realCreateEvent(evt);
  };
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Swimming Tue 4pm, art class Thu 5pm, field trip Fri 6pm': {
      title: 'Swimming', date: '2026-09-08', time: '16:00', end_time: null, person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🏊',
      additional_events: [
        { title: 'Art class', date: '2026-09-10', time: '17:00', end_time: null, person: null, audience: 'family', activity_icon: '🎨' },
        { title: 'Field trip', date: '2026-09-11', time: '18:00', end_time: null, person: null, audience: 'family', activity_icon: '🚌' },
      ],
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Swimming Tue 4pm, art class Thu 5pm, field trip Fri 6pm', externalMessageId: 'wamid.err4' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written', 'the primary event still writes fine');
  assert.equal(calendar.events.size, 2, 'Swimming + Field trip; Art class failed');
  assert.match(messenger.sent[1].text, /Art class.*couldn't add it, try resending just that one/);
  assert.match(messenger.sent[1].text, /Field trip.*added ✅/);
});
