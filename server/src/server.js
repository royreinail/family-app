import 'dotenv/config';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createApp } from './app.js';
import { sweepDueReminders } from './pipeline/reminders.js';
import { sweepDailyBriefings } from './pipeline/briefing.js';
import * as messengerIntegration from './integrations/messenger.js';
import * as calendarIntegration from './integrations/calendar.js';

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

// D1 — proactive daily briefing. Same interval-sweep infrastructure as the
// reminder sweep just above (see briefing.js for why); each tick is cheap
// no-op work for every family that isn't due yet (shouldSendBriefingNow).
setInterval(() => {
  sweepDailyBriefings({ pool, calendar: calendarIntegration, messenger: messengerIntegration }).catch((err) =>
    console.error('Daily briefing sweep failed', err)
  );
}, 60 * 1000);
