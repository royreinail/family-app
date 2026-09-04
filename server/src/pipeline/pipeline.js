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
import * as standingRulesRepo from '../repositories/standingRules.js';
import { evaluateRules } from '../rules/engine.js';
import { matchCommand, helpReply, formatTaskList, parseCorrectedTime, parseCorrectedTimeRange, isBareTimeAnswer, bareDisambiguationChoice, isYesNoAnswer } from './commands.js';
import {
  factsFromCandidate,
  confirmReply,
  qualifyReply,
  clarifyReply,
  reminderConfirmReply,
  addOneHour,
  addDays,
  naiveDateTimeToUtcMs,
  utcMsToNaiveDateTime,
  todayInTimeZone,
  overrideObviousRelativeDate,
  overrideExplicitAudienceKeyword,
  applyForwardedSenderDefault,
  matchBarePersonCorrection,
  resolveEventColorId,
  calendarPayloadFromCandidate,
  localDateTimeToUtcIso,
  sanitizeActivityIcon,
  shouldShowOnKidBoard,
  matchMembersToEvent,
  matchSingleFamilyMember,
  formatQueryReply,
  matchEventsByDescription,
  formatDisambiguationReply,
  formatNoMatchReply,
  formatManagementConfirmReply,
  formatAdditionalEventsNote,
  applyStandingRuleDefaults,
  formatRulesList,
  findConflicts,
  formatConflictNote,
  calendarErrorReply,
} from './classify.js';
import { scheduleReminder } from './reminders.js';
import { adoptUntrackedEvents } from './eventAdoption.js';

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
 * @param {boolean} [message.wasForwarded] - Meta's own message.context.forwarded flag (item 6)
 * @param {object} deps - injected boundary implementations (production wiring in routes/webhook.js, fakes in tests)
 * @param {import('pg').Pool} deps.pool
 * @param {(rawInput: string) => Promise<object>} deps.llmExtract
 * @param {{createEvent: Function, updateEvent: Function, deleteEvent: Function, listEvents: Function}} deps.calendar - already family-scoped
 * @param {{send: Function}} deps.messenger
 * @param {object} [deps.senderFamilyMember] - the family member mapped to this sender's number, if any (item 6's forwarded-default target)
 * @param {boolean} [deps.calendarConnected] - A1: lets a read-back query give a clean "connect Calendar first" reply instead of a raw API failure
 */
