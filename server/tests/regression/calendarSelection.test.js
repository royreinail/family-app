// Regression coverage for backlog 2.1 (let a family choose which Google
// Calendar event writes target). Exercises the actual persistence entry
// point the route calls (googleCredentialsRepo.setCalendarId) rather than
// the Google API call itself (listCalendars hits the real googleapis SDK,
// same as dashboard.js's listEvents — untested for the same reason: there's
// nothing to fake at that boundary without a real Google account, and the
// integration layer is a thin, directly-reviewable pass-through).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import * as familiesRepo from '../../src/repositories/families.js';
import * as googleCredentialsRepo from '../../src/repositories/googleCredentials.js';

let pool, family;

beforeEach(async () => {
  pool = createTestPool();
  setPool(pool);
  family = await familiesRepo.create({ name: 'Calendar Test Family' }, pool);
});

test('setCalendarId returns null when the family has not connected Google Calendar yet', async () => {
  const result = await googleCredentialsRepo.setCalendarId(family.id, 'work@group.calendar.google.com', pool);
  assert.equal(result, null, 'route uses this to answer 404 instead of silently no-op-ing');
});

test('setCalendarId updates the target calendar without touching stored tokens', async () => {
  await googleCredentialsRepo.upsert(
    { familyId: family.id, googleAccountEmail: 'parent@example.com', accessToken: 'access-1', refreshToken: 'refresh-1', scope: 'calendar' },
    pool
  );

  const updated = await googleCredentialsRepo.setCalendarId(family.id, 'shared-family@group.calendar.google.com', pool);
  assert.equal(updated.calendar_id, 'shared-family@group.calendar.google.com');
  assert.equal(updated.access_token, 'access-1', 'must not disturb the existing OAuth tokens');
  assert.equal(updated.refresh_token, 'refresh-1');

  const persisted = await googleCredentialsRepo.findByFamilyId(family.id, pool);
  assert.equal(persisted.calendar_id, 'shared-family@group.calendar.google.com');
});

// Real production bug: "still logged on my calendar, not the family
// calendar" — Roy had explicitly selected the family calendar, and it kept
// reverting. Root cause: auth.js's OAuth callback calls upsert() on *every*
// round-trip (first connect, a reconnect after a dead refresh token, any
// later re-sign-in) and never passes calendarId — upsert() used to default
// that to 'primary' and write it unconditionally, so a routine reconnect
// silently discarded whatever the family had picked in Settings, with zero
// notification. This is the exact real-world sequence: select, then
// reconnect (mirrors auth.js's callback, which never passes calendarId).
test('a later upsert() (e.g. a reconnect after token expiry) preserves an explicitly-selected calendar, not just fresh tokens', async () => {
  await googleCredentialsRepo.upsert(
    { familyId: family.id, googleAccountEmail: 'parent@example.com', accessToken: 'access-1', refreshToken: 'refresh-1', scope: 'calendar' },
    pool
  );
  await googleCredentialsRepo.setCalendarId(family.id, 'shared-family@group.calendar.google.com', pool);

  // Same account reconnecting (auth.js's real call shape — no calendarId).
  const reconnected = await googleCredentialsRepo.upsert(
    { familyId: family.id, googleAccountEmail: 'parent@example.com', accessToken: 'access-2', refreshToken: 'refresh-2', scope: 'calendar' },
    pool
  );
  assert.equal(reconnected.access_token, 'access-2', 'the reconnect itself must still take effect');
  assert.equal(
    reconnected.calendar_id,
    'shared-family@group.calendar.google.com',
    'reconnecting must not silently reset the calendar selection back to \'primary\''
  );

  const persisted = await googleCredentialsRepo.findByFamilyId(family.id, pool);
  assert.equal(persisted.calendar_id, 'shared-family@group.calendar.google.com');
});

test('a brand-new connection (no existing row) still defaults to \'primary\' when no calendar is specified', async () => {
  const created = await googleCredentialsRepo.upsert(
    { familyId: family.id, googleAccountEmail: 'parent@example.com', accessToken: 'a', refreshToken: 'a', scope: 'calendar' },
    pool
  );
  assert.equal(created.calendar_id, 'primary');
});

test('setCalendarId only affects the calling family, never another family\'s credentials', async () => {
  const otherFamily = await familiesRepo.create({ name: 'Other Family' }, pool);
  await googleCredentialsRepo.upsert(
    { familyId: family.id, googleAccountEmail: 'a@example.com', accessToken: 'a', refreshToken: 'a', scope: 'calendar' },
    pool
  );
  await googleCredentialsRepo.upsert(
    { familyId: otherFamily.id, googleAccountEmail: 'b@example.com', accessToken: 'b', refreshToken: 'b', scope: 'calendar' },
    pool
  );

  await googleCredentialsRepo.setCalendarId(family.id, 'new-calendar@group.calendar.google.com', pool);

  const otherCreds = await googleCredentialsRepo.findByFamilyId(otherFamily.id, pool);
  assert.equal(otherCreds.calendar_id, 'primary', 'the other family\'s calendar selection must be untouched');
});
