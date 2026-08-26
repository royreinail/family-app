// The capture pipeline. Fixed order (architecture doc + build brief):
//   extraction_log write (received) -> commands check -> gate rules
//   -> LLM extraction -> assessment rules -> deterministic write + reply
//
// Exceptions (LLM timeout, Calendar API failure) are handled here directly
// with retry-with-backoff, landing in the `failed` state — deliberately NOT
// routed through the rule engine (rules answer "given valid input, what
// should happen"; a transient API blip isn't a business decision).
import * as extractionLogRepo from '../repositories/extractionLog.js';
import * as tasksRepo from '../repositories/tasks.js';
import * as botConfigRepo from '../repositories/botConfig.js';
import { evaluateRules } from '../rules/engine.js';
import { matchCommand, helpReply, formatTaskList, parseCorrectedTime } from './commands.js';
import {
  factsFromCandidate,
  confirmReply,
  qualifyReply,
  clarifyReply,
  reminderConfirmReply,
  addOneHour,
  todayInTimeZone,
  overrideObviousRelativeDate,
  overrideExplicitAudienceKeyword,
  resolveEventColorId,
  localDateTimeToUtcIso,
} from './classify.js';
import { scheduleReminder } from './reminders.js';

async function withRetry(fn, { attempts = 3, baseDelayMs = 200 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

/**
 * @param {object} message
 * @param {string} message.familyId
 * @param {string} message.externalMessageId
 * @param {string} message.senderIdentifier
 * @param {string} message.text
 * @param {string} [message.replyToExtractionLogId] - set when this message is a reply/quote to a prior bot confirmation
 * @param {object} deps - injected boundary implementations (production wiring in routes/webhook.js, fakes in tests)
 * @param {import('pg').Pool} deps.pool
 * @param {(rawInput: string) => Promise<object>} deps.llmExtract
 * @param {{createEvent: Function, updateEvent: Function, deleteEvent: Function}} deps.calendar - already family-scoped
 * @param {{send: Function}} deps.messenger
 */
export async function handleIncomingMessage(message, deps) {
  const { familyId, externalMessageId, senderIdentifier, text, replyToExtractionLogId } = message;
  const { pool, llmExtract, calendar, messenger, timeZone = 'UTC', familyMembers = [] } = deps;

  // 1. Write-ahead log — the instant the "webhook fires", before anything else.
  const log = await extractionLogRepo.create(
    { familyId, rawInput: text, senderIdentifier, externalMessageId, replyToExternalId: replyToExtractionLogId ?? null },
    pool
  );

  // 2. Correction-reply path — not a command, not a rule match.
  if (replyToExtractionLogId) {
    return handleCorrection({ log, replyToExtractionLogId, text, calendar, messenger, senderIdentifier, pool, timeZone });
  }

  // 2b. Commands check — hardcoded, before gate rules, before any LLM call.
  const command = matchCommand(text);
  if (command) {
    return handleCommand({ command, log, familyId, senderIdentifier, calendar, messenger, pool });
  }

  // 3. Gate rules — cheap, deterministic, can short-circuit before the LLM is called.
  const duplicate = await extractionLogRepo.findDuplicate({ familyId, externalMessageId, excludeId: log.id }, pool);
  const botConfig = await botConfigRepo.findByFamilyId(familyId, pool);
  const isKnownSender = botConfigRepo.isAcceptedSender(botConfig, senderIdentifier);

  const gateResult = await evaluateRules(
    'gate',
    'incoming_message',
    { isDuplicate: !!duplicate, isKnownSender },
    { familyId, pool }
  );
  if (gateResult.matched && gateResult.action.type === 'stop_silent') {
    await extractionLogRepo.updateState(log.id, { state: 'stopped', firedRule: gateResult.rule.name }, pool);
    return { outcome: 'stopped', reason: gateResult.action.reason, rule: gateResult.rule, log };
  }

  // 4. LLM extraction — the LLM's one job, wrapped for transient failures.
  let candidate;
  try {
    candidate = await withRetry(() => llmExtract(text));
  } catch (err) {
    await extractionLogRepo.updateState(log.id, { state: 'failed', error: String(err?.message || err) }, pool);
    return { outcome: 'failed', error: err, log };
  }
  // "today"/"tomorrow" are unambiguous enough to not trust to LLM date
  // arithmetic — see classify.js for why (a real off-by-one was observed).
  // Applies (and can fill in a date the LLM missed) whenever the raw text
  // says one of those words, independent of what the LLM itself returned.
  candidate = overrideObviousRelativeDate(text, candidate, todayInTimeZone(timeZone));
  // Backlog 4.3 — an explicit "just us parents"-style phrase always wins
  // over the LLM's own audience read; see classify.js for why there's no
  // opposite override (default is already 'family').
  candidate = overrideExplicitAudienceKeyword(text, candidate);
  await extractionLogRepo.updateState(log.id, { state: 'extracted', aiCandidate: candidate }, pool);

  // 5. Assessment rules — act on the LLM's structured output.
  const facts = factsFromCandidate(candidate);
  const classification = await evaluateRules('assessment', 'extraction_classification', facts, { familyId, pool });
  const action = classification.action;
  const firedRuleName = classification.rule?.name ?? null;

  let result;
  if (action.type === 'write_calendar') {
    const routing = await evaluateRules('assessment', 'event_task_routing', facts, { familyId, pool });
    const end = addOneHour(candidate.date, candidate.time);
    const colorId = resolveEventColorId(candidate.person, familyMembers);
    const eventRef = await calendar.createEvent({
      title: candidate.title || 'Untitled event',
      startDateTime: `${candidate.date}T${candidate.time}:00`,
      endDateTime: `${end.date}T${end.time}:00`,
      timeZone,
      colorId,
      // Fixtures/candidates from before this field existed have no
      // audience at all — default to 'family' (visible), never silently
      // hide an event because the field happens to be missing.
      audience: candidate.audience || 'family',
      // Same story for candidates predating this field — omit rather than
      // pass an invalid category through; the dashboard's own fallback
      // (iconForCategory) already treats "nothing to match" as 📌.
      activityCategory: candidate.activity_category || undefined,
    });
    await extractionLogRepo.updateState(
      log.id,
      { state: 'written', resultingEventRef: eventRef, firedRule: firedRuleName },
      pool
    );
    const reply = confirmReply(candidate);
    await messenger.send(senderIdentifier, reply);
    result = { outcome: 'written', destination: 'calendar', eventRef, reply, rule: classification.rule, routingRule: routing.rule, log };
  } else if (action.type === 'write_task_reminder') {
    // The whole message IS the reminder (see isReminderOnlyMessage) — one
    // task row carries both the to-do and its own reminder, no separate
    // calendar write and no separate reminder-carrier task.
    const task = await tasksRepo.create(
      {
        familyId,
        title: candidate.title || 'Reminder',
        dueDate: candidate.date,
        reminderPolicy: 'requested',
        // reminder_datetime is a naive local wall-clock value from the LLM
        // (same convention as date/time) — must convert to a real UTC
        // instant before it hits the timestamptz column, or it fires hours
        // off in any timezone that isn't UTC (see localDateTimeToUtcIso).
        reminderDatetime: localDateTimeToUtcIso(candidate.reminder_datetime.slice(0, 10), candidate.reminder_datetime.slice(11, 16), timeZone),
        sourceExtractionLogId: log.id,
      },
      pool
    );
    const eventRef = { provider: 'tasks', external_id: task.id };
    await extractionLogRepo.updateState(
      log.id,
      { state: 'written', resultingEventRef: eventRef, firedRule: firedRuleName },
      pool
    );
    const reply = reminderConfirmReply(candidate);
    await messenger.send(senderIdentifier, reply);
    result = { outcome: 'written', destination: 'tasks', task, reply, rule: classification.rule, log };
  } else if (action.type === 'write_task_tentative') {
    const task = await tasksRepo.create(
      { familyId, title: candidate.title || 'Untitled task', dueDate: candidate.date, sourceExtractionLogId: log.id },
      pool
    );
    const eventRef = { provider: 'tasks', external_id: task.id };
    await extractionLogRepo.updateState(
      log.id,
      { state: 'needs_time', resultingEventRef: eventRef, firedRule: firedRuleName },
      pool
    );
    const reply = qualifyReply(candidate);
    await messenger.send(senderIdentifier, reply);
    result = { outcome: 'needs_time', destination: 'tasks', task, reply, rule: classification.rule, log };
  } else if (action.type === 'no_write') {
    await extractionLogRepo.updateState(log.id, { state: 'needs_clarification', firedRule: firedRuleName }, pool);
    const reply = clarifyReply();
    await messenger.send(senderIdentifier, reply);
    result = { outcome: 'needs_clarification', reply, rule: classification.rule, log };
  } else {
    // 'stop' — nothing usable: no write, no reply.
    await extractionLogRepo.updateState(log.id, { state: 'stopped', firedRule: firedRuleName }, pool);
    result = { outcome: 'stopped', rule: classification.rule, log };
  }

  // Reminder-on-request — orthogonal to the write destination above, EXCEPT
  // for write_task_reminder, which already carries the reminder directly on
  // the task it just created (a second scheduleReminder call here would
  // create a duplicate reminder-carrier task for the same request).
  if (action.type !== 'write_task_reminder' && candidate.reminder_requested && candidate.reminder_datetime) {
    result.reminder = await scheduleReminder(
      { familyId, title: candidate.title, reminderDatetime: candidate.reminder_datetime, timeZone, sourceExtractionLogId: log.id },
      pool
    );
  }

  return result;
}

async function handleCommand({ command, log, familyId, senderIdentifier, calendar, messenger, pool }) {
  if (command === 'help') {
    await messenger.send(senderIdentifier, helpReply());
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    return { outcome: 'command', command, log };
  }
  if (command === 'list_tasks') {
    const tasks = await tasksRepo.findAllForFamily(familyId, pool);
    await messenger.send(senderIdentifier, formatTaskList(tasks));
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    return { outcome: 'command', command, log, tasks };
  }
  if (command === 'undo') {
    const target = await extractionLogRepo.findLatestWrittenBySender({ familyId, senderIdentifier }, pool);
    if (!target) {
      await messenger.send(senderIdentifier, "Nothing to undo — I haven't added anything for you recently.");
      await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
      return { outcome: 'command', command, log, undone: null };
    }
    const ref = target.resulting_event_ref;
    if (ref?.provider === 'google') {
      await calendar.deleteEvent(ref.external_id);
    } else if (ref?.provider === 'tasks') {
      await tasksRepo.softDelete(ref.external_id, pool);
    }
    await extractionLogRepo.updateState(target.id, { state: 'undone' }, pool);
    await messenger.send(senderIdentifier, 'Done — undid that.');
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    return { outcome: 'command', command, log, undone: target };
  }
  return { outcome: 'unknown_command', log };
}

async function handleCorrection({ log, replyToExtractionLogId, text, calendar, messenger, senderIdentifier, pool, timeZone }) {
  const original = await extractionLogRepo.findById(replyToExtractionLogId, pool);
  if (!original) {
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    await messenger.send(senderIdentifier, "I couldn't find what that correction was replying to.");
    return { outcome: 'correction_failed', log };
  }

  const newTime = parseCorrectedTime(text);
  const updatedCandidate = { ...original.ai_candidate, ...(newTime ? { time: newTime } : {}) };

  const ref = original.resulting_event_ref;
  if (ref?.provider === 'google' && newTime) {
    const startDateTime = `${updatedCandidate.date}T${newTime}:00`;
    const end = addOneHour(updatedCandidate.date, newTime);
    await calendar.updateEvent(ref.external_id, {
      start: { dateTime: startDateTime, timeZone },
      end: { dateTime: `${end.date}T${end.time}:00`, timeZone },
    });
  }

  await extractionLogRepo.updateState(
    original.id,
    { state: 'corrected', aiCandidate: updatedCandidate },
    pool
  );
  await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);

  const reply = `Updated — ${updatedCandidate.title || 'that'} now at ${newTime || updatedCandidate.time}.`;
  await messenger.send(senderIdentifier, reply);
  return { outcome: 'corrected', original, updatedCandidate, reply, log };
}