export async function handleIncomingMessage(message, deps) {
  const { familyId, externalMessageId, senderIdentifier, text, replyToExtractionLogId, wasForwarded } = message;
  const { pool, llmExtract, calendar, messenger, timeZone = 'UTC', familyMembers = [], senderFamilyMember = null, calendarConnected = true } = deps;

  // 1. Write-ahead log — the instant the "webhook fires", before anything else.
  const log = await extractionLogRepo.create(
    { familyId, rawInput: text, senderIdentifier, externalMessageId, replyToExternalId: replyToExtractionLogId ?? null },
    pool
  );

  // 2. Correction-reply path — not a command, not a rule match.
  if (replyToExtractionLogId) {
    return handleCorrection({ log, replyToExtractionLogId, text, calendar, messenger, senderIdentifier, pool, timeZone, familyMembers, familyId });
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

  // 3b. Follow-up-answer path — the bot previously asked this sender
  // "What time?" and left a fully-parsed event parked in `needs_time`
  // (title, resolved date, person all already known). A bare reply like
  // "8:30" is the answer to THAT question: merge the time into the parked
  // candidate and promote it to the calendar, rather than sending the
  // fragment through extraction from scratch — which drops the title, the
  // already-resolved relative date, and the person. Runs after the gate so
  // a Meta retry of the same "8:30" is still caught by duplicate_message.
  if (!replyToExtractionLogId && isBareTimeAnswer(text)) {
    const pending = await extractionLogRepo.findRecentPendingFollowUp({ familyId, senderIdentifier }, pool);
    if (pending) {
      const { time: newTime, endTime: newEndTime } = parseCorrectedTimeRange(text);
      return promotePendingEventWithTime({
        log,
        pending,
        newTime,
        newEndTime,
        calendar,
        messenger,
        senderIdentifier,
        pool,
        timeZone,
        familyMembers,
        familyId,
      });
    }
  }

  // 3c. Person-correction-answer path — item 6: "actually for Theo" fixes
  // who a recently-written event is for, including reversing a forwarded-
  // sender assumption (3d/applyForwardedSenderDefault below). Bounded to a
  // short window (findRecentWrittenCalendarEventBySender's default 10 min)
  // since an unquoted name mentioned much later is far more likely to be
  // unrelated than a live correction. Can't overlap with the bare-time-
  // answer branch above by construction (one requires a time, the other a
  // family member's name, and matchBarePersonCorrection demands the
  // *entire* message reduce to just that name).
  if (!replyToExtractionLogId) {
    const personMatch = matchBarePersonCorrection(text, familyMembers);
    if (personMatch) {
      const recentWritten = await extractionLogRepo.findRecentWrittenCalendarEventBySender({ familyId, senderIdentifier }, pool);
      if (recentWritten) {
        return applyPersonCorrection({ log, original: recentWritten, matchedMember: personMatch, calendar, messenger, senderIdentifier, pool });
      }
    }
  }

  // 3e. A2 — resolves the "which one?" disambiguation a management request
  // (cancel/reschedule) parked when its description matched more than one
  // event (see handleManagementRequest below). A bare number is the answer
  // to *that* prompt specifically — same "strict, whole-message-must-reduce"
  // philosophy as isBareTimeAnswer/matchBarePersonCorrection, so a genuinely
  // new message that happens to contain a digit elsewhere doesn't get
  // misread as picking an option.
  if (!replyToExtractionLogId) {
    const choice = bareDisambiguationChoice(text);
    if (choice) {
      const pending = await extractionLogRepo.findRecentPendingDisambiguation({ familyId, senderIdentifier }, pool);
      if (pending) {
        return resolveDisambiguation({ log, pending, choice, calendar, messenger, senderIdentifier, pool, familyId });
      }
    }
  }

  // 3f. C1 (D-3) — resolves a pending standing-rule proposal's yes/no
  // confirmation *without* a second LLM call: a bare "yes"/"no" only ever
  // does anything here when a real pending proposal is actually found for
  // this sender — a random "yes" to something else entirely falls straight
  // through to normal extraction below, same "genuinely new message" safety
  // net every other bare-answer path in this file already has.
  if (!replyToExtractionLogId) {
    const yesNo = isYesNoAnswer(text);
    if (yesNo) {
      const pendingRule = await standingRulesRepo.findRecentPending({ familyId, senderIdentifier }, pool);
      if (pendingRule) {
        return resolveStandingRule({ log, pendingRule, yesNo, messenger, senderIdentifier, pool });
      }
    }
  }

  // 4. LLM extraction — the LLM's one job, wrapped for transient failures.
  let candidate;
  try {
    candidate = await withRetry(() => llmExtract(text));
  } catch (err) {
    await extractionLogRepo.updateState(log.id, { state: 'failed', error: String(err?.message || err) }, pool);
    return { outcome: 'failed', error: err, log };
  }

  // A1 — a read-back question ("what's on tomorrow?") is a genuinely
  // different shape from a capture and branches off before any of the
  // capture-only steps below (relative-date override, audience override,
  // forwarded-sender default, assessment rules, a write) — none of those
  // make sense for "tell me what's already there."
  if (candidate.type === 'query') {
    return handleReadBackQuery({ log, candidate, calendar, messenger, senderIdentifier, pool, timeZone, familyMembers, familyId, calendarConnected });
  }
  // A2 — same reasoning: "cancel dance class Thursday" is a fundamentally
  // different shape from a capture, branches off before the capture-only
  // steps for the same reason.
  if (candidate.type === 'management') {
    return handleManagementRequest({ log, candidate, calendar, messenger, senderIdentifier, pool, timeZone, familyMembers, familyId, calendarConnected });
  }
  // C1 — "art therapy is always at the Rothschild clinic" is neither a
  // create/query/manage request; branches off the same way, before any of
  // the capture-only steps below.
  if (candidate.type === 'rule') {
    return handleRuleDefinition({ log, candidate, familyId, senderIdentifier, messenger, pool });
  }

  // C1 — active event-default standing rules ("art therapy is always at
  // the Rothschild clinic") apply before any of the capture-only overrides
  // below, filling in gaps only (see applyStandingRuleDefaults) — a taught
  // default, not a silent override of whatever the message itself said.
  const activeEventDefaults = await standingRulesRepo.findActiveByKind({ familyId, ruleKind: 'event_default' }, pool);
  // A3 — a multi-event message shares ONE raw text across several distinct
  // events; matching each one's defaults against the whole raw text (not
  // just its own title) would let a keyword belonging to one event bleed
  // onto an unrelated sibling in the same message (caught while adding a
  // regression test for this pairing). Scope to title-only whenever
  // there's more than one event in play — a genuinely single-event message
  // keeps the richer title-or-raw-text match (a taught keyword phrase can
  // still apply even when the LLM's own title paraphrased it away).
  candidate = applyStandingRuleDefaults(candidate, candidate.additional_events?.length ? '' : text, activeEventDefaults);

  // "today"/"tomorrow" are unambiguous enough to not trust to LLM date
  // arithmetic — see classify.js for why (a real off-by-one was observed).
  // Applies (and can fill in a date the LLM missed) whenever the raw text
  // says one of those words, independent of what the LLM itself returned.
  candidate = overrideObviousRelativeDate(text, candidate, todayInTimeZone(timeZone));
  // Backlog 4.3 — an explicit "just us parents"-style phrase always wins
  // over the LLM's own audience read; see classify.js for why there's no
  // opposite override (default is already 'family').
  candidate = overrideExplicitAudienceKeyword(text, candidate);
  // 3d. Item 6 — a forwarded message with no clear person defaults to
  // whoever forwarded it (marked as an assumption, not silent — see
  // qualifyReply/confirmReply). No-op for a message the sender typed
  // directly, or one that already names a real family member.
  candidate = applyForwardedSenderDefault(candidate, { wasForwarded, senderFamilyMember, familyMembers });
  await extractionLogRepo.updateState(log.id, { state: 'extracted', aiCandidate: candidate }, pool);

  // 5. Assessment rules — act on the LLM's structured output.
  const facts = factsFromCandidate(candidate);
  const classification = await evaluateRules('assessment', 'extraction_classification', facts, { familyId, pool });
  const action = classification.action;
  const firedRuleName = classification.rule?.name ?? null;

  let result;
  if (action.type === 'write_calendar') {
    const routing = await evaluateRules('assessment', 'event_task_routing', facts, { familyId, pool });
    const payload = calendarPayloadFromCandidate(candidate, { familyMembers, timeZone, sourceText: text });

    // B3 (conflict detection) — best-effort, never blocks the write: a
    // listEvents failure (or simply no confidently-matched person to check
    // against) just means no conflict note gets appended, same "flag, don't
    // block" behavior the backlog itself specifies.
    let conflictNote = '';
    if (payload.personId) {
      try {
        let dayEvents = await calendar.listEvents({
          timeMin: localDateTimeToUtcIso(candidate.date, '00:00', timeZone),
          timeMax: localDateTimeToUtcIso(candidate.date, '23:59', timeZone),
        });
        // Adopt any manually-added event on this same day BEFORE checking
        // for conflicts — findConflicts only ever compares personId
        // directly, with no text-match fallback, so a real double-booking
        // against a manually-added event would otherwise go completely
        // unflagged.
        dayEvents = await adoptUntrackedEvents(dayEvents, { familyId, familyMembers, updateEvent: calendar.updateEvent, pool });
        conflictNote = formatConflictNote(findConflicts(payload, dayEvents), candidate.person);
      } catch (err) {
        console.error('Conflict check failed (non-blocking)', err);
      }
    }

    // Real gap caught live (a dead Google refresh token, GaxiosError
    // invalid_grant): this call had NO error handling at all — an
    // uncaught throw here propagated all the way to webhook.js's own
    // outermost try/catch, which only logs it, so the sender got ZERO
    // reply. Worse than every other calendar-touching path in this file,
    // which already at least sends something — fixed to match them, and
    // to distinguish a dead connection (calendarErrorReply's reauth
    // message, actionable) from a transient hiccup (generic retry).
    let eventRef;
    try {
      eventRef = await calendar.createEvent(payload);
    } catch (err) {
      await extractionLogRepo.updateState(log.id, { state: 'failed', error: String(err?.message || err) }, pool);
      await messenger.send(senderIdentifier, calendarErrorReply(err, { action: 'write' }));
      return { outcome: 'failed', error: err, log };
    }
    await extractionLogRepo.updateState(
      log.id,
      { state: 'written', resultingEventRef: eventRef, firedRule: firedRuleName },
      pool
    );
    const reply = confirmReply(candidate) + conflictNote;
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

  // A3 — multi-event extraction: a forwarded message can describe more than
  // one event/date at once (a school's weekly schedule, several trip dates
  // in one flyer) — record_extraction's `additional_events` array carries
  // anything beyond the primary item so it's never silently dropped, the
  // same failure class as the already-fixed duration-loss bug. Processed
  // independent of how the *primary* item itself routed (write/qualify/
  // clarify/stop) — a message can have one awkward primary item next to two
  // perfectly well-formed additional ones, and those shouldn't be swallowed
  // just because the first one wasn't clean. Sent as its own follow-up
  // message rather than folded into the primary reply — keeps every
  // existing single-event confirmReply call site and test untouched, and
  // reads just as clearly in a WhatsApp thread (two messages from the same
  // turn) as one long combined one would.
  if (candidate.additional_events?.length) {
    const items = [];
    for (const extra of candidate.additional_events) {
      const written = await writeAdditionalEvent(extra, {
        familyId, familyMembers, timeZone, text, wasForwarded, senderFamilyMember, pool, log, calendar, activeEventDefaults,
      });
      if (written) items.push(written);
    }
    if (items.length) {
      const note = formatAdditionalEventsNote(items);
      await messenger.send(senderIdentifier, note);
      result.additionalEvents = items;
    }
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

// A3 — writes a single item from `additional_events`. Deliberately simpler
// than the primary item's own path: routed by a plain has-a-time check, not
// the family's assessment rules table (real-world additional items almost
// always carry both a date and a time — that's the whole failure mode A3
// exists to stop losing — so a second full rules-engine pass per item isn't
// worth the complexity), and no reminder handling (a personal "remind me"
// request is the sender's own ask, not something that applies per date in a
// forwarded list). Still gets the same C1 standing-rule event defaults, the
// same forwarded-sender person default, and the same explicit-audience-
// keyword override as the primary item — all three are about the *whole*
// message's context (taught defaults, who forwarded it, "just us parents"),
// not anything specific to being first vs. additional, so an additional
// item shouldn't silently miss a default the primary item would have gotten
// for the exact same title (a real gap caught on a later audit pass: this
// used to skip applyStandingRuleDefaults entirely). Returns null (skip,
// same as the primary item's own nothing-usable case) when there's no date
// at all to act on.
async function writeAdditionalEvent(extra, { familyId, familyMembers, timeZone, text, wasForwarded, senderFamilyMember, pool, log, calendar, activeEventDefaults }) {
  if (!extra?.date) return null;
  let candidate = { ...extra, reminder_requested: false, reminder_datetime: null };
  // Title-only match (see the primary item's own call site for why): this
  // item's title is the only thing that's actually specific to IT, not the
  // shared raw message text every sibling in additional_events also sees.
  candidate = applyStandingRuleDefaults(candidate, '', activeEventDefaults);
  candidate = overrideExplicitAudienceKeyword(text, candidate);
  candidate = applyForwardedSenderDefault(candidate, { wasForwarded, senderFamilyMember, familyMembers });
  if (candidate.time) {
    // Same reasoning as the primary item's own write: never let a real
    // Calendar failure vanish silently — A3's whole point is not losing
    // items from a multi-event message, and an uncaught throw here would
    // have quietly dropped this one from the "+N more" note entirely.
    try {
      const ref = await calendar.createEvent(calendarPayloadFromCandidate(candidate, { familyMembers, timeZone, sourceText: text }));
      return { status: 'written', candidate, ref };
    } catch (err) {
      console.error(`Failed to write additional event "${candidate.title}"`, err);
      return { status: 'failed', candidate };
    }
  }
  const task = await tasksRepo.create(
    { familyId, title: candidate.title || 'Untitled task', dueDate: candidate.date, sourceExtractionLogId: log.id },
    pool
  );
  return { status: 'needs_time', candidate, task };
}

// A1 — reads, never writes: resolves the asked-about date range against the
// family's own timezone (same conversion `write_task_reminder` above uses,
// so "tomorrow" means the same calendar day either direction), lists
// matching events, and replies. Two filters, in order: D-1's decision
// reuses the *exact* audience filter the kid dashboard applies
// (shouldShowOnKidBoard) rather than inventing a second one; then, only
// when the question named someone ("what does Gaia have Tuesday?"),
// narrows to events actually matched to that person via the same
// personId-first/text-match-fallback logic the dashboard's own card
// coloring already relies on (matchMembersToEvent) — one shared notion of
// "whose event is this" everywhere it's asked, not a third guess.
async function handleReadBackQuery({ log, candidate, calendar, messenger, senderIdentifier, pool, timeZone, familyMembers, familyId, calendarConnected }) {
  if (!calendarConnected) {
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    await messenger.send(senderIdentifier, "Google Calendar isn't connected yet — connect it from Settings first.");
    return { outcome: 'query_failed', log };
  }

  const timeMin = localDateTimeToUtcIso(candidate.date_from, '00:00', timeZone);
  const timeMax = localDateTimeToUtcIso(candidate.date_to, '23:59', timeZone);

  let items;
  try {
    items = await calendar.listEvents({ timeMin, timeMax });
    // Adopt manually-added events into local tracking on this read too —
    // "everywhere the bot reads the calendar," not just the daily
    // briefing — so a person-scoped query ("what does Gaia have Tuesday?")
    // finds a manually-added event the same way it finds a bot-created one.
    items = await adoptUntrackedEvents(items, { familyId, familyMembers, updateEvent: calendar.updateEvent, pool });
  } catch (err) {
    await extractionLogRepo.updateState(log.id, { state: 'failed', error: String(err?.message || err) }, pool);
    await messenger.send(senderIdentifier, calendarErrorReply(err));
    return { outcome: 'failed', error: err, log };
  }

  let visible = items.filter(shouldShowOnKidBoard);

  const targetMember = candidate.person ? matchSingleFamilyMember(candidate.person, familyMembers) : null;
  if (targetMember) {
    visible = visible.filter((item) => matchMembersToEvent(item, familyMembers).some((m) => m.id === targetMember.id));
  }

  const reply = formatQueryReply(visible, {
    personName: targetMember?.name,
    dateFrom: candidate.date_from,
    dateTo: candidate.date_to,
  });
  await messenger.send(senderIdentifier, reply);
  await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
  return { outcome: 'query', events: visible, reply, log };
}

// A2 — finds the event(s) a cancel/reschedule description matches and acts
// (or asks which one, per D-2). Deliberately does NOT apply
// shouldShowOnKidBoard the way handleReadBackQuery does: audience only
// controls what the *kid dashboard* shows, not what a parent can manage
// through the bot — a parent_only event must still be cancellable/
// reschedulable here.
async function handleManagementRequest({ log, candidate, calendar, messenger, senderIdentifier, pool, timeZone, familyMembers, familyId, calendarConnected }) {
  if (!calendarConnected) {
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    await messenger.send(senderIdentifier, "Google Calendar isn't connected yet — connect it from Settings first.");
    return { outcome: 'query_failed', log };
  }

  const { management_action: managementAction, event_description: description, date_hint: dateHint, new_date: newDate, new_time: newTime } = candidate;

  // Real gap this guards against: without it, "move dance class" (no target
  // given at all) would fall through to performManagementAction, which
  // defaults a missing new_date/new_time to the event's *own current*
  // date/time — silently "rescheduling" it to exactly where it already
  // was. Ask instead of pretending that's a real answer. A full multi-turn
  // "reschedule to when?" follow-up (parking state, merging the answer) is
  // out of scope for this pass — the common real phrasing ("move dance
  // class to 5pm") already gives a target in the same message.
  if (managementAction === 'reschedule' && !newDate && !newTime) {
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    const reply = `What time should I move "${description}" to?`;
    await messenger.send(senderIdentifier, reply);
    return { outcome: 'query_failed', reply, log };
  }

  // An explicit date hint narrows the search to that exact day; otherwise
  // search forward from today — canceling/rescheduling something in the
  // past is unusual enough that a 60-day forward window covers the
  // realistic case without an unbounded, ever-slower query.
  const today = todayInTimeZone(timeZone);
  const searchFrom = dateHint || today;
  const searchTo = dateHint || addDays(today, 60);
  const timeMin = localDateTimeToUtcIso(searchFrom, '00:00', timeZone);
  const timeMax = localDateTimeToUtcIso(searchTo, '23:59', timeZone);

  let items;
  try {
    items = await calendar.listEvents({ timeMin, timeMax });
    // Adopt manually-added events here too — a parent should be able to
    // "cancel"/"move" a manually-added event exactly like a bot-created
    // one, and future features (personId-based matching) benefit either way.
    items = await adoptUntrackedEvents(items, { familyId, familyMembers, updateEvent: calendar.updateEvent, pool });
  } catch (err) {
    await extractionLogRepo.updateState(log.id, { state: 'failed', error: String(err?.message || err) }, pool);
    await messenger.send(senderIdentifier, calendarErrorReply(err));
    return { outcome: 'failed', error: err, log };
  }

  const matches = matchEventsByDescription(items, { titleHint: description, dateHint });

  if (matches.length === 0) {
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    const reply = formatNoMatchReply(description);
    await messenger.send(senderIdentifier, reply);
    return { outcome: 'query_failed', reply, log };
  }

  if (matches.length > 1) {
    // Capped so the numbered list (and the DB row holding it) stays a
    // reasonable, actually-readable size — a description vague enough to
    // match more than a handful of events needs narrowing in conversation
    // anyway, not an exhaustive list.
    const capped = matches.slice(0, 5);
    await extractionLogRepo.updateState(
      log.id,
      { state: 'needs_disambiguation', aiCandidate: { managementAction, candidates: capped, newDate, newTime } },
      pool
    );
    const reply = formatDisambiguationReply(capped, managementAction);
    await messenger.send(senderIdentifier, reply);
    return { outcome: 'needs_disambiguation', reply, log };
  }

  return performManagementAction({ log, familyId, managementAction, item: matches[0], newDate, newTime, calendar, messenger, senderIdentifier, pool });
}

// Resolves a "which one?" prompt (see handleManagementRequest above) once
// the sender replies with a bare number.
async function resolveDisambiguation({ log, pending, choice, calendar, messenger, senderIdentifier, pool, familyId }) {
  const { managementAction, candidates, newDate, newTime } = pending.ai_candidate;
  const chosen = candidates[choice - 1];
  if (!chosen) {
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    const reply = `That wasn't one of the options — reply with a number from 1 to ${candidates.length}.`;
    await messenger.send(senderIdentifier, reply);
    return { outcome: 'query_failed', reply, log };
  }
  await extractionLogRepo.updateState(pending.id, { state: 'stopped' }, pool);
  return performManagementAction({ log, familyId, managementAction, item: chosen, newDate, newTime, calendar, messenger, senderIdentifier, pool });
}

// Shared tail of both the single-match path and the disambiguation-resolved
// path: actually cancel or reschedule the real Calendar event, then reply.
// Cancel also retires the original extraction_log row (state 'undone',
// same convention the "undo" command already uses) if one still exists for
// this event — otherwise a stale 'written' row would keep pointing at a
// Calendar event that no longer exists, which a later item-6 person-
// correction attempt could try (and fail) to patch. Reschedule leaves the
// original log's own stored candidate as-is — a known, minor bookkeeping
// gap (its cached date/time won't reflect the move) accepted to keep this
// already-large feature's scope bounded; the real Calendar event, which is
// what actually matters, is correctly updated either way.
async function performManagementAction({ log, familyId, managementAction, item, newDate, newTime, calendar, messenger, senderIdentifier, pool }) {
  try {
    if (managementAction === 'cancel') {
      await calendar.deleteEvent(item.id);
      const originalLog = await extractionLogRepo.findByCalendarEventId({ familyId, externalId: item.id }, pool);
      if (originalLog) await extractionLogRepo.updateState(originalLog.id, { state: 'undone' }, pool);
    } else {
      const originalStart = item.start?.dateTime;
      const originalEnd = item.end?.dateTime;
      const date = newDate || originalStart?.slice(0, 10);
      const time = newTime || originalStart?.slice(11, 16);
      // naiveDateTimeToUtcMs/utcMsToNaiveDateTime, not plain `new Date()` —
      // these are naive wall-clock strings (no offset), and a bare
      // `new Date(naiveString)` parses using the *server process's* local
      // timezone. A real bug caught writing this: round-tripping through
      // `new Date()` + `.toISOString()` silently shifted the computed end
      // time by the sandbox's own UTC offset.
      const durationMs =
        originalStart && originalEnd
          ? naiveDateTimeToUtcMs(originalEnd) - naiveDateTimeToUtcMs(originalStart)
          : 60 * 60 * 1000;
      const newStart = `${date}T${time}:00`;
      const newEnd = utcMsToNaiveDateTime(naiveDateTimeToUtcMs(newStart) + durationMs);
      await calendar.updateEvent(item.id, { start: { dateTime: newStart }, end: { dateTime: newEnd } });
    }
  } catch (err) {
    await extractionLogRepo.updateState(log.id, { state: 'failed', error: String(err?.message || err) }, pool);
    await messenger.send(senderIdentifier, 'Something went wrong making that change — try again in a bit.');
    return { outcome: 'failed', error: err, log };
  }

  await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
  const reply = formatManagementConfirmReply(managementAction, item, { newDate, newTime });
  await messenger.send(senderIdentifier, reply);
  return { outcome: 'managed', managementAction, item, reply, log };
}

// C1 (D-3) — a rule-defining message never writes anything directly: the
// LLM already articulated rule_text in the same call that detected the
// intent (no second call), and this just parks it as a 'pending' row and
// asks for a yes/no. resolveStandingRule (below) is the only thing that
// ever flips it to 'active'.
async function handleRuleDefinition({ log, candidate, familyId, senderIdentifier, messenger, pool }) {
  const { rule_text: ruleText, rule_kind: ruleKind, field, match_keyword: matchKeyword, value, param_name: paramName, param_value: paramValue } = candidate;
  const pending = await standingRulesRepo.create(
    { familyId, ruleText, ruleKind, matchKeyword, field, value, paramName, paramValue, senderIdentifier },
    pool
  );
  await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
  const reply = `${ruleText}\n\nShould I remember this? Reply yes or no.`;
  await messenger.send(senderIdentifier, reply);
  return { outcome: 'rule_pending', pending, reply, log };
}

// C1 (D-3) — the yes/no reply itself never touches the LLM: `yesNo` was
// already resolved by commands.js's isYesNoAnswer via a closed word list,
// matched directly against the pending DB record found by pipeline.js's own
// step 3f.
async function resolveStandingRule({ log, pendingRule, yesNo, messenger, senderIdentifier, pool }) {
  await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
  if (yesNo === 'yes') {
    await standingRulesRepo.confirm(pendingRule.id, pool);
    const reply = "Got it — I'll remember that.";
    await messenger.send(senderIdentifier, reply);
    return { outcome: 'rule_confirmed', pendingRule, reply, log };
  }
  await standingRulesRepo.discard(pendingRule.id, pool);
  const reply = "Okay, I won't apply that.";
  await messenger.send(senderIdentifier, reply);
  return { outcome: 'rule_discarded', pendingRule, reply, log };
}

async function handleCommand({ command, log, familyId, senderIdentifier, calendar, messenger, pool }) {
  if (command === 'help') {
    await messenger.send(senderIdentifier, helpReply());
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    return { outcome: 'command', command, log };
  }
  // C1 — "rules" / "my rules" / "delete rule N", per D-3: reviewable only
  // via a bot command, no Settings screen.
  if (command === 'list_rules') {
    const rules = await standingRulesRepo.findActiveForFamily(familyId, pool);
    await messenger.send(senderIdentifier, formatRulesList(rules));
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    return { outcome: 'command', command, log, rules };
  }
  if (command?.type === 'delete_rule') {
    const rules = await standingRulesRepo.findActiveForFamily(familyId, pool);
    const target = rules[command.index - 1];
    if (!target) {
      await messenger.send(senderIdentifier, `I don't have a rule #${command.index} — reply "rules" to see the current list.`);
      await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
      return { outcome: 'command', command, log, deleted: null };
    }
    await standingRulesRepo.softDelete(target.id, familyId, pool);
    await messenger.send(senderIdentifier, `Deleted — "${target.rule_text}"`);
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    return { outcome: 'command', command, log, deleted: target };
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

async function handleCorrection({ log, replyToExtractionLogId, text, calendar, messenger, senderIdentifier, pool, timeZone, familyMembers = [], familyId }) {
  const original = await extractionLogRepo.findById(replyToExtractionLogId, pool);
  if (!original) {
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    await messenger.send(senderIdentifier, "I couldn't find what that correction was replying to.");
    return { outcome: 'correction_failed', log };
  }

  const newTime = parseCorrectedTime(text);

  // Quote-replying a time to the bot's own "What time?" question is not a
  // correction of an existing event — it's the missing piece of a parked
  // one. Same promotion as the no-quote follow-up path (3b): merge the
  // time in, create the real calendar event, retire the tentative task.
  if (original.state === 'needs_time' && newTime) {
    const { endTime: newEndTime } = parseCorrectedTimeRange(text);
    return promotePendingEventWithTime({
      log, pending: original, newTime, newEndTime, calendar, messenger, senderIdentifier, pool, timeZone, familyMembers, familyId,
    });
  }

  // Item 6 (and item 9's fix) — a quoted reply naming a family member
  // corrects who that specific event is for. No age window here on
  // purpose: quoting a message is already an unambiguous reference to
  // exactly that event, no matter how long ago it was written — a window
  // only exists to guard the *bare*, no-quote path (3c above), where the
  // ambiguity a window protects against is real (ANY unquoted message
  // naming someone could be unrelated). Applying that same window to an
  // explicit quote was a real bug: "editing the assignee of an existing
  // event via reply doesn't work" for anything past a few minutes old,
  // even though quoting it already says exactly which event is meant.
  const personMatch = matchBarePersonCorrection(text, familyMembers);
  if (personMatch && original.state === 'written' && original.resulting_event_ref?.provider === 'google') {
    return applyPersonCorrection({ log, original, matchedMember: personMatch, calendar, messenger, senderIdentifier, pool });
  }

  // Item 9's other half of the same bug report: this fallback used to run
  // unconditionally whenever neither a time nor a person correction
  // applied, sending a confident "Updated — {title} now at {time}" even
  // though `newTime` was null and nothing had actually changed —
  // misleadingly claiming success on a correction that was never
  // understood at all. Say so plainly instead.
  if (!newTime) {
    await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
    const reply = "I couldn't tell what to change from that — try a new time, or just the person's name.";
    await messenger.send(senderIdentifier, reply);
    return { outcome: 'correction_failed', original, reply, log };
  }

  const updatedCandidate = { ...original.ai_candidate, time: newTime };

  const ref = original.resulting_event_ref;
  if (ref?.provider === 'google') {
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

  const reply = `Updated — ${updatedCandidate.title || 'that'} now at ${newTime}.`;
  await messenger.send(senderIdentifier, reply);
  return { outcome: 'corrected', original, updatedCandidate, reply, log };
}

// Item 6 — shared by both person-correction routes (a bare "actually for
// Theo" follow-up in step 3c, and a quoted reply naming someone else in
// handleCorrection): patches the already-written Calendar event's color to
// the new person (resolveEventColorId keyed off just the matched member,
// so it always resolves — no ambiguity risk the way a free-text `person`
// string could have) and updates the stored candidate so any further
// correction or "undo" still has the right picture. Clears personAssumed
// — once explicitly corrected, it's a stated fact, not a guess anymore.
// Also repoints extendedProperties.private.personId to the corrected
// member — otherwise the kid dashboard (which reads that field directly,
// not text-matched, since the dashboard-color-mismatch fix) would keep
// showing the *old* person's color after a correction, the exact drift bug
// that fix exists to prevent. Sends the *complete* intended private-props
// object (audience + activityIcon carried over from what's already stored,
// plus the new personId) rather than a partial patch — calendar.js's
// updateEvent isn't relied on to merge that nested map correctly on its
// own, so this can't accidentally wipe audience/activityIcon even if it
// doesn't.
async function applyPersonCorrection({ log, original, matchedMember, calendar, messenger, senderIdentifier, pool }) {
  const updatedCandidate = { ...original.ai_candidate, person: matchedMember.name, personAssumed: false };
  const ref = original.resulting_event_ref;
  const privateProps = { personId: matchedMember.id };
  if (original.ai_candidate?.audience) privateProps.audience = original.ai_candidate.audience;
  if (original.ai_candidate?.activity_icon) privateProps.activityIcon = sanitizeActivityIcon(original.ai_candidate.activity_icon);
  await calendar.updateEvent(ref.external_id, {
    colorId: resolveEventColorId(matchedMember.name, [matchedMember]),
    extendedProperties: { private: privateProps },
  });
  await extractionLogRepo.updateState(original.id, { state: 'corrected', aiCandidate: updatedCandidate }, pool);
  await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);
  const reply = `Updated — that's now for ${matchedMember.name} ✅`;
  await messenger.send(senderIdentifier, reply);
  return { outcome: 'corrected', original, updatedCandidate, reply, log };
}

// Shared tail of both follow-up routes (no-quote "8:30" in step 3b, and a
// quote-reply of a time to "What time?" in handleCorrection): the parked
// `needs_time` candidate already carries the title, the resolved date and
// the person — all we add is the time. Then it graduates from a tentative
// task to a real calendar event, and the placeholder task the date-only
// branch created is retired so it doesn't linger in "list tasks".
async function promotePendingEventWithTime({ log, pending, newTime, newEndTime = null, calendar, messenger, senderIdentifier, pool, timeZone, familyMembers = [], familyId }) {
  // A range answer ("8:30-18:00") carries a real end time the way the
  // *initial* message already could (item 1) — real bug: the follow-up
  // merge only ever kept the start, silently dropping a given end time.
  const candidate = { ...pending.ai_candidate, time: newTime, end_time: newEndTime };

  const parkedTask = await tasksRepo.findBySourceExtractionLogId(pending.id, pool);

  // B4 — the ORIGINAL message that started this parked event (pending's
  // own raw_input), not the short follow-up answer ("8:30") that merely
  // completed it — that's the actually useful provenance to keep.
  const payload = calendarPayloadFromCandidate(candidate, { familyMembers, timeZone, sourceText: pending.raw_input });

  // B3 — this promotion is a real Calendar create, the same as the direct
  // write_calendar branch's own (a date-only message parked as `needs_time`
  // and then answered "8:30" is still, in the end, exactly the same kind of
  // write) — same best-effort, never-blocks-the-write conflict check.
  let conflictNote = '';
  if (payload.personId) {
    try {
      let dayEvents = await calendar.listEvents({
        timeMin: localDateTimeToUtcIso(candidate.date, '00:00', timeZone),
        timeMax: localDateTimeToUtcIso(candidate.date, '23:59', timeZone),
      });
      dayEvents = await adoptUntrackedEvents(dayEvents, { familyId, familyMembers, updateEvent: calendar.updateEvent, pool });
      conflictNote = formatConflictNote(findConflicts(payload, dayEvents), candidate.person);
    } catch (err) {
      console.error('Conflict check failed (non-blocking)', err);
    }
  }

  // Real gap caught live (a dead Google refresh token, GaxiosError
  // invalid_grant): no error handling existed here at all — an uncaught
  // throw meant total silence for the sender AND (a real secondary bug
  // this surfaced) the parked task had already been deleted above before
  // this ever ran, so a failed promotion used to lose the tentative
  // placeholder entirely, not just fail to complete it. Fixed both: the
  // task delete now happens only after a confirmed successful create, and
  // a failure here gets the same honest reply (reauth vs. transient) every
  // other calendar-touching path in this file already gives.
  let eventRef;
  try {
    eventRef = await calendar.createEvent(payload);
  } catch (err) {
    await extractionLogRepo.updateState(log.id, { state: 'failed', error: String(err?.message || err) }, pool);
    await messenger.send(senderIdentifier, calendarErrorReply(err, { action: 'write' }));
    return { outcome: 'failed', error: err, log };
  }
  if (parkedTask) await tasksRepo.softDelete(parkedTask.id, pool);

  await extractionLogRepo.updateState(
    pending.id,
    { state: 'written', aiCandidate: candidate, resultingEventRef: eventRef, firedRule: 'follow_up_answer' },
    pool
  );
  await extractionLogRepo.updateState(log.id, { state: 'stopped' }, pool);

  const reply = confirmReply(candidate) + conflictNote;
  await messenger.send(senderIdentifier, reply);
  return { outcome: 'written', destination: 'calendar', eventRef, reply, promotedFrom: pending.id, retiredTaskId: parkedTask?.id ?? null, log };
}
