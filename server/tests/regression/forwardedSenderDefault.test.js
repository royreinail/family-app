// Regression coverage for bug list item 6: a forwarded WhatsApp message
// often doesn't say who an event is for (it wasn't written to the bot
// directly). Fix: default the person to whoever forwarded it, but only
// when Meta itself flags the message as forwarded (message.context.forwarded)
// and no real family member is already named -- state the assumption
// explicitly in the reply, and let a follow-up (bare or quoted) correct it,
// patching the Calendar event's color to match (item 4).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import * as extractionLogRepo from '../../src/repositories/extractionLog.js';
import { hexToColorId } from '../../src/integrations/googleColors.js';
import {
  matchSingleFamilyMember,
  applyForwardedSenderDefault,
  matchBarePersonCorrection,
  confirmReply,
  qualifyReply,
} from '../../src/pipeline/classify.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

// ---- pure unit tests ------------------------------------------------------

test('matchSingleFamilyMember matches exactly one confident name, not zero or several', () => {
  const members = [{ name: 'Mia' }, { name: 'Theo' }];
  assert.equal(matchSingleFamilyMember('Mia', members)?.name, 'Mia');
  assert.equal(matchSingleFamilyMember('someone else', members), null);
  assert.equal(matchSingleFamilyMember('Mia and Theo', members), null);
  assert.equal(matchSingleFamilyMember(null, members), null);
});

test('applyForwardedSenderDefault only kicks in for a forwarded message with no real person already matched', () => {
  const dana = { name: 'Dana' };
  const members = [dana, { name: 'Theo' }];

  // Not forwarded at all -- never touched, even with no person.
  assert.deepEqual(
    applyForwardedSenderDefault({ person: null }, { wasForwarded: false, senderFamilyMember: dana, familyMembers: members }),
    { person: null }
  );

  // Forwarded, but no sender mapping known -- nothing to default to.
  assert.deepEqual(
    applyForwardedSenderDefault({ person: null }, { wasForwarded: true, senderFamilyMember: null, familyMembers: members }),
    { person: null }
  );

  // Forwarded, no sender mapping, person already names someone real -- untouched.
  const stated = applyForwardedSenderDefault({ person: 'Theo' }, { wasForwarded: true, senderFamilyMember: dana, familyMembers: members });
  assert.equal(stated.person, 'Theo');
  assert.equal(stated.personAssumed, undefined);

  // The actual default case.
  const assumed = applyForwardedSenderDefault({ person: null }, { wasForwarded: true, senderFamilyMember: dana, familyMembers: members });
  assert.equal(assumed.person, 'Dana');
  assert.equal(assumed.personAssumed, true);
});

test('matchBarePersonCorrection is strict about what counts as just a name', () => {
  const members = [{ name: 'Theo' }, { name: 'Mia' }];
  for (const yes of ['Theo', ' Theo ', 'for Theo', 'actually Theo', "it's Theo", 'change it to Theo', 'assign it to Theo', 'make it Theo', 'switch to Theo']) {
    assert.equal(matchBarePersonCorrection(yes, members)?.name, 'Theo', `${JSON.stringify(yes)} should match Theo`);
  }
  for (const no of ['', 'thanks!', 'Dance class for Mia Friday 4pm', 'not sure', 'Theo and Mia']) {
    assert.equal(matchBarePersonCorrection(no, members), null, `${JSON.stringify(no)} should not match`);
  }
});

// Item 9's real bug: Hebrew commonly attaches a one-letter preposition
// directly to a name with no space ("לגאיה" = ל + גאיה, "to Gaia", one
// token) — the name-match strips גאיה but used to leave a single leftover
// letter that failed the "must reduce to exactly empty" check, silently
// breaking a completely natural Hebrew correction reply.
test('matchBarePersonCorrection handles a Hebrew preposition attached directly to the name with no space', () => {
  const members = [{ name: 'גאיה' }, { name: 'תיאו' }];
  for (const yes of ['גאיה', 'לגאיה', 'בגאיה', 'לתיאו', 'זה בשביל גאיה', 'לא, זה בשביל תיאו']) {
    assert.equal(matchBarePersonCorrection(yes, members)?.name, yes.includes('תיאו') ? 'תיאו' : 'גאיה', `${JSON.stringify(yes)} should match`);
  }
  // Only a *single* leftover prefix letter is forgiven — a longer leftover
  // (two compounded prefix letters here) still correctly fails, so this
  // stays a narrow grammar allowance, not a loophole for arbitrary prefix text.
  assert.equal(matchBarePersonCorrection('שלגאיה', members), null);
});

