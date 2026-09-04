// C1 — standing rules taught in conversation. Per D-3: the LLM detects rule
// intent AND articulates rule_text in one call; the rule is held as a
// pending DB record; the yes/no confirmation is matched directly against
// that record, never a second LLM call; rules are reviewable/deletable only
// via a bot command.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeCalendar, createFakeMessenger, createFakeLlm } from '../setup/fakes.js';
import { handleIncomingMessage } from '../../src/pipeline/pipeline.js';
import * as standingRulesRepo from '../../src/repositories/standingRules.js';
import { isYesNoAnswer, matchCommand } from '../../src/pipeline/commands.js';
import { applyStandingRuleDefaults, formatRulesList } from '../../src/pipeline/classify.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('isYesNoAnswer: a closed word list only, nothing else', () => {
  assert.equal(isYesNoAnswer('yes'), 'yes');
  assert.equal(isYesNoAnswer('Yes!'), 'yes');
  assert.equal(isYesNoAnswer('כן'), 'yes');
  assert.equal(isYesNoAnswer('no'), 'no');
  assert.equal(isYesNoAnswer('nope.'), 'no');
  assert.equal(isYesNoAnswer('yes please add it'), null, 'a real sentence, not a bare yes/no, must not match');
  assert.equal(isYesNoAnswer(''), null);
});

test('matchCommand: "rules" variants and "delete rule N"', () => {
  assert.equal(matchCommand('rules'), 'list_rules');
  assert.equal(matchCommand('my rules'), 'list_rules');
  assert.equal(matchCommand('Show my rules'), 'list_rules');
  assert.deepEqual(matchCommand('delete rule 2'), { type: 'delete_rule', index: 2 });
  assert.deepEqual(matchCommand('forget rule 10'), { type: 'delete_rule', index: 10 });
  assert.equal(matchCommand('Dance class Friday'), null);
});

test('formatRulesList: empty vs. a numbered list', () => {
  assert.match(formatRulesList([]), /No standing rules yet/);
  const list = formatRulesList([{ rule_text: 'Art therapy is always at the Rothschild clinic' }, { rule_text: 'Never remind before 07:00' }]);
  assert.match(list, /^Your standing rules:/);
  assert.match(list, /1\. Art therapy is always at the Rothschild clinic/);
  assert.match(list, /2\. Never remind before 07:00/);
});

test('applyStandingRuleDefaults fills a gap but never overrides an explicit field', () => {
  const rules = [{ match_keyword: 'art therapy', field: 'location', value: 'Rothschild clinic' }];
  const filled = applyStandingRuleDefaults({ title: 'Art therapy', location: null }, 'Art therapy Tuesday 4pm', rules);
  assert.equal(filled.location, 'Rothschild clinic');
  const untouched = applyStandingRuleDefaults({ title: 'Art therapy', location: 'Downtown studio' }, 'Art therapy Tuesday 4pm', rules);
  assert.equal(untouched.location, 'Downtown studio', 'an explicit location in the message always wins over a taught default');
});

test('a rule-defining message parks a pending rule and asks for yes/no — nothing is written, nothing is committed yet', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'art therapy is always at the Rothschild clinic': {
      type: 'rule',
      rule_text: 'Art therapy will always be located at the Rothschild clinic.',
      rule_kind: 'event_default', field: 'location', match_keyword: 'art therapy', value: 'Rothschild clinic',
      param_name: null, param_value: null,
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'art therapy is always at the Rothschild clinic', externalMessageId: 'wamid.r1' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(result.outcome, 'rule_pending');
  assert.match(messenger.sent[0].text, /Rothschild clinic/);
  assert.match(messenger.sent[0].text, /yes or no/i);

  const pending = await standingRulesRepo.findRecentPending({ familyId: family.id, senderIdentifier: knownSender }, pool);
  assert.ok(pending, 'a real pending row exists');
  assert.equal(pending.status, 'pending');

  const active = await standingRulesRepo.findActiveByKind({ familyId: family.id, ruleKind: 'event_default' }, pool);
  assert.equal(active.length, 0, 'not active yet — confirmation still pending');
});

test('replying "yes" confirms the pending rule WITHOUT a second LLM call, and it applies to the next matching message', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'art therapy is always at the Rothschild clinic': {
      type: 'rule',
      rule_text: 'Art therapy will always be located at the Rothschild clinic.',
      rule_kind: 'event_default', field: 'location', match_keyword: 'art therapy', value: 'Rothschild clinic',
      param_name: null, param_value: null,
    },
    'Art therapy Tuesday 4pm': {
      title: 'Art therapy', date: '2026-09-08', time: '16:00', end_time: null, person: null, category: 'appointment',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🎨',
    },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'art therapy is always at the Rothschild clinic', externalMessageId: 'wamid.r2' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  const confirmResult = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'yes', externalMessageId: 'wamid.r3' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );

  assert.equal(confirmResult.outcome, 'rule_confirmed');
  assert.equal(llm.calls.length, 1, 'the yes/no reply itself must never trigger a second LLM call');
  assert.match(messenger.sent[1].text, /remember/i);

  const writeResult = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Art therapy Tuesday 4pm', externalMessageId: 'wamid.r4' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(writeResult.outcome, 'written');
  const written = calendar.events.get(writeResult.eventRef.external_id);
  assert.equal(written.location, 'Rothschild clinic', 'the confirmed rule applied its default to a later matching message');
});

