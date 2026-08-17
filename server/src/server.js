import 'dotenv/config';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './app.js';
import { sweepDueReminders } from './pipeline/reminders.js';
import * as messengerIntegration from './integrations/messenger.js';

const pool = createPool();
await runMigrations(pool);

const app = createApp();
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Family App server listening on :${port}`));

// Reminder-on-request sweep — the one exception to the no-automatic-reminder
// default. Runs on an interval rather than a cron/queue: realistic scale is
// one household, so this is deliberately the simplest thing that works.
setInterval(() => {
  sweepDueReminders({ pool, messenger: messengerIntegration }).catch((err) =>
    console.error('Reminder sweep failed', err)
  );
}, 60 * 1000);
