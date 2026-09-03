// Regression coverage for A2 (enhancement backlog, claude-code-enhancements.md):
// "cancel dance class Thursday", "move it to 17:00" now actually cancel or
// reschedule a real Calendar event, instead of the bot only ever being
// able to create new things. Shares its intent-classification shape with
// A1 (a third tool, record_management, alongside record_extraction/
// record_query — see llm.js) and its disambiguation behavior is D-2's
// explicit decision: when a description matches more than one event, list
// them and ask which one, never refuse and never silently guess.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as extractionLogRepo from '../../src/repositories/extractionLog.js';
import { matchEventsByDescription, formatDisambiguationReply, formatNoMatchReply, naiveDateTimeToUtcMs, utcMsToNaiveDateTime } from '../../src/pipeline/classify.js';
import { bareDisambiguationChoice } from '../../src/pipeline/commands.js';

let pool;

// Real bug caught writing the reschedule duration math: a naive wall-clock
// string ("2026-09-03T17:00:00", no offset) round-tripped through plain
// `new Date()` + `.toISOString()` silently picks up whatever timezone the
// *server process* happens to be running in — the exact bug class
// addOneHour/localDateTimeToUtcIso already exist elsewhere in this file to
// avoid. This asserts the duration arithmetic itself is immune to that,
// regardless of the test machine's own local TZ.
test('naiveDateTimeToUtcMs/utcMsToNaiveDateTime round-trip and compute durations correctly, independent of the host\'s local timezone', () => {
  const start = '2026-09-03T09:00:00';
  const end = '2026-09-03T09:30:00';
  const durationMs = naiveDateTimeToUtcMs(end) - naiveDateTimeToUtcMs(start);
  assert.equal(durationMs, 30 * 60 * 1000);

  const newStart = '2026-09-03T17:00:00';
  const newEnd = utcMsToNaiveDateTime(naiveDateTimeToUtcMs(newStart) + durationMs);
  assert.equal(newEnd, '2026-09-03T17:30:00');
});

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('matchEventsByDescription: word overlap in the title, not an exact/substring match; dateHint requires an exact same-day match', () => {
  const events = [
    { summary: 'Dance class', start: { dateTime: '2026-09-03T16:00:00' } },
    { summary: 'Dance rehearsal', start: { dateTime: '2026-09-03T18:00:00' } },
    { summary: 'Dentist appointment', start: { dateTime: '2026-09-04T09:00:00' } },
  ];
  assert.equal(matchEventsByDescription(events, { titleHint: 'the dance thing' }).length, 2);
  assert.equal(matchEventsByDescription(events, { titleHint: 'dentist' }).length, 1);
  assert.equal(matchEventsByDescription(events, { titleHint: 'soccer' }).length, 0);
  assert.equal(matchEventsByDescription(events, { titleHint: 'dance', dateHint: '2026-09-04' }).length, 0, 'a wrong-day match must not count');
  assert.equal(matchEventsByDescription(events, { titleHint: null, dateHint: '2026-09-04' }).length, 1, 'a date-only request with no title text matches everything that day');
});

test('bareDisambiguationChoice is strict about what counts as just picking an option', () => {
  for (const yes of ['1', ' 2 ', '#3', 'number 1', 'no. 2', 'option 3', '1.']) {
    assert.ok(bareDisambiguationChoice(yes) >= 1, `${JSON.stringify(yes)} should resolve to a choice`);
  }
  for (const no of ['', 'Dentist tomorrow at 3pm', 'cancel it', 'the 2nd one please']) {
    assert.equal(bareDisambiguationChoice(no), null, `${JSON.stringify(no)} should not resolve to a bare choice`);
  }
});

test('formatDisambiguationReply and formatNoMatchReply', () => {
  const candidates = [
    { summary: 'Dance class', start: { dateTime: '2026-09-03T16:00:00' } },
    { summary: 'Dance rehearsal', start: { dateTime: '2026-09-03T18:00:00' } },
  ];
  const reply = formatDisambiguationReply(candidates, 'cancel');
  assert.match(reply, /1\. Dance class, 2026-09-03 16:00/);
  assert.match(reply, /2\. Dance rehearsal, 2026-09-03 18:00/);
  assert.match(formatNoMatchReply('soccer'), /soccer/);
});

test('cancelling a single unambiguous match deletes the real event and retires its original log', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dance class Thursday 4pm': {
      title: 'Dance class', date: '2026-09-03', time: '16:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
    'Cancel dance class': { type: 'management', management_action: 'cancel', event_description: 'dance class', date_hint: null, new_date: null, new_time: null },
  });

  const created = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class Thursday 4pm', externalMessageId: 'wamid.mgmt-1a' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(calendar.events.size, 1);

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Cancel dance class', externalMessageId: 'wamid.mgmt-1b' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'UTC', calendarConnected: true }
  );

  assert.equal(result.outcome, 'managed');
  assert.equal(calendar.events.size, 0, 'the real event must actually be deleted');
  assert.match(result.reply, /Cancelled/);
  assert.match(result.reply, /Dance class/);

  const originalLog = await extractionLogRepo.findById(created.log.id, pool);
  assert.equal(originalLog.state, 'undone', 'the original write must be retired, same convention as the undo command');
});

