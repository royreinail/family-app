// Local visual QA only — boots the real Express app against an in-memory
// Postgres (pg-mem) instead of a real DATABASE_URL, and adds one dev-only
// fake-sign-in route so the onboarding/dashboard/settings screens can be
// clicked through without real Google/WhatsApp credentials. Never mounted
// in production (see src/app.js / src/server.js, which this file does not
// touch) and not part of the Railway deploy.
import { createTestPool } from '../tests/setup/testDb.js';
import { setPool, getPool } from '../src/db/pool.js';
import { createApp } from '../src/app.js';
import * as familiesRepo from '../src/repositories/families.js';
import * as botConfigRepo from '../src/repositories/botConfig.js';

process.env.SESSION_SECRET = 'dev-preview-secret';

setPool(createTestPool());
const pool = getPool();

const app = createApp();

app.post('/dev/fake-signin', async (req, res) => {
  let familyId = req.session.familyId;
  let family = familyId ? await familiesRepo.findById(familyId, pool) : null;
  if (!family) {
    family = await familiesRepo.create({ name: 'Preview Family' }, pool);
    await botConfigRepo.create({ familyId: family.id, botDisplayNumber: '+1 (415) 555-0148' }, pool);
  }
  req.session.familyId = family.id;
  res.json({ ok: true });
});

// Fake calendar connection too, since real OAuth can't run in this preview.
app.post('/dev/fake-calendar-connect', async (req, res) => {
  const googleCredentialsRepo = await import('../src/repositories/googleCredentials.js');
  await googleCredentialsRepo.upsert(
    { familyId: req.session.familyId, googleAccountEmail: 'preview@example.com', accessToken: 'fake', refreshToken: 'fake', scope: 'calendar' },
    pool
  );
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Dev preview server (in-memory DB) on :${port}`));
