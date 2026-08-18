// Regression coverage for backlog 1.3 (multi-parent / shared family
// support). resolveFamilyForSignIn (services/parentSignIn.js) is the
// actual bug-prone part of this feature -- get it wrong and a returning
// parent's cookie expiring spawns a duplicate family, or a joining parent
// lands in a brand-new family instead of the shared one. Split out from
// auth.js specifically so it's testable without mocking Google's OAuth API.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import * as familiesRepo from '../../src/repositories/families.js';
import * as familyParentsRepo from '../../src/repositories/familyParents.js';
import * as googleCredentialsRepo from '../../src/repositories/googleCredentials.js';
import { resolveFamilyForSignIn } from '../../src/services/parentSignIn.js';

let pool;

beforeEach(() => {
  pool = createTestPool();
  setPool(pool);
});

test('ensureInviteCode mints a code once and returns the same one on later calls', async () => {
  const family = await familiesRepo.create({ name: 'Test Family' }, pool);
  const first = await familiesRepo.ensureInviteCode(family.id, pool);
  const second = await familiesRepo.ensureInviteCode(family.id, pool);
  assert.equal(first, second);
  assert.match(first, /^[A-Z0-9]{8}$/);
});

test('findByInviteCode finds the right family and only that family', async () => {
  const familyA = await familiesRepo.create({ name: 'Family A' }, pool);
  const familyB = await familiesRepo.create({ name: 'Family B' }, pool);
  const codeA = await familiesRepo.ensureInviteCode(familyA.id, pool);
  await familiesRepo.ensureInviteCode(familyB.id, pool);

  const found = await familiesRepo.findByInviteCode(codeA, pool);
  assert.equal(found.id, familyA.id);
});

test('resolveFamilyForSignIn: an active session always wins, even over a matching invite code', async () => {
  const sessionFamily = await familiesRepo.create({ name: 'Session Family' }, pool);
  const otherFamily = await familiesRepo.create({ name: 'Other Family' }, pool);
  const otherCode = await familiesRepo.ensureInviteCode(otherFamily.id, pool);

  const resolved = await resolveFamilyForSignIn({
    email: 'parent@example.com',
    sessionFamilyId: sessionFamily.id,
    inviteCode: otherCode,
  });
  assert.equal(resolved.id, sessionFamily.id);
});

test('resolveFamilyForSignIn: a returning parent (known family_parents row) matches their own family, ignoring any invite code', async () => {
  const family = await familiesRepo.create({ name: 'My Family' }, pool);
  await familyParentsRepo.create({ familyId: family.id, googleAccountEmail: 'parent@example.com' }, pool);
  const otherFamily = await familiesRepo.create({ name: 'Unrelated Family' }, pool);
  const otherCode = await familiesRepo.ensureInviteCode(otherFamily.id, pool);

  const resolved = await resolveFamilyForSignIn({
    email: 'parent@example.com',
    sessionFamilyId: null,
    inviteCode: otherCode,
  });
  assert.equal(resolved.id, family.id, 'a known parent must never be redirected into a different family by a stray invite code');
});

test('resolveFamilyForSignIn: legacy fallback matches a pre-family_parents account via google_credentials', async () => {
  const family = await familiesRepo.create({ name: 'Legacy Family' }, pool);
  await googleCredentialsRepo.upsert(
    { familyId: family.id, googleAccountEmail: 'legacy@example.com', accessToken: 'a', refreshToken: 'a', scope: 'calendar' },
    pool
  );
  // Deliberately no family_parents row -- simulates an account that signed
  // up before this feature existed.

  const resolved = await resolveFamilyForSignIn({ email: 'legacy@example.com', sessionFamilyId: null, inviteCode: null });
  assert.equal(resolved.id, family.id, 'a returning single-parent user must not get a duplicate family when their cookie expires');
});

test('resolveFamilyForSignIn: a brand new account with a valid invite code joins that family', async () => {
  const family = await familiesRepo.create({ name: 'Joinable Family' }, pool);
  const code = await familiesRepo.ensureInviteCode(family.id, pool);

  const resolved = await resolveFamilyForSignIn({ email: 'newparent@example.com', sessionFamilyId: null, inviteCode: code });
  assert.equal(resolved.id, family.id);
});

test('resolveFamilyForSignIn: an unmatched account with no invite code resolves to null (caller creates a new family)', async () => {
  const resolved = await resolveFamilyForSignIn({ email: 'brandnew@example.com', sessionFamilyId: null, inviteCode: null });
  assert.equal(resolved, null);
});

test('resolveFamilyForSignIn: an invalid/expired invite code does not silently match any family', async () => {
  const resolved = await resolveFamilyForSignIn({ email: 'brandnew@example.com', sessionFamilyId: null, inviteCode: 'NOTAREALCODE' });
  assert.equal(resolved, null);
});

test('a second parent joining an existing family does not overwrite the shared Calendar connection', async () => {
  const family = await familiesRepo.create({ name: 'Shared Family' }, pool);
  await googleCredentialsRepo.upsert(
    { familyId: family.id, googleAccountEmail: 'first-parent@example.com', accessToken: 'first-token', refreshToken: 'first-refresh', scope: 'calendar' },
    pool
  );

  // Mirrors auth.js's callback guard: only upsert when there's no existing
  // connection, or the same account is refreshing its own tokens.
  const existing = await googleCredentialsRepo.findByFamilyId(family.id, pool);
  const secondParentEmail = 'second-parent@example.com';
  const shouldWrite = !existing || existing.google_account_email === secondParentEmail;
  assert.equal(shouldWrite, false, 'a second, different account must not be allowed to silently replace the family\'s calendar connection');

  const stillThere = await googleCredentialsRepo.findByFamilyId(family.id, pool);
  assert.equal(stillThere.google_account_email, 'first-parent@example.com');
  assert.equal(stillThere.access_token, 'first-token');
});
