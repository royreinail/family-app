// F1 — swipe-reply as an explicit context signal (enhancement backlog,
// claude-code-enhancements_1.md). WhatsApp's native swipe-to-reply carries
// a quoted reference (message.context.id); webhook.js already resolves that
// to `replyToExtractionLogId` and routes to handleCorrection with NO LLM
// call. This adds the two actions that path was missing — the quote
// identifies WHICH event with certainty, so "cancel this" / "move it to
// Friday" as a swipe-reply act directly on that event, no A2-style
// description matching or disambiguation needed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as extractionLogRepo from '../../src/repositories/extractionLog.js';
import * as tasksRepo from '../../src/repositories/tasks.js';
import { isCancelIntent } from '../../src/pipeline/commands.js';
import { resolveReplyDate, resolveNamedWeekdayDate, todayInTimeZone } from '../../src/pipeline/classify.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('isCancelIntent: strict — whole message must reduce to a cancel/delete instruction, English or Hebrew', () => {
  for (const yes of ['cancel', 'cancel this', 'delete it', 'remove this event', 'never mind, cancel that', 'בטל', 'בטלי את זה', 'תמחק את האירוע']) {
    assert.equal(isCancelIntent(yes), true, `${JSON.stringify(yes)} should read as a cancel`);
  }
  for (const no of ['cancel dance class Thursday', 'can we delete the milk from the shopping list', 'move it to 5pm', 'actually for Theo', '', 'delete the 3rd item and add two more']) {
    assert.equal(isCancelIntent(no), false, `${JSON.stringify(no)} must NOT read as a bare cancel`);
  }
});

test('resolveReplyDate: today/tomorrow/tonight and a named weekday, else null', () => {
  const ref = '2026-09-04'; // a Friday
  assert.equal(resolveReplyDate('make it tomorrow', ref), '2026-09-05');
  assert.equal(resolveReplyDate('do it today instead', ref), ref);
  assert.equal(resolveReplyDate('tonight works better', ref), ref);
  assert.equal(resolveReplyDate('move it to Tuesday', ref), '2026-09-08');
  assert.equal(resolveReplyDate('תעביר לשלישי', ref), '2026-09-08');
  assert.equal(resolveReplyDate('make it 6pm', ref), null, 'a time-only change names no new day');
});

async function seedWrittenEvent(pool, { text = 'Dance class at 4pm', title = 'Dance class', date = '2026-09-08', time = '16:00', end_time = null } = {}) {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    [text]: {
      title, date, time, end_time, person: null, category: 'activity',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '💃',
    },
  });
  const written = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text, externalMessageId: 'wamid.f1-seed' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  return { family, knownSender, calendar, messenger, llm, written };
}

test('swipe-reply "cancel this" deletes the quoted event and retires its log — no LLM call', async () => {
  const { family, knownSender, calendar, messenger, llm, written } = await seedWrittenEvent(pool);
  assert.equal(calendar.events.size, 1);
  const callsBefore = llm.calls.length;

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'cancel this', externalMessageId: 'wamid.f1-cancel', replyToExtractionLogId: written.log.id },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'cancelled');
  assert.equal(llm.calls.length, callsBefore, 'the quote identifies the event — no extraction call needed');
  assert.equal(calendar.events.size, 0, 'the real Calendar event is deleted');
  assert.match(result.reply, /Cancelled — Dance class ✅/);
  const originalLog = await extractionLogRepo.findById(written.log.id, pool);
  assert.equal(originalLog.state, 'undone');
});

test('swipe-reply "בטל" (Hebrew) cancels the quoted event the same way', async () => {
  const { family, knownSender, calendar, messenger, llm, written } = await seedWrittenEvent(pool);
  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'בטל את זה', externalMessageId: 'wamid.f1-cancel-he', replyToExtractionLogId: written.log.id },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(result.outcome, 'cancelled');
  assert.equal(calendar.events.size, 0);
});

test('swipe-reply "move it to Friday" reschedules the quoted event to that day, keeping its time', async () => {
  const friday = resolveNamedWeekdayDate(todayInTimeZone('UTC'), 5);
  const { family, knownSender, calendar, messenger, llm, written } = await seedWrittenEvent(pool);
  const eventId = written.eventRef.external_id;
  assert.equal(calendar.events.get(eventId).startDateTime, '2026-09-08T16:00:00');

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'move it to Friday', externalMessageId: 'wamid.f1-resched', replyToExtractionLogId: written.log.id },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'corrected');
  assert.equal(calendar.events.get(eventId).startDateTime, `${friday}T16:00:00`, 'new day, same time');
  assert.equal(calendar.events.get(eventId).endDateTime, `${friday}T17:00:00`);
  assert.match(result.reply, /Moved — Dance class to /);
});

test('swipe-reply "move it to tomorrow 6pm" changes both the day and the time in one reply', async () => {
  const { family, knownSender, calendar, messenger, llm, written } = await seedWrittenEvent(pool);
  const eventId = written.eventRef.external_id;
  const tomorrow = resolveReplyDate('tomorrow', todayInTimeZone('UTC'));

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'move it to tomorrow 6pm', externalMessageId: 'wamid.f1-resched2', replyToExtractionLogId: written.log.id },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'corrected');
  assert.equal(calendar.events.get(eventId).startDateTime, `${tomorrow}T18:00:00`);
});

test('swipe-reply "make it 6pm" (time only, no new day) still works via the existing time-correction path', async () => {
  const { family, knownSender, calendar, messenger, llm, written } = await seedWrittenEvent(pool);
  const eventId = written.eventRef.external_id;

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'make it 6pm', externalMessageId: 'wamid.f1-time', replyToExtractionLogId: written.log.id },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'corrected');
  assert.equal(calendar.events.get(eventId).startDateTime, '2026-09-08T18:00:00', 'same day, new time');
});

test('swipe-reply "cancel this" on a date-only task (needs_time) deletes the task, not a Calendar event', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'Bring $10 for the field trip': {
      title: 'Bring $10 for the field trip', date: '2026-09-11', time: null, person: null, category: 'todo',
      reminder_requested: false, reminder_datetime: null,
    },
  });
  const parked = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Bring $10 for the field trip', externalMessageId: 'wamid.f1-task-seed' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal((await tasksRepo.findAllForFamily(family.id, pool)).length, 1);

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'cancel this', externalMessageId: 'wamid.f1-task-cancel', replyToExtractionLogId: parked.log.id },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'cancelled');
  assert.equal((await tasksRepo.findAllForFamily(family.id, pool)).length, 0);
});