// Real, repeated bug report: the confirmation kept leaving out who an
// event was for even when `person` was confidently resolved — the
// original version of this only stated it for the *assumed* (forwarded-
// sender-default) case. Now it's stated whenever a person is known at
// all; only the "(assumed...)" qualifier is exclusive to the assumed case.
test('confirmReply/qualifyReply always state who the event is for when known; the "(assumed...)" qualifier is exclusive to the forwarded-default case', () => {
  const assumed = { title: 'Birthday party', date: '2026-08-31', time: '16:00', person: 'Dana', personAssumed: true };
  assert.match(confirmReply(assumed), /for Dana \(assumed/);
  const stated = { title: 'Birthday party', date: '2026-08-31', time: '16:00', person: 'Dana' };
  assert.doesNotMatch(confirmReply(stated), /assumed/);
  assert.match(confirmReply(stated), /for Dana/, 'a confidently-resolved person must be stated too, not just an assumed one');
  const noPerson = { title: 'Family dinner', date: '2026-08-31', time: '18:00' };
  assert.doesNotMatch(confirmReply(noPerson), /for /, 'nothing to state when no person was resolved at all');

  const assumedPending = { title: 'Art class', date: '2026-08-31', person: 'Dana', personAssumed: true };
  assert.match(qualifyReply(assumedPending), /for Dana \(assumed/);
  const statedPending = { title: 'Art class', date: '2026-08-31', person: 'Dana' };
  assert.match(qualifyReply(statedPending), /for Dana/);
  assert.doesNotMatch(qualifyReply(statedPending), /assumed/);
});

// ---- full pipeline integration --------------------------------------------

test('a forwarded message with no named person defaults to the forwarder, stated in the reply', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Birthday party Sunday 4pm': {
      title: 'Birthday party', date: '2026-08-30', time: '16:00', person: null, category: 'birthday',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Birthday party Sunday 4pm', externalMessageId: 'wamid.fwd-1', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent], senderFamilyMember: parent }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  const written = calendar.events.get(eventId);
  assert.equal(written.colorId, hexToColorId(parent.calendar_color), "event is colored for the forwarder (Dana)");
  assert.match(result.reply, /for Dana \(assumed, since you forwarded this/);
});

test('a NON-forwarded message with no named person is unaffected (default color, no assumption stated)', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Family dinner Sunday 6pm': {
      title: 'Family dinner', date: '2026-08-30', time: '18:00', person: null, category: null,
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Family dinner Sunday 6pm', externalMessageId: 'wamid.fwd-2', wasForwarded: false },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [parent], senderFamilyMember: parent }
  );

  assert.equal(result.outcome, 'written');
  assert.doesNotMatch(result.reply, /Dana|assumed/);
});

test('a forwarded message that already names a real family member is not overridden', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);
  const familyMembers = [parent, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Soccer practice for Theo Friday 5pm': {
      title: 'Soccer practice', date: '2026-08-28', time: '17:00', person: 'Theo', category: 'sports',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Soccer practice for Theo Friday 5pm', externalMessageId: 'wamid.fwd-3', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  assert.equal(result.outcome, 'written');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).colorId, hexToColorId(theo.calendar_color), "kept the stated person, not the forwarder");
  assert.doesNotMatch(result.reply, /assumed/);
});

test('a bare follow-up naming a different member corrects the assumed person and the event color', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);
  const familyMembers = [parent, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Birthday party Sunday 4pm': {
      title: 'Birthday party', date: '2026-08-30', time: '16:00', person: null, category: 'birthday',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Birthday party Sunday 4pm', externalMessageId: 'wamid.fwd-4a', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );
  assert.equal([...calendar.events.values()][0].colorId, hexToColorId(parent.calendar_color));

  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'actually Theo', externalMessageId: 'wamid.fwd-4b' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  assert.equal(second.outcome, 'corrected');
  assert.equal(llm.calls.length, 1, 'the bare correction must not trigger a second LLM call');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).colorId, hexToColorId(theo.calendar_color));
  assert.match(second.reply, /now for Theo/);

  const promotedLog = await extractionLogRepo.findById(first.log.id, pool);
  assert.equal(promotedLog.ai_candidate.person, 'Theo');
  assert.equal(promotedLog.ai_candidate.personAssumed, false);
});

test('a quoted reply naming a different member corrects the same way', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);
  const familyMembers = [parent, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Birthday party Sunday 4pm': {
      title: 'Birthday party', date: '2026-08-30', time: '16:00', person: null, category: 'birthday',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Birthday party Sunday 4pm', externalMessageId: 'wamid.fwd-5a', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Theo', externalMessageId: 'wamid.fwd-5b', replyToExtractionLogId: first.log.id },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  assert.equal(second.outcome, 'corrected');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).colorId, hexToColorId(theo.calendar_color));
});