test('a description matching more than one event asks which one (D-2), touching nothing yet', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dance class Thursday 4pm': {
      title: 'Dance class', date: '2026-09-03', time: '16:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
    'Dance rehearsal Thursday 6pm': {
      title: 'Dance rehearsal', date: '2026-09-03', time: '18:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
    'Cancel the dance thing': { type: 'management', management_action: 'cancel', event_description: 'dance', date_hint: null, new_date: null, new_time: null },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class Thursday 4pm', externalMessageId: 'wamid.mgmt-2a' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance rehearsal Thursday 6pm', externalMessageId: 'wamid.mgmt-2b' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Cancel the dance thing', externalMessageId: 'wamid.mgmt-2c' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'UTC', calendarConnected: true }
  );

  assert.equal(result.outcome, 'needs_disambiguation');
  assert.equal(calendar.events.size, 2, 'nothing gets touched until the user actually picks one');
  assert.match(result.reply, /1\. Dance class/);
  assert.match(result.reply, /2\. Dance rehearsal/);

  // Now resolve it with a bare number, mirroring a real follow-up reply.
  const resolved = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: '2', externalMessageId: 'wamid.mgmt-2d' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(resolved.outcome, 'managed');
  assert.equal(calendar.events.size, 1, 'exactly the chosen event is gone');
  assert.match(resolved.reply, /Dance rehearsal/);
  const remaining = [...calendar.events.values()][0];
  assert.equal(remaining.title, 'Dance class', 'the *other* match must survive untouched');
});

test('an out-of-range disambiguation reply does not silently pick something', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dance class Thursday 4pm': {
      title: 'Dance class', date: '2026-09-03', time: '16:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
    'Dance rehearsal Thursday 6pm': {
      title: 'Dance rehearsal', date: '2026-09-03', time: '18:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
    'Cancel the dance thing': { type: 'management', management_action: 'cancel', event_description: 'dance', date_hint: null, new_date: null, new_time: null },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class Thursday 4pm', externalMessageId: 'wamid.mgmt-3a' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance rehearsal Thursday 6pm', externalMessageId: 'wamid.mgmt-3b' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Cancel the dance thing', externalMessageId: 'wamid.mgmt-3c' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'UTC', calendarConnected: true }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: '9', externalMessageId: 'wamid.mgmt-3d' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(calendar.events.size, 2, 'nothing must be deleted on an invalid choice');
  assert.match(result.reply, /1 to 2/);
});

test('rescheduling with a given time moves the real event and preserves its original duration', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dentist Thursday 9am-9:30am': {
      title: 'Dentist', date: '2026-09-03', time: '09:00', end_time: '09:30', person: null, category: 'appointment',
      reminder_requested: false, reminder_datetime: null,
    },
    'Move dentist to 5pm': {
      type: 'management', management_action: 'reschedule', event_description: 'dentist', date_hint: null, new_date: null, new_time: '17:00',
    },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dentist Thursday 9am-9:30am', externalMessageId: 'wamid.mgmt-4a' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Move dentist to 5pm', externalMessageId: 'wamid.mgmt-4b' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'UTC', calendarConnected: true }
  );

  assert.equal(result.outcome, 'managed');
  assert.match(result.reply, /Moved/);
  const [event] = [...calendar.events.values()];
  assert.equal(event.startDateTime, '2026-09-03T17:00:00');
  assert.equal(event.endDateTime, '2026-09-03T17:30:00', 'the original 30-minute duration must survive the move');
});

test('rescheduling with no target time/date at all asks instead of silently no-op-ing', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Dentist Thursday 9am': {
      title: 'Dentist', date: '2026-09-03', time: '09:00', person: null, category: 'appointment',
      reminder_requested: false, reminder_datetime: null,
    },
    'Move the dentist appointment': {
      type: 'management', management_action: 'reschedule', event_description: 'dentist appointment', date_hint: null, new_date: null, new_time: null,
    },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dentist Thursday 9am', externalMessageId: 'wamid.mgmt-5a' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Move the dentist appointment', externalMessageId: 'wamid.mgmt-5b' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'UTC', calendarConnected: true }
  );

  assert.match(result.reply, /what time/i);
  const [event] = [...calendar.events.values()];
  assert.equal(event.startDateTime, '2026-09-03T09:00:00', 'must not have silently "rescheduled" it to its own existing time');
});

test('no matching event at all gets an honest reply, nothing touched', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Cancel soccer practice': { type: 'management', management_action: 'cancel', event_description: 'soccer practice', date_hint: null, new_date: null, new_time: null },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Cancel soccer practice', externalMessageId: 'wamid.mgmt-6' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'UTC', calendarConnected: true }
  );

  assert.equal(result.outcome, 'query_failed');
  assert.match(result.reply, /couldn't find/i);
  assert.equal(calendar.events.size, 0);
});

test('management can find and cancel a parent_only event -- audience only controls the kid dashboard, not what a parent can manage', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Doctor appointment Thursday 9am, just for me': {
      title: 'Doctor appointment', date: '2026-09-03', time: '09:00', person: null, category: 'appointment',
      reminder_requested: false, reminder_datetime: null, audience: 'parent_only',
    },
    'Cancel my doctor appointment': { type: 'management', management_action: 'cancel', event_description: 'doctor appointment', date_hint: null, new_date: null, new_time: null },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Doctor appointment Thursday 9am, just for me', externalMessageId: 'wamid.mgmt-7a' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Cancel my doctor appointment', externalMessageId: 'wamid.mgmt-7b' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'UTC', calendarConnected: true }
  );

  assert.equal(result.outcome, 'managed');
  assert.equal(calendar.events.size, 0);
});

test('a management request gets a clean "connect Calendar first" reply when not connected', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Cancel dance class': { type: 'management', management_action: 'cancel', event_description: 'dance class', date_hint: null, new_date: null, new_time: null },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Cancel dance class', externalMessageId: 'wamid.mgmt-8' },
    { pool, llmExtract: llm.extract, calendar, messenger, calendarConnected: false }
  );

  assert.match(messenger.sent.at(-1).text, /connect/i);
});
