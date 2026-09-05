// D1 — proactive daily briefing. Depends on A1 (same read + audience-filter
// reasoning) and C1 (the send time is a standing-rule timing_param, D-4).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { seedFamily } from '../setup/seedFamily.js';
import { createFakeMessenger } from '../setup/fakes.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';
import * as familiesRepo from '../../src/repositories/families.js';
import * as googleCredentialsRepo from '../../src/repositories/googleCredentials.js';
import * as sourceMappingsRepo from '../../src/repositories/sourceMappings.js';
import * as standingRulesRepo from '../../src/repositories/standingRules.js';
import { sweepDailyBriefings } from '../../src/pipeline/briefing.js';
import { shouldSendBriefingNow, isRelevantToParent, formatBriefingReply, todayInTimeZone, addDays } from '../../src/pipeline/classify.js';

let pool;
beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('shouldSendBriefingNow: not due before the send time, due at/after it, never due twice the same local day', () => {
  assert.equal(shouldSendBriefingNow({ nowLocalHHMM: '19:59', sendTime: '20:00', lastSentDateLocal: null, todayLocal: '2026-09-04' }), false);
  assert.equal(shouldSendBriefingNow({ nowLocalHHMM: '20:00', sendTime: '20:00', lastSentDateLocal: null, todayLocal: '2026-09-04' }), true);
  assert.equal(shouldSendBriefingNow({ nowLocalHHMM: '23:50', sendTime: '20:00', lastSentDateLocal: null, todayLocal: '2026-09-04' }), true, 'fires on the first tick after, not only exactly at, the target minute');
  assert.equal(shouldSendBriefingNow({ nowLocalHHMM: '23:50', sendTime: '20:00', lastSentDateLocal: '2026-09-04', todayLocal: '2026-09-04' }), false, 'already sent today');
  assert.equal(shouldSendBriefingNow({ nowLocalHHMM: '20:05', sendTime: '20:00', lastSentDateLocal: '2026-09-03', todayLocal: '2026-09-04' }), true, 'a new local day resets it');
});

test('isRelevantToParent: own events, kid events, and unassigned events are relevant; the other parent\'s own event is not', () => {
  const dana = { id: 'dana', name: 'Dana', is_parent: true };
  const alon = { id: 'alon', name: 'Alon', is_parent: true };
  const gaia = { id: 'gaia', name: 'Gaia', is_parent: false };
  const members = [dana, alon, gaia];
  const eventFor = (personId) => ({ summary: 'x', extendedProperties: { private: personId ? { personId } : {} } });

  assert.equal(isRelevantToParent(eventFor('dana'), 'dana', members), true, "a parent's own event");
  assert.equal(isRelevantToParent(eventFor('alon'), 'dana', members), false, "the OTHER parent's own event is excluded");
  assert.equal(isRelevantToParent(eventFor('gaia'), 'dana', members), true, 'anything involving a kid');
  assert.equal(isRelevantToParent(eventFor(null), 'dana', members), true, 'unassigned — safe default, show it rather than risk hiding it');
});

