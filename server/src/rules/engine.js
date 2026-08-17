// The rule engine — one table (rules), one evaluator (evaluateRules).
// Uses json-rules-engine for condition evaluation (the all/any/not
// boolean-composition convention) rather than hand-rolling that logic.
//
// json-rules-engine's Engine.run() evaluates every loaded rule and fires
// every one that matches — it doesn't stop at the first match. The
// architecture doc requires "first match wins" semantics ("returns the
// first match"), so we evaluate rules one at a time, in priority order, and
// stop as soon as one matches. The condition evaluation itself (all/any/not,
// operators, nested conditions) is still fully delegated to the library —
// only the "stop at first match" loop is our own, and that's trivial
// orchestration, not the boolean logic the library exists to avoid hand-rolling.
import { Engine } from 'json-rules-engine';
import * as rulesRepo from '../repositories/rules.js';

// Hardcoded safety net so the system never has zero behavior even with an
// empty rules table (e.g. a fresh family before defaults are seeded).
const FALLBACK_ACTIONS = {
  duplicate_message: { type: 'allow' },
  unknown_sender: { type: 'allow' },
  extraction_classification: { type: 'stop', reply: 'none' },
  event_task_routing: { type: 'route_tasks' },
};

/**
 * @param {'gate'|'assessment'} ruleType
 * @param {string} triggerType
 * @param {object} context - facts made available to rule conditions
 * @param {{familyId: string, pool?: import('pg').Pool}} opts
 */
export async function evaluateRules(ruleType, triggerType, context, { familyId, pool }) {
  const rules = await rulesRepo.findActive({ familyId, ruleType, triggerType }, pool);

  for (const rule of rules) {
    const engine = new Engine([], { allowUndefinedFacts: true });
    engine.addRule({
      conditions: rule.conditions,
      event: { type: rule.name, params: rule.action },
      priority: 1,
    });
    const { events } = await engine.run(context);
    if (events.length > 0) {
      return { matched: true, rule, action: rule.action };
    }
  }

  return {
    matched: false,
    rule: null,
    action: FALLBACK_ACTIONS[triggerType] ?? { type: 'stop' },
  };
}
