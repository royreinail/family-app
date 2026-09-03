// Regression coverage for a real production bug: "the kids dashboard cards
// color doesn't match the assigned kid color." Root cause: the dashboard
// re-derived "who is this event for" at *read* time by scanning the
// event's title/description text for a family member's literal name
// (classify.js's matchMembersToEvent, moved here from dashboard.js when A1
// needed the same function from pipeline.js too) — completely independent of the
// actual match already made and colored at *write* time
// (classify.js's calendarPayloadFromCandidate / resolveEventColorId). Most
// real titles never contain the person's name at all ("Dance class" for
// Mia, "Dentist" for Theo, "Commanders Day" for Roy), so that heuristic
// silently found nothing and the card fell back to a neutral/gray color —
// even though the real Calendar event was correctly colored the entire
// time. Fixed by storing the same matched member's id on the event
// (extendedProperties.private.personId) at write time and reading that
// back directly, instead of re-guessing from text: one resolution, not two
// independent ones that can drift apart.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import { calendarPayloadFromCandidate, matchMembersToEvent } from '../../src/pipeline/classify.js';
import { GOOGLE_EVENT_COLORS } from '../../src/integrations/googleColors.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('calendarPayloadFromCandidate stores the matched family member\'s id, not just the color', () => {
  const mia = { id: 'member-mia', name: 'Mia', calendar_color: GOOGLE_EVENT_COLORS[0].hex };
  const payload = calendarPayloadFromCandidate(
    { title: 'Dance class', date: '2026-08-20', time: '16:00', person: 'Mia' },
    { familyMembers: [mia], timeZone: 'UTC' }
  );
  assert.equal(payload.personId, 'member-mia');
  assert.equal(payload.colorId, GOOGLE_EVENT_COLORS[0].colorId);
});

test('matchMembersToEvent: the bug itself — a title with no literal name still resolves the right member via the stored personId', () => {
  const mia = { id: 'member-mia', name: 'Mia' };
  const theo = { id: 'member-theo', name: 'Theo' };
  const members = [mia, theo];

  // Exactly the real-world shape: "Dance class" never contains "Mia".
  const event = { summary: 'Dance class', extendedProperties: { private: { personId: 'member-mia' } } };
  const matched = matchMembersToEvent(event, members);
  assert.deepEqual(matched.map((m) => m.id), ['member-mia'], 'must resolve Mia even though her name is nowhere in the title');
});

test('matchMembersToEvent: an event written before this existed (no personId) still falls back to the old text match', () => {
  const mia = { id: 'member-mia', name: 'Mia' };
  const members = [mia];
  const event = { summary: "Mia's dance class", extendedProperties: {} };
  const matched = matchMembersToEvent(event, members);
  assert.deepEqual(matched.map((m) => m.id), ['member-mia']);
});

test('matchMembersToEvent: neither a stored personId nor a text mention resolves to no one, not a wrong guess', () => {
  const members = [{ id: 'member-mia', name: 'Mia' }];
  assert.deepEqual(matchMembersToEvent({ summary: 'Dentist appointment', extendedProperties: {} }, members), []);
});

test('matchMembersToEvent: the stored personId and an additional name mentioned in the text combine (preserves multi-person striping)', () => {
  const mia = { id: 'member-mia', name: 'Mia' };
  const theo = { id: 'member-theo', name: 'Theo' };
  const members = [mia, theo];
  const event = { summary: 'Playdate with Theo', extendedProperties: { private: { personId: 'member-mia' } } };
  const matched = matchMembersToEvent(event, members);
  assert.deepEqual(new Set(matched.map((m) => m.id)), new Set(['member-mia', 'member-theo']));
});

test('a real write through the full pipeline threads personId through, even when the title never names the person', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const mia = await familyMembersRepo.create(
    { familyId: family.id, name: 'Mia', calendarColor: GOOGLE_EVENT_COLORS[3].hex, kidIcon: '🦄' },
    pool
  );
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    "Mia's dance class Thursday 4pm": {
      title: 'Dance class', date: '2026-08-20', time: '16:00', person: 'Mia', category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: "Mia's dance class Thursday 4pm", externalMessageId: 'wamid.card-color-1' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [mia] }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  const written = calendar.events.get(eventId);
  assert.equal(written.personId, mia.id, 'the title itself is just "Dance class" — nothing to text-match against');
  assert.equal(written.colorId, GOOGLE_EVENT_COLORS[3].colorId);
});

test('a person correction repoints personId too, not just the color — the dashboard must not keep showing the old person', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const theo = await familyMembersRepo.create(
    { familyId: family.id, name: 'Theo', calendarColor: GOOGLE_EVENT_COLORS[6].hex, kidIcon: '🚀' },
    pool
  );
  const familyMembers = [parent, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Birthday party Sunday 4pm': {
      title: 'Birthday party', date: '2026-08-30', time: '16:00', person: null, category: 'birthday',
      reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🎉',
    },
  });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Birthday party Sunday 4pm', externalMessageId: 'wamid.card-color-2a', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).personId, parent.id, 'defaults to the forwarder per item 6');

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'actually Theo', externalMessageId: 'wamid.card-color-2b' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  const corrected = calendar.events.get(eventId);
  assert.equal(corrected.personId, theo.id, 'personId must follow the correction, not stay pointed at the old person');
  assert.equal(corrected.colorId, GOOGLE_EVENT_COLORS[6].colorId);
  // The correction must not have silently wiped other metadata while patching personId.
  assert.equal(corrected.audience, 'family', 'audience must survive the correction, not revert/disappear');
  assert.equal(corrected.activityIcon, '🎉', 'activityIcon must survive the correction, not revert/disappear');
  assert.equal(first.outcome, 'written');
});
