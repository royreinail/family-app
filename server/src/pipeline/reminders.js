// Reminder-on-request: the one exception to the global no-automatic-reminder
// default (architecture doc, "Reminder policy"), scoped only to messages that
// explicitly asked for one. Scheduling is represented as a `tasks` row (the
// only table in the Phase 1 data model with reminder fields) so a single
// background sweep can deliver both task reminders and one-off requested
// reminders through the same mechanism.
import * as tasksRepo from '../repositories/tasks.js';
import * as extractionLogRepo from '../repositories/extractionLog.js';
import { localDateTimeToUtcIso } from './classify.js';
import { composeReminderMessage } from './reminderMessage.js';

// `reminderDatetime` arrives as a naive local wall-clock string (LLM
// convention, same as date/time elsewhere) — `dueDate` is captured from
// that local string *before* conversion (a UTC-converted value's date
// portion can land on the wrong day near local midnight), while the actual
// `reminder_datetime` column gets the real UTC instant so sweepDueReminders'
// `<= now()` comparison fires at the right absolute moment. See
// localDateTimeToUtcIso for why this conversion has to happen at all.
//
// F2 — `senderIdentifier` is now stored directly on the task
// (reminder_sender_identifier), denormalized from the originating message.
// Two things needed it: sweepDueReminders no longer has to look the source
// log back up just to know who to send to, and — the actual reason it was
// added — a reminder ACTION reply ("snooze" with no quote, answering the
// bot's own "until when?") needs a same-table lookup by sender, the same
// recency-window shape every other parked-state lookup in this codebase
// already uses.
export async function scheduleReminder({ familyId, title, reminderDatetime, timeZone = 'UTC', sourceExtractionLogId, senderIdentifier }, pool) {
  const localDate = reminderDatetime.slice(0, 10);
  const localTime = reminderDatetime.slice(11, 16);
  return tasksRepo.create(
    {
      familyId,
      title: `Reminder: ${title || 'your request'}`,
      dueDate: localDate,
      importance: 'Med',
      reminderPolicy: 'requested',
      reminderDatetime: localDateTimeToUtcIso(localDate, localTime, timeZone),
      sourceExtractionLogId,
      reminderSenderIdentifier: senderIdentifier,
    },
    pool
  );
}

// Called on an interval (see server.js) or directly by a test. Sends any
// reminder whose time has arrived and hasn't fired yet, now as an
// ACTIONABLE message (F2) — reminderMessage.js's composeReminderMessage is
// the single source of truth for its structure; sent via the free-form
// interactive path first (messenger.sendReminderButtons), which is
// currently free and falls back internally to the approved button
// template only when it's genuinely needed (outside the 24h window — see
// messenger.js's own cost note for why the template stays the fallback,
// not the primary, even now that it's approved). Stores the real WhatsApp
// message id whichever path actually sent it comes back with, so a later
// reply's `context.id` can be matched straight back to this task (see
// webhook.js's own reminder-reply routing) regardless of which path
// delivered it. `sendTo` falls back to the originating extraction_log's
// sender for any reminder created before this column existed —
// self-healing, not a hard migration requirement.
export async function sweepDueReminders({ pool, messenger }) {
  const due = await tasksRepo.findDueReminders(pool);
  for (const task of due) {
    let sendTo = task.reminder_sender_identifier;
    if (!sendTo && task.source_extraction_log_id) {
      const log = await extractionLogRepo.findById(task.source_extraction_log_id, pool);
      sendTo = log?.sender_identifier ?? null;
    }
    if (sendTo) {
      const composed = composeReminderMessage(task);
      const result = await messenger.sendReminderButtons(sendTo, composed);
      const messageId = result?.messages?.[0]?.id;
      if (messageId) await tasksRepo.setReminderMessageId(task.id, messageId, pool);
    }
    await tasksRepo.markReminderSent(task.id, pool);
  }
  return due;
}
