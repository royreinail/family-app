// Regression test for a real production bug found in live testing.
//
// The bot can ask a follow-up ("Got it — <title> on <date>. What time?")
// when a message has a date but no time. The user's reply was being parsed
// as a brand-new message instead of merged into the parked event, so a
// bare "8:30" answer lost everything the first turn had already resolved:
//
//   Roy: יום שני הקרוב טיפול באומנות לגאיה   ("art therapy for Gaia this coming Monday")
//   Bot: Got it — טיפול באומנות on 2026-08-31. What time?
//   Roy: 8:30
//   Bot: <UNKNOWN>, 2026-08-27 08:30 — added ✅   ← title gone, date reset to today, person dropped
//
// Fix: a bare-time reply while a `needs_time` event is parked for that
// sender is merged into the stored candidate (title + already-resolved
// relative date + person all kept) and promoted to the calendar, with no
// second LLM call. See pipeline.js step 3b / promotePendingEventWithTime.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import * as extractionLogRepo from '../../src/repositories/extractionLog.js';
import * as tasksRepo from '../../src/repositories/tasks.js';
import { hexToColorId } from '../../src/integrations/googleColors.js';
import { isBareTimeAnswer, parseCorrectedTimeRange } from '../../src/pipeline/commands.js';
import { resolveNamedWeekdayDate, todayInTimeZone } from '../../src/pipeline/classify.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

const HEBREW_FIRST_TURN = 'יום שני הקרוב טיפול באומנות לגאיה';

// classify.js's overrideNamedWeekday deterministically recomputes "יום שני"
// (Monday) against the real current date (live bug report — the same
// weekday this test's own comment names as the one the LLM DID resolve
// correctly, in the report's own live reproduction), so the expected date
// has to be computed the same way here, not hardcoded to whatever date
// happened to be "next Monday" when this test was originally written.
const NEXT_MONDAY = resolveNamedWeekdayDate(todayInTimeZone('Asia/Jerusalem'), 1);

// What the LLM returns for that first turn: title + person resolved, the
// relative date ("this coming Monday") already turned into a concrete
// date, and no time — the exact shape that triggers the "What time?" ask.
function firstTurnExtraction() {
  return {
    title: 'טיפול באומנות',
    date: NEXT_MONDAY,
    time: null,
    person: 'גאיה',
    category: 'activity',
    reminder_requested: false,
    reminder_datetime: null,
  };
}

async function seedFamilyWithGaia() {
  const seeded = await seedFamily(pool);
  const gaia = await familyMembersRepo.create(
    { familyId: seeded.family.id, name: 'גאיה', calendarColor: '#d60000', kidIcon: '🦊', isParent: false },
    pool
  );
  const familyMembers = await familyMembersRepo.findAllForFamily(seeded.family.id, pool);
  return { ...seeded, gaia, familyMembers };
}

test('a bare "8:30" reply to "What time?" is merged into the parked event, not re-parsed from scratch', async () => {
  const { family, knownSender, gaia, familyMembers } = await seedFamilyWithGaia();
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({ [HEBREW_FIRST_TURN]: firstTurnExtraction() });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: HEBREW_FIRST_TURN, externalMessageId: 'wamid.followup-1a' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );
  assert.equal(first.outcome, 'needs_time');
  assert.match(messenger.sent.at(-1).text, /what time/i);

  // The answer — no quote/reply context, just "8:30" as its own message.
  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: '8:30', externalMessageId: 'wamid.followup-1b' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );

  assert.equal(second.outcome, 'written');
  assert.equal(second.destination, 'calendar');
  assert.equal(llm.calls.length, 1, 'the "8:30" answer must not trigger a second LLM call');

  assert.equal(calendar.events.size, 1);
  const written = [...calendar.events.values()][0];
  assert.equal(written.title, 'טיפול באומנות', 'original title kept, not lost to <UNKNOWN>');
  assert.equal(written.startDateTime, `${NEXT_MONDAY}T08:30:00`, 'already-resolved date kept, time filled in');
  assert.equal(written.endDateTime, `${NEXT_MONDAY}T09:30:00`);
  assert.equal(written.colorId, hexToColorId('#d60000'), "kept the person, so the event carries גאיה's colour");

  // The confirmation the user actually sees.
  assert.match(messenger.sent.at(-1).text, /טיפול באומנות/);
  assert.match(messenger.sent.at(-1).text, new RegExp(`${NEXT_MONDAY} 08:30`));
  assert.doesNotMatch(messenger.sent.at(-1).text, /UNKNOWN|2026-08-27/);
});

test('promoting the parked event retires its tentative task and repoints the log for undo', async () => {
  const { family, knownSender, familyMembers } = await seedFamilyWithGaia();
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({ [HEBREW_FIRST_TURN]: firstTurnExtraction() });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: HEBREW_FIRST_TURN, externalMessageId: 'wamid.followup-2a' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );
  assert.equal((await tasksRepo.findAllForFamily(family.id, pool)).length, 1, 'date-only branch parks a tentative task');

  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'at 8:30am', externalMessageId: 'wamid.followup-2b' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );
  assert.equal(second.outcome, 'written');

  assert.equal((await tasksRepo.findAllForFamily(family.id, pool)).length, 0, 'tentative task retired once it became a real event');

  const promotedLog = await extractionLogRepo.findById(first.log.id, pool);
  assert.equal(promotedLog.state, 'written');
  assert.equal(promotedLog.ai_candidate.time, '08:30', 'merged time persisted on the original log');
  assert.equal(promotedLog.ai_candidate.title, 'טיפול באומנות');
  assert.equal(promotedLog.resulting_event_ref.provider, 'google', 'log now points at the calendar event, so "undo" removes it');

  // The bare-time message itself is consumed, not left dangling.
  const answerLog = await extractionLogRepo.findById(second.log.id, pool);
  assert.equal(answerLog.state, 'stopped');
});

