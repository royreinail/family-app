// F2 — actionable reminders and briefings (enhancement backlog v2, Group
// F). A fired reminder can be replied to (tapped button or plain text) to
// mark it Done, Snooze it, or Reschedule the underlying calendar event.
// Scoped to REMINDERS specifically, not the daily briefing (D1) — the
// backlog's own button-constraints section is written entirely in terms of
// a single reminder record; a briefing lists several events at once, with
// no one thing for "Done" to mean.
//
// Roy's live template edit added exactly two quick-reply buttons — "Done"
// and "Snooze" — not the three the original doc sketched. Reschedule
// stays a real, supported action, just via a plain text reply
// ("reschedule to Friday"), never a tap-target, so the free-form and
// template paths render the identical two-button set.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import { sweepDueReminders } from '../../src/pipeline/reminders.js';
import * as tasksRepo from '../../src/repositories/tasks.js';
import * as extractionLogRepo from '../../src/repositories/extractionLog.js';
import { composeReminderMessage, REMINDER_BUTTONS, reminderBodyText } from '../../src/pipeline/reminderMessage.js';
import { buildInteractiveButtonsPayload, buildReminderTemplatePayload } from '../../src/integrations/messenger.js';
import { isDoneReply, isSnoozeReply, isRescheduleReply, parseSnoozeDuration } from '../../src/pipeline/commands.js';
import { todayInTimeZone, addDays, localDateTimeToUtcIso, resolveNamedWeekdayDate } from '../../src/pipeline/classify.js';
import { resolveButtonReply } from '../../src/routes/webhook.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('composeReminderMessage: wraps the title with the approved template\'s exact fixed copy and the Done/Snooze buttons', () => {
  const composed = composeReminderMessage({ title: 'Reminder: pick up the dry cleaning' });
  assert.equal(composed.innerText, 'Reminder: pick up the dry cleaning');
  assert.equal(composed.bodyText, '⏰ Reminder: pick up the dry cleaning — sent by your Family App assistant.');
  assert.deepEqual(composed.buttons, [{ id: 'reminder_done', title: 'Done' }, { id: 'reminder_snooze', title: 'Snooze' }]);
  assert.equal(reminderBodyText('X'), '⏰ X — sent by your Family App assistant.');
});

// The backlog's own explicit requirement: "Add a test asserting both
// renderers produce the same button set and labels for the same reminder
// record."
test('the free-form interactive path and the approved-template path render the identical button set and labels', () => {
  const composed = composeReminderMessage({ title: 'Reminder: call the dentist' });
  const interactivePayload = buildInteractiveButtonsPayload('15551234567', composed);
  const templatePayload = buildReminderTemplatePayload('15551234567', composed);

  const interactiveButtons = interactivePayload.interactive.action.buttons.map((b) => ({ id: b.reply.id, title: b.reply.title }));
  const templateButtons = templatePayload.template.components
    .filter((c) => c.type === 'button')
    .map((c, i) => ({ id: c.parameters[0].payload, title: REMINDER_BUTTONS[i].title })); // the template's own button LABELS are Meta-approved fixed text, not resent — same ids/order is what has to match

  assert.deepEqual(interactiveButtons, templateButtons);
  assert.equal(interactivePayload.interactive.action.buttons.length, 2, 'matches the live template\'s real two-button edit, not the doc\'s original three');
});

test('resolveButtonReply: both delivery shapes (free-form interactive and template quick-reply) resolve to the same {id, title}', () => {
  assert.deepEqual(
    resolveButtonReply({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'reminder_done', title: 'Done' } } }),
    { id: 'reminder_done', title: 'Done' }
  );
  assert.deepEqual(
    resolveButtonReply({ type: 'button', button: { payload: 'reminder_snooze', text: 'Snooze' } }),
    { id: 'reminder_snooze', title: 'Snooze' }
  );
  assert.equal(resolveButtonReply({ type: 'text', text: { body: 'done' } }), null);
  assert.equal(resolveButtonReply(undefined), null);
});

