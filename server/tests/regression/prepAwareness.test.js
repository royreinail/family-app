// D2 — preparation awareness. Depends on D1 (delivery) and C1 (taught
// associations use the same standing_rules mechanism, rule_kind
// 'prep_association'). D-5: inference from event type is approved but
// always surfaced as a suggestion, never silently written as a task.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeMessenger } from '../setup/fakes.js';
import * as googleCredentialsRepo from '../../src/repositories/googleCredentials.js';
import * as standingRulesRepo from '../../src/repositories/standingRules.js';
import { sweepDailyBriefings } from '../../src/pipeline/briefing.js';
import { inferPrepSuggestions, formatBriefingReply, todayInTimeZone, addDays } from '../../src/pipeline/classify.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('inferPrepSuggestions: a taught association wins over the built-in guess for the same title', () => {
  assert.deepEqual(inferPrepSuggestions('Swimming lesson', []), ['pack a towel and swimsuit'], 'built-in fires with nothing taught');
  const taught = [{ match_keyword: 'swim', value: 'bring the blue towel specifically' }];
  assert.deepEqual(inferPrepSuggestions('Swimming lesson', taught), ['bring the blue towel specifically'], 'taught association wins outright, not merged with the built-in guess');
});

test('inferPrepSuggestions: no match at all returns an empty list, not a guess', () => {
  assert.deepEqual(inferPrepSuggestions('Dentist appointment', []), []);
});

test('formatBriefingReply: a matching event gets a clearly-labeled prep section; a briefing with no matches has none', () => {
  const withPrep = formatBriefingReply([{ summary: 'Swimming', start: { dateTime: '2026-09-05T16:00:00' } }], { dateLabel: '2026-09-05' });
  assert.match(withPrep, /🎒 Possible prep \(a suggestion, not added automatically\):/);
  assert.match(withPrep, /Swimming — pack a towel and swimsuit/);

  const withoutPrep = formatBriefingReply([{ summary: 'Dentist', start: { dateTime: '2026-09-05T09:00:00' } }], { dateLabel: '2026-09-05' });
  assert.doesNotMatch(withoutPrep, /🎒/);
});

test('a real briefing sweep includes a taught prep suggestion for a matching event', async () => {
  const { family, knownSender } = await seedFamily(pool);
  await googleCredentialsRepo.upsert({ familyId: family.id, googleAccountEmail: 'test@example.com', accessToken: 'tok', refreshToken: 'ref', scope: 'x', expiryDate: null }, pool);
  await standingRulesRepo.create(
    { familyId: family.id, ruleText: 'Send the briefing at 00:00.', ruleKind: 'timing_param', paramName: 'briefing_send_time', paramValue: '00:00', senderIdentifier: knownSender },
    pool
  ).then((r) => standingRulesRepo.confirm(r.id, pool));
  await standingRulesRepo.create(
    { familyId: family.id, ruleText: 'Art therapy always needs the signed consent form.', ruleKind: 'prep_association', matchKeyword: 'art therapy', value: 'bring the signed consent form', senderIdentifier: knownSender },
    pool
  ).then((r) => standingRulesRepo.confirm(r.id, pool));

  const tomorrow = addDays(todayInTimeZone(family.timezone), 1);
  const calendar = { listEvents: async () => [{ id: 'e1', summary: 'Art therapy', start: { dateTime: `${tomorrow}T16:00:00` }, extendedProperties: { private: {} } }] };
  const messenger = createFakeMessenger();

  await sweepDailyBriefings({ pool, calendar, messenger });

  assert.equal(messenger.sent.length, 1);
  assert.match(messenger.sent[0].text, /Art therapy — bring the signed consent form/);
});