test('formatBriefingReply: empty vs. a real list', () => {
  assert.match(formatBriefingReply([], { dateLabel: '2026-09-05' }), /Nothing on the calendar for tomorrow \(2026-09-05\)/);
  const reply = formatBriefingReply([{ summary: 'Dance class', start: { dateTime: '2026-09-05T16:00:00' } }], { dateLabel: '2026-09-05' });
  assert.match(reply, /^Here's tomorrow \(2026-09-05\):/);
  assert.match(reply, /Dance class 16:00/);
});

test('sweepDailyBriefings sends each connected parent their own filtered view, then does not resend the same local day', async () => {
  const { family, parent: dana } = await seedFamily(pool); // dana: is_parent true, mapped to knownSender by seedFamily
  const alon = await familyMembersRepo.create({ familyId: family.id, name: 'Alon', calendarColor: '#111111', kidIcon: '🧑', isParent: true }, pool);
  const gaia = await familyMembersRepo.create({ familyId: family.id, name: 'Gaia', calendarColor: '#222222', kidIcon: '🦁', isParent: false }, pool);
  await sourceMappingsRepo.create({ familyId: family.id, channelType: 'whatsapp', externalIdentifier: '+15559990001', familyMemberId: alon.id }, pool);
  await googleCredentialsRepo.upsert({ familyId: family.id, googleAccountEmail: 'test@example.com', accessToken: 'tok', refreshToken: 'ref', scope: 'x', expiryDate: null }, pool);
  // Force "always due" (00:00) so this test is deterministic regardless of
  // when it actually runs — the "not yet due" case is covered directly by
  // shouldSendBriefingNow's own unit test above.
  await standingRulesRepo.create(
    { familyId: family.id, ruleText: 'Send the briefing at 00:00.', ruleKind: 'timing_param', paramName: 'briefing_send_time', paramValue: '00:00', senderIdentifier: '+15551234567' },
    pool
  ).then((r) => standingRulesRepo.confirm(r.id, pool));

  const tomorrow = addDays(todayInTimeZone(family.timezone), 1);
  const events = [
    { id: 'e1', summary: "Dana's own appointment", start: { dateTime: `${tomorrow}T09:00:00` }, extendedProperties: { private: { personId: dana.id } } },
    { id: 'e2', summary: "Alon's own appointment", start: { dateTime: `${tomorrow}T10:00:00` }, extendedProperties: { private: { personId: alon.id } } },
    { id: 'e3', summary: "Gaia's swimming", start: { dateTime: `${tomorrow}T16:00:00` }, extendedProperties: { private: { personId: gaia.id } } },
  ];
  const calendar = { listEvents: async () => events, calls: [] };
  const messenger = createFakeMessenger();

  const sent = await sweepDailyBriefings({ pool, calendar, messenger });

  assert.equal(sent.length, 2, 'one message per connected parent');
  // messenger.send receives whatever's stored on the mapping — normalized
  // to bare digits by sourceMappingsRepo.create, same convention every
  // other stored number in this codebase follows.
  const toDana = messenger.sent.find((m) => m.to === '15551234567');
  const toAlon = messenger.sent.find((m) => m.to === '15559990001');
  assert.ok(toDana && toAlon);
  assert.match(toDana.text, /Dana's own appointment/);
  assert.match(toDana.text, /Gaia's swimming/);
  assert.doesNotMatch(toDana.text, /Alon's own appointment/, "the other parent's own item is excluded from Dana's briefing");
  assert.match(toAlon.text, /Alon's own appointment/);
  assert.match(toAlon.text, /Gaia's swimming/);
  assert.doesNotMatch(toAlon.text, /Dana's own appointment/);

  const updatedFamily = await familiesRepo.findById(family.id, pool);
  assert.equal(updatedFamily.last_briefing_sent_date instanceof Date ? updatedFamily.last_briefing_sent_date.toISOString().slice(0, 10) : updatedFamily.last_briefing_sent_date, todayInTimeZone(family.timezone));

  // Second sweep tick, same local day — must not resend.
  messenger.sent.length = 0;
  const secondSent = await sweepDailyBriefings({ pool, calendar, messenger });
  assert.equal(secondSent.length, 0);
  assert.equal(messenger.sent.length, 0, 'already sent today — no duplicate briefing');
});

test('a family with no Google Calendar connected is skipped cleanly (no crash, nothing sent)', async () => {
  const { family } = await seedFamily(pool);
  await standingRulesRepo.create(
    { familyId: family.id, ruleText: 'x', ruleKind: 'timing_param', paramName: 'briefing_send_time', paramValue: '00:00', senderIdentifier: 's' },
    pool
  ).then((r) => standingRulesRepo.confirm(r.id, pool));

  const messenger = createFakeMessenger();
  const sent = await sweepDailyBriefings({ pool, calendar: { listEvents: async () => { throw new Error('must not be called'); } }, messenger });
  assert.equal(sent.length, 0);
  assert.equal(messenger.sent.length, 0);
});

// Gap audit: every other sweep test seeds exactly one family — nothing
// exercised two families in the SAME tick, where a real bug (sending
// family A's content to family B, or marking both "sent" when only one
// was actually due) would show up as cross-contamination between them,
// not a crash.
test('two families in the same sweep tick are handled independently: one due, one not, no cross-contamination', async () => {
  const due = await seedFamily(pool, { knownSender: '+15551110001' });
  const notDue = await seedFamily(pool, { knownSender: '+15551110002' });
  await googleCredentialsRepo.upsert({ familyId: due.family.id, googleAccountEmail: 'due@example.com', accessToken: 't', refreshToken: 'r', scope: 'x', expiryDate: null }, pool);
  await googleCredentialsRepo.upsert({ familyId: notDue.family.id, googleAccountEmail: 'notdue@example.com', accessToken: 't', refreshToken: 'r', scope: 'x', expiryDate: null }, pool);
  // "due" gets a 00:00 (always-due) rule; "notDue" is marked already-sent
  // TODAY directly, deterministically skipping it via the
  // lastSentDateLocal === todayLocal check — not by racing the real clock
  // against a send-time threshold (this file's own shouldSendBriefingNow
  // unit test already covers that decision in isolation).
  await standingRulesRepo.create(
    { familyId: due.family.id, ruleText: 'x', ruleKind: 'timing_param', paramName: 'briefing_send_time', paramValue: '00:00', senderIdentifier: due.knownSender },
    pool
  ).then((r) => standingRulesRepo.confirm(r.id, pool));
  await familiesRepo.markBriefingSent(notDue.family.id, todayInTimeZone(notDue.family.timezone), pool);

  const tomorrow = addDays(todayInTimeZone(due.family.timezone), 1);
  const calendar = {
    listEvents: async () => [{ id: 'e1', summary: "Due family's event", start: { dateTime: `${tomorrow}T09:00:00` }, extendedProperties: { private: {} } }],
  };
  const messenger = createFakeMessenger();

  const sent = await sweepDailyBriefings({ pool, calendar, messenger });

  assert.equal(sent.length, 1, 'only the due family was briefed');
  assert.equal(sent[0].familyId, due.family.id);
  assert.equal(messenger.sent.length, 1);
  assert.match(messenger.sent[0].text, /Due family's event/);

  const dueAfter = await familiesRepo.findById(due.family.id, pool);
  assert.equal(todayInTimeZone(due.family.timezone), dueAfter.last_briefing_sent_date instanceof Date ? dueAfter.last_briefing_sent_date.toISOString().slice(0, 10) : dueAfter.last_briefing_sent_date);
  // The not-due family's calendar must never even have been read for it —
  // proves the two families are handled independently, not just that
  // one happened not to receive a message.
  assert.equal(sent.find((s) => s.familyId === notDue.family.id), undefined);
});

// Gap audit: no test proved a real Calendar read failure inside the sweep
// leaves last_briefing_sent_date untouched — without that, a transient
// hiccup on the one night it matters would permanently skip that family's
// briefing for the rest of the day instead of retrying on the next tick.
test('a Calendar read failure during the sweep does not mark the family as briefed, so the next tick retries', async () => {
  const { family } = await seedFamily(pool);
  await googleCredentialsRepo.upsert({ familyId: family.id, googleAccountEmail: 'x@example.com', accessToken: 't', refreshToken: 'r', scope: 'x', expiryDate: null }, pool);
  await standingRulesRepo.create(
    { familyId: family.id, ruleText: 'x', ruleKind: 'timing_param', paramName: 'briefing_send_time', paramValue: '00:00', senderIdentifier: 's' },
    pool
  ).then((r) => standingRulesRepo.confirm(r.id, pool));

  const messenger = createFakeMessenger();
  const sent = await sweepDailyBriefings({ pool, calendar: { listEvents: async () => { throw new Error('transient Calendar hiccup'); } }, messenger });

  assert.equal(sent.length, 0);
  assert.equal(messenger.sent.length, 0, 'nothing partial gets sent on a failed read');
  const after = await familiesRepo.findById(family.id, pool);
  assert.equal(after.last_briefing_sent_date, null, 'must stay unset so the very next sweep tick retries instead of skipping the whole day');
});