test('isDoneReply: strict bare-word matching (no target ever follows "done") — English and Hebrew', () => {
  for (const w of ['done', 'Done!', 'did it', 'בוצע', 'סיימתי']) assert.equal(isDoneReply(w), true, w);
  assert.equal(isDoneReply('I already did it this morning, thanks'), false, 'a real sentence must not match');
  assert.equal(isDoneReply(''), false);
});

test('isSnoozeReply / isRescheduleReply: match the bare trigger AND the trigger plus an inline target, English and Hebrew', () => {
  for (const w of ['snooze', 'later', 'דחה']) assert.equal(isSnoozeReply(w), true, w);
  for (const w of ['reschedule', 'move it', 'תזיז']) assert.equal(isRescheduleReply(w), true, w);
  // The real-world shape these exist for: a reply that names the action
  // AND its target in one message, no button involved.
  assert.equal(isSnoozeReply('snooze in an hour'), true);
  assert.equal(isSnoozeReply('snooze until tomorrow morning'), true);
  assert.equal(isRescheduleReply('reschedule to Saturday 10am'), true);
  assert.equal(isRescheduleReply('move it to Friday 5pm'), true);
  // Must NOT fire on the trigger word appearing mid-sentence in an
  // unrelated message — these are only ever checked against an
  // already-routed reminder reply, but staying anchored to the start
  // keeps that true rather than accidental.
  assert.equal(isSnoozeReply('the snooze button on my phone is broken'), false);
  assert.equal(isRescheduleReply('can we reschedule our call sometime'), false, 'not anchored at the very start');
  assert.equal(isSnoozeReply(''), false);
});

test('parseSnoozeDuration: a small fixed phrase table, arithmetic relative to the reply\'s own timestamp', () => {
  const now = '2026-09-10T10:00:00.000Z';
  assert.equal(parseSnoozeDuration('in an hour', now), '2026-09-10T11:00:00.000Z');
  assert.equal(parseSnoozeDuration('in 2 hours', now), '2026-09-10T12:00:00.000Z');
  assert.equal(parseSnoozeDuration('in 30 minutes', now), '2026-09-10T10:30:00.000Z');
  assert.equal(parseSnoozeDuration('next week', now), '2026-09-17T10:00:00.000Z');
  assert.equal(parseSnoozeDuration('whatever works', now), null, 'no recognizable duration');

  // "tomorrow morning" resolves off the REAL current day (todayInTimeZone
  // reads the live clock, not the `now` passed in) — compute the same way
  // rather than hardcoding a date, or this breaks the instant real time
  // advances past whatever day the test was written on (the exact
  // fragility class fixed repeatedly elsewhere in this suite).
  const expectedTomorrowMorning = localDateTimeToUtcIso(addDays(todayInTimeZone('Asia/Jerusalem'), 1), '09:00', 'Asia/Jerusalem');
  assert.equal(parseSnoozeDuration('tomorrow morning', now, 'Asia/Jerusalem'), expectedTomorrowMorning);
});

async function seedDueReminder(pool, { title = 'pick up the dry cleaning', tiedToEvent = false } = {}) {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  let sourceLog = null;
  if (tiedToEvent) {
    // fixture 7 shape: a real event plus a separately-requested reminder.
    sourceLog = await extractionLogRepo.create(
      { familyId: family.id, rawInput: 'Remind me to pack the gym bag, gym class Friday 9am', senderIdentifier: knownSender, externalMessageId: 'wamid.f2-src' },
      pool
    );
    const eventRef = await calendar.createEvent({ title: 'Gym class', startDateTime: '2026-09-11T09:00:00', endDateTime: '2026-09-11T10:00:00' });
    await extractionLogRepo.updateState(sourceLog.id, { state: 'written', resultingEventRef: eventRef, aiCandidate: { title: 'Gym class', date: '2026-09-11', time: '09:00' } }, pool);
  } else {
    sourceLog = await extractionLogRepo.create(
      { familyId: family.id, rawInput: `Remind me to ${title}`, senderIdentifier: knownSender, externalMessageId: 'wamid.f2-src2' },
      pool
    );
  }
  const task = await tasksRepo.create(
    {
      familyId: family.id, title: `Reminder: ${title}`, dueDate: '2026-09-05', reminderPolicy: 'requested',
      reminderDatetime: new Date(Date.now() - 60_000).toISOString(), sourceExtractionLogId: sourceLog.id, reminderSenderIdentifier: knownSender,
    },
    pool
  );
  const [sent] = await sweepDueReminders({ pool, messenger });
  const delivered = await tasksRepo.findById(task.id, pool);
  return { family, knownSender, calendar, messenger, task: delivered, sent };
}

