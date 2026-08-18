// Regression test for a cross-family authorization gap found while building
// edit/remove family member UI (backlog 1.2): familyMembersRepo.update and
// .softDelete originally only filtered by the member's own `id`, not by
// `family_id`. Since PUT/DELETE /family-members/:id only require a verified
// PIN (not proof the member belongs to the caller's family), any signed-in
// family that learned another family's member id could edit or delete that
// member. Both functions now take an explicit familyId and scope the SQL to
// it, returning null/false (not silently touching the wrong row) on mismatch.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import * as familiesRepo from '../../src/repositories/families.js';
import * as familyMembersRepo from '../../src/repositories/familyMembers.js';

let pool, familyA, familyB, memberOfA;

beforeEach(async () => {
  pool = createTestPool();
  setPool(pool);
  familyA = await familiesRepo.create({ name: 'Family A' }, pool);
  familyB = await familiesRepo.create({ name: 'Family B' }, pool);
  memberOfA = await familyMembersRepo.create(
    { familyId: familyA.id, name: 'Alex', calendarColor: '#7986cb', kidIcon: '🦄' },
    pool
  );
});

test('update() refuses to modify a member belonging to a different family', async () => {
  const result = await familyMembersRepo.update(memberOfA.id, familyB.id, { name: 'Hijacked' }, pool);
  assert.equal(result, null, 'must not return/modify a row that belongs to another family');

  const stillA = await familyMembersRepo.findById(memberOfA.id, pool);
  assert.equal(stillA.name, 'Alex', 'the real family member must be unchanged');
});

test('update() succeeds when the member does belong to the caller\'s family', async () => {
  const result = await familyMembersRepo.update(memberOfA.id, familyA.id, { name: 'Alexandra' }, pool);
  assert.equal(result.name, 'Alexandra');
});

test('softDelete() refuses to delete a member belonging to a different family', async () => {
  const removed = await familyMembersRepo.softDelete(memberOfA.id, familyB.id, pool);
  assert.equal(removed, false, 'must report failure rather than deleting the wrong family\'s member');

  const stillThere = await familyMembersRepo.findById(memberOfA.id, pool);
  assert.ok(stillThere, 'the real family member must still exist');
});

test('softDelete() succeeds when the member does belong to the caller\'s family', async () => {
  const removed = await familyMembersRepo.softDelete(memberOfA.id, familyA.id, pool);
  assert.equal(removed, true);

  const gone = await familyMembersRepo.findById(memberOfA.id, pool);
  assert.equal(gone, null, 'findById excludes soft-deleted rows');
});