// Item 9: "editing the assignee of an existing event via reply doesn't
// work... regardless of whether the reply quotes the original message."
// Root cause for the quoted path specifically: it reused the same
// 10-minute window built for the *bare* (unquoted) path, where a window
// genuinely guards against ambiguity — but quoting a specific message is
// already an unambiguous reference to that exact event, no matter how long
// ago it was written. An "existing event" a user wants to correct is very
// plausibly well past 10 minutes old.
test('a quoted reply corrects the person no matter how long ago the event was written', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);
  const familyMembers = [parent, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Birthday party Sunday 4pm': {
      title: 'Birthday party', date: '2026-08-30', time: '16:00', person: null, category: 'birthday',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Birthday party Sunday 4pm', externalMessageId: 'wamid.fwd-9a', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  // Simulate the event having been written a full day ago -- far past the
  // 10-minute window that (correctly) still bounds the bare/unquoted path.
  await pool.query(`update extraction_log set updated_at = now() - interval '1 day' where id = $1`, [first.log.id]);

  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Theo', externalMessageId: 'wamid.fwd-9b', replyToExtractionLogId: first.log.id },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  assert.equal(second.outcome, 'corrected', 'a quoted reply is an unambiguous reference regardless of age');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).colorId, hexToColorId(theo.calendar_color));
  assert.equal(calendar.events.get(eventId).personId, theo.id);
});

// Item 9's other half: this fallback used to send a confident "Updated —
// {title} now at {time}" even when nothing about the reply was actually
// understood (no time, no matching person) -- silently claiming success on
// a correction attempt that changed nothing at all.
test('a quoted reply that matches neither a time nor a real family member gets an honest failure reply, not a fake "Updated"', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Birthday party Sunday 4pm': {
      title: 'Birthday party', date: '2026-08-30', time: '16:00', person: null, category: 'birthday',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Birthday party Sunday 4pm', externalMessageId: 'wamid.fwd-9c' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [] }
  );

  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'make it bigger', externalMessageId: 'wamid.fwd-9d', replyToExtractionLogId: first.log.id },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers: [] }
  );

  assert.equal(second.outcome, 'correction_failed');
  assert.doesNotMatch(second.reply, /Updated/i, 'must not claim a change was made when nothing was understood');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).startDateTime, '2026-08-30T16:00:00', 'the original event must be untouched');
});

test('a bare person-name message outside the correction window is NOT applied', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);
  const familyMembers = [parent, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Birthday party Sunday 4pm': {
      title: 'Birthday party', date: '2026-08-30', time: '16:00', person: null, category: 'birthday',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Birthday party Sunday 4pm', externalMessageId: 'wamid.fwd-6a', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  // Simulate the confirmation having happened 20 minutes ago -- well past
  // the 10-minute correction window.
  await pool.query(`update extraction_log set updated_at = now() - interval '20 minutes' where id = $1`, [first.log.id]);

  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'actually Theo', externalMessageId: 'wamid.fwd-6b' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  // Falls through to normal extraction, which the fake LLM has no
  // registered response for -- proves the correction path did NOT fire
  // (it would have returned 'corrected' without ever calling the LLM).
  assert.equal(second.outcome, 'failed');
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).colorId, hexToColorId(parent.calendar_color), 'color must be unchanged');
});

test('a genuinely new request that happens to name a family member is NOT swallowed as a correction', async () => {
  const { family, knownSender, parent } = await seedFamily(pool);
  const theo = await familyMembersRepo.create({ familyId: family.id, name: 'Theo', calendarColor: '#e6ab84', kidIcon: '🚀' }, pool);
  const familyMembers = [parent, theo];
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Birthday party Sunday 4pm': {
      title: 'Birthday party', date: '2026-08-30', time: '16:00', person: null, category: 'birthday',
      reminder_requested: false, reminder_datetime: null,
    },
    'Dance class for Mia Friday 4pm': {
      title: 'Dance class', date: '2026-08-28', time: '16:00', person: null, category: 'dance',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Birthday party Sunday 4pm', externalMessageId: 'wamid.fwd-7a', wasForwarded: true },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class for Mia Friday 4pm', externalMessageId: 'wamid.fwd-7b' },
    { pool, llmExtract: llm.extract, calendar, messenger, familyMembers, senderFamilyMember: parent }
  );

  assert.equal(second.outcome, 'written');
  assert.equal(llm.calls.length, 2, 'the new request goes through normal extraction, not the correction path');
  assert.equal(calendar.events.size, 2);
});