test('a quote-reply of a time to "What time?" promotes the same way (correction path)', async () => {
  const { family, knownSender, familyMembers } = await seedFamilyWithGaia();
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({ [HEBREW_FIRST_TURN]: firstTurnExtraction() });

  const first = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: HEBREW_FIRST_TURN, externalMessageId: 'wamid.followup-3a' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );

  const second = await handleIncomingMessage(
    {
      familyId: family.id,
      senderIdentifier: knownSender,
      text: '8:30',
      externalMessageId: 'wamid.followup-3b',
      replyToExtractionLogId: first.log.id,
    },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );

  assert.equal(second.outcome, 'written');
  assert.equal(second.destination, 'calendar');
  assert.equal(llm.calls.length, 1);
  const written = [...calendar.events.values()][0];
  assert.equal(written.title, 'טיפול באומנות');
  assert.equal(written.startDateTime, `${NEXT_MONDAY}T08:30:00`);
});

test('a fresh request that merely contains a time is NOT swallowed as a follow-up answer', async () => {
  const { family, knownSender, familyMembers } = await seedFamilyWithGaia();
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    [HEBREW_FIRST_TURN]: firstTurnExtraction(),
    'Dentist for גאיה next Tuesday 9am': {
      title: 'Dentist', date: '2026-09-01', time: '09:00', person: 'גאיה', category: 'appointment',
      reminder_requested: false, reminder_datetime: null,
    },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: HEBREW_FIRST_TURN, externalMessageId: 'wamid.followup-4a' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );

  // A pending needs_time exists, but this is plainly its own new event.
  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dentist for גאיה next Tuesday 9am', externalMessageId: 'wamid.followup-4b' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );

  assert.equal(second.outcome, 'written');
  assert.equal(llm.calls.length, 2, 'the new request still goes through normal extraction');
  const titles = [...calendar.events.values()].map((e) => e.title);
  assert.deepEqual(titles, ['Dentist']);

  // The original art-therapy follow-up is still open, waiting for its time.
  const stillPending = await extractionLogRepo.findRecentPendingFollowUp(
    { familyId: family.id, senderIdentifier: knownSender },
    pool
  );
  assert.ok(stillPending, 'the unrelated new event did not clear the parked follow-up');
  assert.equal(stillPending.ai_candidate.title, 'טיפול באומנות');
});

test('isBareTimeAnswer: strict about what counts as just-a-time', () => {
  for (const yes of ['8:30', ' 8:30 ', '08:30', 'at 8:30', '8:30am', '8:30 AM', '8:30 בבוקר', 'at 8:30 in the morning', '17:00']) {
    assert.equal(isBareTimeAnswer(yes), true, `${JSON.stringify(yes)} should count as a bare time answer`);
  }
  for (const no of ['', 'thanks!', 'Dentist tomorrow 9am', 'move it to Friday', 'gymnastics at 8:30', 'tomorrow 9am']) {
    assert.equal(isBareTimeAnswer(no), false, `${JSON.stringify(no)} should NOT count as a bare time answer`);
  }
});

// Real bug from live testing: a range answer to "What time?" ("8:30-18:00")
// kept only the start time — the same duration-loss item 1 fixed for the
// *initial* message, never carried over to this merge path. isBareTimeAnswer
// must still recognize a range (not fall through to normal extraction).
test('parseCorrectedTimeRange: a range answer keeps both the start and the end', () => {
  for (const rangeText of ['8:30-18:00', '8:30 to 18:00', '8:30-6pm', 'from 8:30 until 18:00']) {
    assert.equal(isBareTimeAnswer(rangeText), true, `${JSON.stringify(rangeText)} should still count as a bare time answer`);
    const { time, endTime } = parseCorrectedTimeRange(rangeText);
    assert.equal(time, '08:30', `${JSON.stringify(rangeText)}`);
    assert.equal(endTime, '18:00', `${JSON.stringify(rangeText)}`);
  }
  // A single time still yields no end time, exactly as before.
  assert.deepEqual(parseCorrectedTimeRange('8:30'), { time: '08:30', endTime: null });
});

test('a range reply to "What time?" ("8:30-18:00") keeps the real duration, not a default 1-hour block', async () => {
  const { family, knownSender, gaia, familyMembers } = await seedFamilyWithGaia();
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({ [HEBREW_FIRST_TURN]: firstTurnExtraction() });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: HEBREW_FIRST_TURN, externalMessageId: 'wamid.followup-5a' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );

  const second = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: '8:30-18:00', externalMessageId: 'wamid.followup-5b' },
    { pool, llmExtract: llm.extract, calendar, messenger, timeZone: 'Asia/Jerusalem', familyMembers }
  );

  assert.equal(second.outcome, 'written');
  const written = [...calendar.events.values()][0];
  assert.equal(written.startDateTime, `${NEXT_MONDAY}T08:30:00`);
  assert.equal(written.endDateTime, `${NEXT_MONDAY}T18:00:00`, 'the given end time, not a default 1-hour block');
  assert.match(messenger.sent.at(-1).text, /08:30–18:00/, 'confirmation echoes the real range back');
});