test('replying "no" discards the pending rule — it never applies, and a bare "no" with nothing pending falls through untouched', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  const llm = createFakeLlm({
    'art therapy is always at the Rothschild clinic': {
      type: 'rule',
      rule_text: 'Art therapy will always be located at the Rothschild clinic.',
      rule_kind: 'event_default', field: 'location', match_keyword: 'art therapy', value: 'Rothschild clinic',
      param_name: null, param_value: null,
    },
    // A bare "no" with no pending proposal at all is just an ordinary
    // message and must still go through normal extraction — asserted by
    // the second call below, which has nothing pending by then.
    no: {
      title: null, date: null, time: null, end_time: null, person: null, category: null,
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '📌',
    },
  });

  await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'art therapy is always at the Rothschild clinic', externalMessageId: 'wamid.r5' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  const discardResult = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'no', externalMessageId: 'wamid.r6' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(discardResult.outcome, 'rule_discarded');
  assert.equal(llm.calls.length, 1, 'still just the one call from proposing the rule — discarding itself never calls the LLM');

  const active = await standingRulesRepo.findActiveByKind({ familyId: family.id, ruleKind: 'event_default' }, pool);
  assert.equal(active.length, 0);

  // Nothing pending now — a second bare "no" is just an ordinary message.
  const plain = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'no', externalMessageId: 'wamid.r7' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  assert.equal(llm.calls.length, 2, 'with nothing pending, a bare "no" goes through normal extraction (the 2nd real LLM call)');
  assert.equal(plain.outcome, 'stopped');
});

test('"rules" lists active rules, and "delete rule N" removes the right one by that same numbering', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  await standingRulesRepo.create({ familyId: family.id, ruleText: 'Rule one', ruleKind: 'event_default', matchKeyword: 'x', field: 'location', value: 'Y', senderIdentifier: knownSender }, pool)
    .then((r) => standingRulesRepo.confirm(r.id, pool));
  await standingRulesRepo.create({ familyId: family.id, ruleText: 'Rule two', ruleKind: 'event_default', matchKeyword: 'z', field: 'location', value: 'W', senderIdentifier: knownSender }, pool)
    .then((r) => standingRulesRepo.confirm(r.id, pool));

  const listed = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'rules', externalMessageId: 'wamid.r8' },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM for a command'); }, calendar, messenger }
  );
  assert.equal(listed.rules.length, 2);
  assert.match(messenger.sent[0].text, /1\. Rule one/);
  assert.match(messenger.sent[0].text, /2\. Rule two/);

  const deleted = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'delete rule 1', externalMessageId: 'wamid.r9' },
    { pool, llmExtract: async () => { throw new Error('must not call the LLM for a command'); }, calendar, messenger }
  );
  assert.equal(deleted.deleted.rule_text, 'Rule one');

  const remaining = await standingRulesRepo.findActiveForFamily(family.id, pool);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].rule_text, 'Rule two');
});

test('a duration_minutes standing rule fills in a default duration only when no explicit end_time was given', async () => {
  const { family, knownSender } = await seedFamily(pool);
  const calendar = createFakeCalendar();
  const messenger = createFakeMessenger();
  await standingRulesRepo.create(
    { familyId: family.id, ruleText: 'Therapy sessions are always 50 minutes.', ruleKind: 'event_default', matchKeyword: 'therapy', field: 'duration_minutes', value: '50', senderIdentifier: knownSender },
    pool
  ).then((r) => standingRulesRepo.confirm(r.id, pool));

  const llm = createFakeLlm({
    'Therapy Monday 4pm': {
      title: 'Therapy', date: '2026-09-07', time: '16:00', end_time: null, person: null, category: 'appointment',
      location: null, recurrence: null, reminder_requested: false, reminder_datetime: null, audience: 'family', activity_icon: '🩺',
    },
  });

  const result = await handleIncomingMessage(
    { familyId: family.id, senderIdentifier: knownSender, text: 'Therapy Monday 4pm', externalMessageId: 'wamid.r10' },
    { pool, llmExtract: llm.extract, calendar, messenger }
  );
  const written = calendar.events.get(result.eventRef.external_id);
  assert.equal(written.startDateTime, '2026-09-07T16:00:00');
  assert.equal(written.endDateTime, '2026-09-07T16:50:00', '50-minute rule default applied since no explicit end_time was given');
});
