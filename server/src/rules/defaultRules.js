// Default gate + assessment rules, seeded per family. Realistic scale is
// 10-20 rules per household (architecture doc) — this is the starter set;
// families extend it later via direct DB edit (Phase 1) or an admin UI (Phase 2+).
import * as rulesRepo from '../repositories/rules.js';

export function defaultRuleDefinitions(familyId) {
  return [
    // ---- gate tier (pre-LLM, can short-circuit entirely) ----
    {
      familyId,
      ruleType: 'gate',
      triggerType: 'incoming_message',
      name: 'duplicate_message',
      priority: 10,
      conditions: { all: [{ fact: 'isDuplicate', operator: 'equal', value: true }] },
      action: { type: 'stop_silent', reason: 'duplicate_message' },
    },
    {
      familyId,
      ruleType: 'gate',
      triggerType: 'incoming_message',
      name: 'unknown_sender',
      priority: 20,
      conditions: { all: [{ fact: 'isKnownSender', operator: 'equal', value: false }] },
      action: { type: 'stop_silent', reason: 'unknown_sender' },
    },

    // ---- assessment tier (post-extraction) ----
    // extraction_classification: field-presence tiering, branches by priority.
    // pure_reminder runs first (lower priority number = higher precedence):
    // "remind me to do the laundry at 22:30 today" has date+time too, but
    // it's the reminder itself, not a separate calendar-worthy event — see
    // isReminderOnlyMessage in classify.js for the exact distinguishing signal.
    {
      familyId,
      ruleType: 'assessment',
      triggerType: 'extraction_classification',
      name: 'extraction_classification:pure_reminder',
      priority: 5,
      conditions: { all: [{ fact: 'isPureReminder', operator: 'equal', value: true }] },
      action: { type: 'write_task_reminder', reply: 'reminder_confirm' },
    },
    {
      familyId,
      ruleType: 'assessment',
      triggerType: 'extraction_classification',
      name: 'extraction_classification:date_time',
      priority: 10,
      conditions: {
        all: [
          { fact: 'hasDate', operator: 'equal', value: true },
          { fact: 'hasTime', operator: 'equal', value: true },
        ],
      },
      action: { type: 'write_calendar', reply: 'confirm' },
    },
    {
      familyId,
      ruleType: 'assessment',
      triggerType: 'extraction_classification',
      name: 'extraction_classification:date_only',
      priority: 20,
      conditions: {
        all: [
          { fact: 'hasDate', operator: 'equal', value: true },
          { fact: 'hasTime', operator: 'equal', value: false },
        ],
      },
      action: { type: 'write_task_tentative', reply: 'qualify' },
    },
    {
      familyId,
      ruleType: 'assessment',
      triggerType: 'extraction_classification',
      name: 'extraction_classification:no_date',
      priority: 30,
      conditions: {
        all: [
          { fact: 'hasDate', operator: 'equal', value: false },
          { fact: 'hasAnyField', operator: 'equal', value: true },
        ],
      },
      action: { type: 'no_write', reply: 'clarify' },
    },
    {
      familyId,
      ruleType: 'assessment',
      triggerType: 'extraction_classification',
      name: 'extraction_classification:nothing_usable',
      priority: 40,
      conditions: { all: [{ fact: 'hasAnyField', operator: 'equal', value: false }] },
      action: { type: 'stop', reply: 'none' },
    },

    // event_task_routing: date+time -> Calendar, date-only/todo-shaped -> tasks.
    // Never an LLM decision.
    {
      familyId,
      ruleType: 'assessment',
      triggerType: 'event_task_routing',
      name: 'event_task_routing:calendar',
      priority: 10,
      conditions: {
        all: [
          { fact: 'hasDate', operator: 'equal', value: true },
          { fact: 'hasTime', operator: 'equal', value: true },
        ],
      },
      action: { type: 'route_calendar' },
    },
    {
      familyId,
      ruleType: 'assessment',
      triggerType: 'event_task_routing',
      name: 'event_task_routing:tasks',
      priority: 20,
      conditions: { all: [{ fact: 'hasDate', operator: 'equal', value: true }] },
      action: { type: 'route_tasks' },
    },
  ];
}

export async function seedDefaultRules(familyId, pool) {
  const created = [];
  for (const def of defaultRuleDefinitions(familyId)) {
    created.push(await rulesRepo.create(def, pool));
  }
  return created;
}
