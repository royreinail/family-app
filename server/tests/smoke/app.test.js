// Smoke test — the Express app boots, mounts routes, and responds, wired to
// the same in-memory test DB used by the acceptance fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createTestPool } from '../setup/testDb.js';
import { setPool } from '../../src/db/pool.js';
import { createApp } from '../../src/app.js';

test('app boots and /healthz responds', async () => {
  setPool(createTestPool());
  process.env.SESSION_SECRET = 'test-secret';
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { ok: true });

  const sessionRes = await fetch(`http://127.0.0.1:${port}/auth/session`);
  assert.equal(sessionRes.status, 200);
  const sessionBody = await sessionRes.json();
  assert.equal(sessionBody.signedIn, false);

  await new Promise((resolve) => server.close(resolve));
});
