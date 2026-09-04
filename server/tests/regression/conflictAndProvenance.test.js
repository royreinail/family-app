// B3 (conflict detection) + B4 (provenance) — second-tier backlog items.
// B3 flags, never blocks; B4 writes the original message onto the Calendar
// event's own description field.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import { findConflicts, formatConflictNote, calendarPayloadFromCandidate } from '../../src/pipeline/classify.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('findConflicts: real overlap for the same person is found, a different person and a non-overlapping time are not', () => {
  const payload = { personId: 'mia', startDateTime: '2026-09-08T16:00:00', endDateTime: '2026-09-08T17:00:00' };
  const overlapping = { summary: 'Art class', extendedProperties: { private: { personId: 'mia' } }, start: { dateTime: '2026-09-08T16:30:00' }, end: { dateTime: '2026-09-08T18:00:00' } };
  const otherPerson = { summary: 'Theo dentist', extendedProperties: { private: { personId: 'theo' } }, start: { dateTime: '2026-09-08T16:00:00' }, end: { dateTime: '2026-09-08T17:00:00' } };
  const noOverlap = { summary: 'Mia earlier thing', extendedProperties: { private: { personId: 'mia' } }, start: { dateTime: '2026-09-08T09:00:00' }, end: { dateTime: '2026-09-08T10:00:00' } };

  assert.deepEqual(findConflicts(payload, [overlapping, otherPerson, noOverlap]), [overlapping]);
  assert.deepEqual(findConflicts({ ...payload, personId: null }, [overlapping]), [], 'no personId to check against — nothing flagged');
});

test('formatConflictNote states who and what, singular vs. plural', () => {
  assert.equal(formatConflictNote([], 'Mia'), '');
  assert.equal(
    formatConflictNote([{ summary: 'Art class', start: { dateTime: '2026-09-08T16:30:00' } }], 'Mia'),
    '\n(note: Mia already has Art class at 16:30)'
  );
  assert.match(
    formatConflictNote(
      [{ summary: 'Art class', start: { dateTime: '2026-09-08T16:30:00' } }, { summary: 'Piano', start: { dateTime: '2026-09-08T16:45:00' } }],
      'Mia'
    ),
    /already have Art class at 16:30, Piano at 16:45/
  );
});

test('calendarPayloadFromCandidate: sourceText becomes the description, absent when not given', () => {
  const withSource = calendarPayloadFromCandidate({ title: 'Dance', date: '2026-09-08', time: '16:00' }, { sourceText: 'Dance class Tuesday 4pm' });
  assert.equal(withSource.description, 'From: "Dance class Tuesday 4pm"');
  const withoutSource = calendarPayloadFromCandidate({ title: 'Dance', date: '2026-09-08', time: '16:00' }, {});
  assert.equal(withoutSource.description, undefined);
});

test('a real capture writes the original message text into the event description, and a real double-booking for the same person is flagged (not blocked)', async () => {
  const { family, parent, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Art class for Dana Tuesday 4pm': {
      title: 'Art class', date: '2026-09-08', time: '16:00', end_time: null, person: 'Dana', category: 'activity',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🎨',
    },
    'Piano for Dana Tuesday 4:30pm': {
      title: 'Piano', date: '2026-09-08', time: '16:30', end_time: null, person: 'Dana', category: 'activity',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🎹',
    },
  });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Art class for Dana Tuesday 4pm', externalMessageId: 'wamid.cp1' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent] }
  );
  const written = calendar.events.get(first.eventRef.external_id);
  assert.equal(written.description, 'From: "Art class for Dana Tuesday 4pm"');
  assert.equal(messenger.sent[0].text.includes('note:'), false, 'no conflict yet — nothing else on the calendar');

  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Piano for Dana Tuesday 4:30pm', externalMessageId: 'wamid.cp2' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent] }
  );

  assert.equal(second.outcome, 'written', 'the conflicting event is still created — flagged, not blocked');
  assert.equal(calendar.events.size, 2);
  assert.match(second.reply, /note: Dana already has Art class at 16:00/);
});

test('a capture for an unmatched/unknown person skips the conflict check silently (no note, no crash)', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  // No weekday name in the text on purpose (same reasoning as
  // reminderRouting.test.js's own fixtures) — classify.js's
  // overrideNamedWeekday would otherwise recompute the date against the
  // real current date and desync it from this hardcoded fixture; this test
  // is about the conflict check being skipped, not date resolution.
  const llm = createFakeLlm({
    'Dance class at 4pm': {
      title: 'Dance class', date: '2026-08-20', time: '16:00', end_time: null, person: null, category: 'activity',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '💃',
    },
  });
  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class at 4pm', externalMessageId: 'wamid.cp3' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [] }
  );
  assert.equal(result.reply, 'Dance class, 2026-08-20 16:00 — added ✅');
});

// Real gap caught on a later audit pass: the direct write_calendar branch
// got a conflict check, but the follow-up-promotion path (a date-only
// message parked as needs_time, later completed by a bare time answer)
// didn't — even though it ends in the exact same kind of Calendar create.
test('a conflict is also flagged when an event is completed via the "what time?" follow-up, not just a direct write', async () => {
  const { family, parent, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Art class for Dana Tuesday 4pm': {
      title: 'Art class', date: '2026-09-08', time: '16:00', end_time: null, person: 'Dana', category: 'activity',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🎨',
    },
    'Piano for Dana Tuesday': {
      title: 'Piano', date: '2026-09-08', time: null, end_time: null, person: 'Dana', category: 'activity',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🎹',
    },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Art class for Dana Tuesday 4pm', externalMessageId: 'wamid.cp4' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent] }
  );
  const parked = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Piano for Dana Tuesday', externalMessageId: 'wamid.cp5' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent] }
  );
  assert.equal(parked.outcome, 'needs_time');

  const completed = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: '4:30pm', externalMessageId: 'wamid.cp6' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent] }
  );

  assert.equal(completed.outcome, 'written');
  assert.match(completed.reply, /note: Dana already has Art class at 16:00/);
});
