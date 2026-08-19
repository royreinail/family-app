// Reminder-on-request: the one exception to the global no-automatic-reminder
// default (architecture doc, "Reminder policy"), scoped only to messages that
// explicitly asked for one. Scheduling is represented as a `tasks` row (the
// only table in the Phase 1 data model with reminder fields) so a single
// background sweep can deliver both task reminders and one-off requested
// reminders through the same mechanism.
import * as tasksRepo from '../repositories/tasks.js';
import * as extractionLogRepo from '../repositories/extractionLog.js';
import { localDateTimeToUtcIso } from './classify.js';

// `reminderDatetime` arrives as a naive local wall-clock string (LLM
// convention, same as date/time elsewhere) — `dueDate` is captured from
// that local string *before* conversion (a UTC-converted value's date
// portion can land on the wrong day near local midnight), while the actual
// `reminder_datetime` column gets the real UTC instant so sweepDueReminders'
// `<= now()` comparison fires at the right absolute moment. See
// localDateTimeToUtcIso for why this conversion has to happen at all.
export async function scheduleReminder({ familyId, title, reminderDatetime, timeZone = 'UTC', sourceExtractionLogId }, pool) {
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
    },
    pool
  );
}

// Called on an interval (see server.js) or directly by a test. Sends any
// reminder whose time has arrived and hasn't fired yet. Who to send it to is
// resolved via the originating extraction_log row's sender_identifier —
// the same person who asked for the reminder in the first place.
export async function sweepDueReminders({ pool, messenger }) {
  const due = await tasksRepo.findDueReminders(pool);
  for (const task of due) {
    let sendTo = null;
    if (task.source_extraction_log_id) {
      const log = await extractionLogRepo.findById(task.source_extraction_log_id, pool);
      sendTo = log?.sender_identifier ?? null;
    }
    if (sendTo) await messenger.send(sendTo, task.title);
    await tasksRepo.markReminderSent(task.id, pool);
  }
  return due;
}
