// Event adoption — not every Calendar event is created by the bot; someone
// can add one directly in Google Calendar. adoptUntrackedEvents patches
// personId onto a manually-added event it can confidently text-match to
// exactly one family member, and writes a local extraction_log row for it,
// so every downstream feature (B3 conflict detection, person-scoped
// queries, the kid dashboard, the daily briefing) treats it identically to
// a bot-created event from then on.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import * as extractionLogRepo from '../../src/repositories/extractionLog.js';
import { adoptUntrackedEvents } from '../../src/pipeline/eventAdoption.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

function recordingUpdateEvent() {
  const patches = [];
  const updateEvent = async (id, patch) => {
    patches.push({ id, patch });
    return { provider: 'google', external_id: id };
  };
  return { patches, updateEvent };
}

test('adopts a manually-added event confidently text-matched to exactly one member: patches personId and writes a local record', async () => {
  const { family } = await seedFamily(pool);
  const mia = await familyMembersRepo.create({ familyId: family.id, name: 'Mia', calendarColor: '#111', kidIcon: '🦋', isParent: false }, pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#222', kidIcon: '🐢', isParent: false }, pool);
  const { patches, updateEvent } = recordingUpdateEvent();

  const items = [{ id: 'g1', summary: 'Dentist for Mia', start: { dateTime: '2026-09-08T16:00:00' }, end: { dateTime: '2026-09-08T17:00:00' }, extendedProperties: { private: {} } }];
  await adoptUntrackedEvents(items, { familyId: family.id, familyMembers: [mia, theo], updateEvent, pool });

  assert.equal(patches.length, 1);
  assert.equal(patches[0].id, 'g1');
  assert.equal(patches[0].patch.extendedProperties.private.personId, mia.id);
  assert.equal(items[0].extendedProperties.private.personId, mia.id, "this same batch's item is updated in place too");

  const log = await extractionLogRepo.findByCalendarEventId({ familyId: family.id, externalId: 'g1' }, pool);
  assert.ok(log, 'a local extraction_log row was written');
  assert.equal(log.state, 'written');
  assert.equal(log.sender_identifier, null, 'no real sender — this was never an incoming message');
  assert.equal(log.ai_candidate.person, 'Mia');
  assert.equal(log.ai_candidate.adopted, true);
});

test('does not adopt when zero or more than one member matches — never guesses', async () => {
  const { family } = await seedFamily(pool);
  const mia = await familyMembersRepo.create({ familyId: family.id, name: 'Mia', calendarColor: '#111', kidIcon: '🦋', isParent: false }, pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#222', kidIcon: '🐢', isParent: false }, pool);
  const { patches, updateEvent } = recordingUpdateEvent();

  const items = [
    { id: 'no-match', summary: 'Family dinner', extendedProperties: { private: {} } },
    { id: 'ambiguous', summary: "Mia and Theo's joint appointment", extendedProperties: { private: {} } },
  ];
  await adoptUntrackedEvents(items, { familyId: family.id, familyMembers: [mia, theo], updateEvent, pool });

  assert.equal(patches.length, 0);
  assert.equal(await extractionLogRepo.findByCalendarEventId({ familyId: family.id, externalId: 'no-match' }, pool), null);
  assert.equal(await extractionLogRepo.findByCalendarEventId({ familyId: family.id, externalId: 'ambiguous' }, pool), null);
});

test('skips an event that already has a personId — never re-adopts a bot-created (or already-adopted) event', async () => {
  const { family } = await seedFamily(pool);
  const mia = await familyMembersRepo.create({ familyId: family.id, name: 'Mia', calendarColor: '#111', kidIcon: '🦋', isParent: false }, pool);
  const { patches, updateEvent } = recordingUpdateEvent();

  const items = [{ id: 'g2', summary: 'Dentist for Mia', extendedProperties: { private: { personId: mia.id } } }];
  await adoptUntrackedEvents(items, { familyId: family.id, familyMembers: [mia], updateEvent, pool });

  assert.equal(patches.length, 0);
});

test('is idempotent: a second read of the same event does not re-patch or re-log it', async () => {
  const { family } = await seedFamily(pool);
  const mia = await familyMembersRepo.create({ familyId: family.id, name: 'Mia', calendarColor: '#111', kidIcon: '🦋', isParent: false }, pool);
  const { patches, updateEvent } = recordingUpdateEvent();

  await adoptUntrackedEvents(
    [{ id: 'g3', summary: 'Dentist for Mia', extendedProperties: { private: {} } }],
    { familyId: family.id, familyMembers: [mia], updateEvent, pool }
  );
  assert.equal(patches.length, 1);

  // A fresh read of the SAME real event, before the (real) Calendar patch
  // would have taken effect on a re-fetch — the local extraction_log
  // record is what actually prevents a second adoption attempt.
  await adoptUntrackedEvents(
    [{ id: 'g3', summary: 'Dentist for Mia', extendedProperties: { private: {} } }],
    { familyId: family.id, familyMembers: [mia], updateEvent, pool }
  );
  assert.equal(patches.length, 1, 'no second patch attempted');
});

test('a manually-added event is adopted during a person-scoped A1 query and then found by it', async () => {
  const { family, parent, knownSender } = await seedFamily(pool);
  const mia = await familyMembersRepo.create({ familyId: family.id, name: 'Mia', calendarColor: '#111', kidIcon: '🦋', isParent: false }, pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  // Simulate a manually-added Google Calendar event by writing straight
  // into the fake's storage, bypassing the bot's own createEvent — no
  // personId, exactly like a real event someone added directly in Calendar.
  calendar.events.set('manual-1', { title: 'Dentist for Mia', startDateTime: '2026-09-09T10:00:00', endDateTime: '2026-09-09T11:00:00' });

  const llm = createFakeLlm({
    "What does Mia have Wednesday?": { type: 'query', date_from: '2026-09-09', date_to: '2026-09-09', person: 'Mia' },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'What does Mia have Wednesday?', externalMessageId: 'wamid.adopt1' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent, mia] }
  );

  assert.equal(result.outcome, 'query');
  assert.match(messenger.sent[0].text, /Dentist for Mia/);
  assert.equal(calendar.events.get('manual-1').personId, mia.id, 'the manually-added event was adopted (personId patched) during the query');
});

test('a real double-booking against a manually-added event is now flagged (the actual gap this feature closes)', async () => {
  const { family, parent, knownSender } = await seedFamily(pool);
  const mia = await familyMembersRepo.create({ familyId: family.id, name: 'Mia', calendarColor: '#111', kidIcon: '🦋', isParent: false }, pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  // A manually-added, untracked event already on the calendar.
  calendar.events.set('manual-2', { title: 'Art class for Mia', startDateTime: '2026-09-08T16:00:00', endDateTime: '2026-09-08T17:00:00' });

  const llm = createFakeLlm({
    'Piano for Mia Tuesday 4:30pm': {
      title: 'Piano', date: '2026-09-08', time: '16:30', end_time: null, person: 'Mia', category: 'activity',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🎹',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Piano for Mia Tuesday 4:30pm', externalMessageId: 'wamid.adopt2' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent, mia] }
  );

  assert.equal(result.outcome, 'written');
  assert.match(result.reply, /note: Mia already has Art class for Mia at 16:00/);
});
