// B1 (location capture) + B2 (recurring events) — cheap schema additions,
// high daily value per the enhancement backlog: an address shouldn't have
// to get stuffed into the title, and a weekly commitment shouldn't have to
// be re-sent by hand every week.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import { buildRecurrenceRule, calendarPayloadFromCandidate, confirmReply } from '../../src/pipeline/classify.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('buildRecurrenceRule: weekly/biweekly/monthly map to real RRULEs, anything else is undefined', () => {
  assert.deepEqual(buildRecurrenceRule('weekly'), ['RRULE:FREQ=WEEKLY']);
  assert.deepEqual(buildRecurrenceRule('biweekly'), ['RRULE:FREQ=WEEKLY;INTERVAL=2']);
  assert.deepEqual(buildRecurrenceRule('monthly'), ['RRULE:FREQ=MONTHLY']);
  assert.equal(buildRecurrenceRule(null), undefined);
  assert.equal(buildRecurrenceRule('daily'), undefined, 'not a value the LLM is ever asked for — no rule for it');
});

test('calendarPayloadFromCandidate carries location straight through and turns recurrence into an RRULE array', () => {
  const payload = calendarPayloadFromCandidate(
    { title: 'Therapy', date: '2026-09-08', time: '16:00', location: 'Rothschild clinic', recurrence: 'weekly' },
    { familyMembers: [] }
  );
  assert.equal(payload.location, 'Rothschild clinic');
  assert.deepEqual(payload.recurrence, ['RRULE:FREQ=WEEKLY']);
});

test('calendarPayloadFromCandidate leaves location/recurrence undefined (not null) when absent', () => {
  const payload = calendarPayloadFromCandidate({ title: 'Dance', date: '2026-09-08', time: '16:00' }, { familyMembers: [] });
  assert.equal(payload.location, undefined);
  assert.equal(payload.recurrence, undefined);
});

test('confirmReply states the location and recurrence when present, in order after the time and before the person', () => {
  const reply = confirmReply({ title: 'Therapy', date: '2026-09-08', time: '16:00', location: 'Rothschild clinic', recurrence: 'weekly', person: 'Mia' });
  assert.equal(reply, 'Therapy, 2026-09-08 16:00 at Rothschild clinic for Mia (repeats weekly) — added ✅');
});

test('confirmReply omits both notes cleanly when neither is set (existing plain events unaffected)', () => {
  const reply = confirmReply({ title: 'Dance class', date: '2026-09-08', time: '16:00' });
  assert.equal(reply, 'Dance class, 2026-09-08 16:00 — added ✅');
});

test('a real capture with a location and a weekly recurrence writes both onto the real Calendar event and says so in the confirmation', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Therapy every Monday 4pm at Rothschild clinic': {
      title: 'Therapy', date: '2026-09-07', time: '16:00', end_time: null, person: null, category: 'appointment',
      location: 'Rothschild clinic', recurrence: 'weekly',
      reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🩺',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Therapy every Monday 4pm at Rothschild clinic', externalMessageId: 'wamid.loc1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'written');
  const written = calendar.events.get(result.eventRef.external_id);
  assert.equal(written.location, 'Rothschild clinic');
  assert.deepEqual(written.recurrence, ['RRULE:FREQ=WEEKLY']);
  assert.match(messenger.sent[0].text, /at Rothschild clinic/);
  assert.match(messenger.sent[0].text, /repeats weekly/);
});

test('a real capture with no location and no recurrence leaves both fields unset, exactly as before this feature existed', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  // No weekday name on purpose — classify.js's overrideNamedWeekday would
  // otherwise recompute the date against the real current date; this test
  // is about location/recurrence staying unset, not date resolution.
  const llm = createFakeLlm({
    'Dance class at 4pm': {
      title: 'Dance class', date: '2026-08-20', time: '16:00', end_time: null, person: null, category: 'activity',
      location: null, recurrence: null,
      reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '💃',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class at 4pm', externalMessageId: 'wamid.loc2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  const written = calendar.events.get(result.eventRef.external_id);
  assert.equal(written.location, undefined);
  assert.equal(written.recurrence, undefined);
  assert.equal(messenger.sent[0].text, 'Dance class, 2026-08-20 16:00 — added ✅');
});