test('tapping the "Done" button marks the reminder task done', async () => {
  const { family, knownSender, calendar, messenger, task } = await seedDueReminder(pool);
  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Done', externalMessageId: 'wamid.f2-1', replyToReminderTaskId: task.id, buttonReplyId: 'reminder_done' },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(result.outcome, 'reminder_action');
  assert.equal(result.action, 'done');
  assert.match(result.reply, /Marked done — pick up the dry cleaning ✅/);
  const after = await tasksRepo.findById(task.id, pool);
  assert.equal(after.status, 'done');
});

test('swipe-replying "done" as plain text (quoted, but not tapped) works exactly like the button', async () => {
  const { family, knownSender, calendar, messenger, task } = await seedDueReminder(pool);
  // Quoted (context.id already resolved to replyToReminderTaskId by
  // webhook.js) but typed instead of tapped -- buttonReplyId is null.
  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'done', externalMessageId: 'wamid.f2-2', replyToReminderTaskId: task.id, buttonReplyId: null },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(result.outcome, 'reminder_action');
  assert.equal(result.action, 'done');
  const after = await tasksRepo.findById(task.id, pool);
  assert.equal(after.status, 'done');
});

test('tapping "Snooze" with a duration already in the same reply reschedules the REMINDER only and re-arms it for the sweep', async () => {
  const { family, knownSender, calendar, messenger, task } = await seedDueReminder(pool);
  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'snooze in an hour', externalMessageId: 'wamid.f2-3', replyToReminderTaskId: task.id, buttonReplyId: 'reminder_snooze' },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(result.outcome, 'reminder_action');
  assert.equal(result.action, 'snoozed');
  const after = await tasksRepo.findById(task.id, pool);
  assert.equal(after.reminder_sent_at, null, 're-armed for the next sweep');
  assert.ok(new Date(after.reminder_datetime).getTime() > Date.now(), 'pushed into the future');
});

test('swipe-replying "snooze in an hour" as plain text (quoted, no button tap) works the same one-shot', async () => {
  const { family, knownSender, calendar, messenger, task } = await seedDueReminder(pool);
  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'snooze in an hour', externalMessageId: 'wamid.f2-3b', replyToReminderTaskId: task.id, buttonReplyId: null },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(result.action, 'snoozed');
  const after = await tasksRepo.findById(task.id, pool);
  assert.ok(new Date(after.reminder_datetime).getTime() > Date.now(), 'pushed into the future');
});

test('tapping "Snooze" with no duration asks, then a bare follow-up reply (no quote) completes it', async () => {
  const { family, knownSender, calendar, messenger, task } = await seedDueReminder(pool);
  const asked = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Snooze', externalMessageId: 'wamid.f2-4a', replyToReminderTaskId: task.id, buttonReplyId: 'reminder_snooze' },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(asked.action, 'snooze_pending');
  assert.match(asked.reply, /Snooze until when/);
  assert.equal((await tasksRepo.findById(task.id, pool)).reminder_pending_action, 'snooze');

  const answered = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'tomorrow morning', externalMessageId: 'wamid.f2-4b' },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(answered.action, 'snoozed');
  const after = await tasksRepo.findById(task.id, pool);
  assert.equal(after.reminder_pending_action, null, 'cleared once resolved');
});

test('reschedule on a reminder tied to a real calendar event moves the EVENT, never the reminder itself (one-shot text, no button)', async () => {
  const { family, knownSender, calendar, messenger, task } = await seedDueReminder(pool, { tiedToEvent: true });
  const [eventId] = calendar.events.keys();
  assert.equal(calendar.events.get(eventId).startDateTime, '2026-09-11T09:00:00');

  // handleIncomingMessage defaults deps.timeZone to 'UTC' when not passed
  // (see pipeline.js) -- compute the expected target the same way
  // resolveReplyDate itself will, off the REAL current day, rather than
  // hardcoding a date that only holds true the day this test was written.
  const expectedSaturday = resolveNamedWeekdayDate(todayInTimeZone('UTC'), 6);

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'reschedule to Saturday 10am', externalMessageId: 'wamid.f2-5', replyToReminderTaskId: task.id },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );

  assert.equal(result.outcome, 'corrected');
  assert.match(result.reply, /Moved — Gym class/);
  assert.equal(calendar.events.get(eventId).startDateTime, `${expectedSaturday}T10:00:00`);
  const afterTask = await tasksRepo.findById(task.id, pool);
  assert.equal(afterTask.reminder_datetime, task.reminder_datetime, 'the reminder\'s own fire time is untouched — reschedule is only ever the event');
});

test('tapping-free "reschedule" alone parks the ask, then a bare quoted-or-not follow-up with a target completes it', async () => {
  const { family, knownSender, calendar, messenger, task } = await seedDueReminder(pool, { tiedToEvent: true });
  const [eventId] = calendar.events.keys();

  const asked = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'reschedule', externalMessageId: 'wamid.f2-5b', replyToReminderTaskId: task.id, buttonReplyId: null },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(asked.action, 'reschedule_pending');
  assert.match(asked.reply, /Move the event to when/);
  assert.equal((await tasksRepo.findById(task.id, pool)).reminder_pending_action, 'reschedule');

  const answered = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: '7pm', externalMessageId: 'wamid.f2-5c' },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(answered.outcome, 'corrected');
  assert.equal(calendar.events.get(eventId).startDateTime, '2026-09-11T19:00:00', 'kept the event\'s own existing date, only the time changed');
  assert.equal((await tasksRepo.findById(task.id, pool)).reminder_pending_action, null);
});

test('reschedule on a reminder with NO underlying event is declined honestly, suggesting Snooze', async () => {
  const { family, knownSender, calendar, messenger, task } = await seedDueReminder(pool, { tiedToEvent: false });
  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'reschedule', externalMessageId: 'wamid.f2-6', replyToReminderTaskId: task.id, buttonReplyId: null },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(result.action, 'reschedule_declined');
  assert.match(result.reply, /isn't tied to a calendar event/);
});

test('a reply to a reminder that names no recognized action gets an honest reply, not silence or a misfire', async () => {
  const { family, knownSender, calendar, messenger, task } = await seedDueReminder(pool);
  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'thanks!', externalMessageId: 'wamid.f2-7', replyToReminderTaskId: task.id },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM'); }, calendar, messenger }
  );
  assert.equal(result.outcome, 'reminder_action_failed');
  assert.match(result.reply, /Done.*Snooze.*Reschedule/);
});

test('an unrelated new message from the same sender after a reminder fired is NOT swallowed as a reminder reply', async () => {
  const { family, knownSender, calendar, messenger } = await seedDueReminder(pool);
  const llm = createFakeLlm({
    'Dance class Friday 4pm': {
      title: 'Dance class', date: '2026-09-11', time: '16:00', person: null, category: 'activity',
      reminder_requested: false, reminder_datetime: null,
    },
  });
  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Dance class Friday 4pm', externalMessageId: 'wamid.f2-8' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(result.outcome, 'written', 'a genuinely new capture must still go through normal extraction');
});
