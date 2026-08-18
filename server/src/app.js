import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter } from './routes/auth.js';
import { familyRouter } from './routes/family.js';
import { botConfigRouter } from './routes/botConfig.js';
import { dashboardRouter } from './routes/dashboard.js';
import { webhookRouter } from './routes/webhook.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.join(__dirname, '../../web/dist');

export function createApp() {
  const app = express();
  app.use(express.json());
  app.use(
    cookieSession({
      name: 'family-app-session',
      keys: [process.env.SESSION_SECRET || 'dev-only-insecure-secret'],
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    })
  );

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Required by Meta's app-publish checklist for the WhatsApp use case.
  // Plain and honest: this is a personal family tool, not a product with
  // a legal/policy team, but the WhatsApp integration still needs a real,
  // public URL describing what happens to a family's data.
  app.get('/privacy', (req, res) => {
    res.type('html').send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Privacy Policy — Family App</title>
<style>body{font:16px/1.6 -apple-system,system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;color:#222}h1{font-size:24px}h2{font-size:18px;margin-top:28px}</style>
</head><body>
<h1>Privacy Policy</h1>
<p>Family App is a personal household scheduling tool. It is not a commercial product and is not offered
to the general public — it is used only by one family and the people they explicitly add to it.</p>

<h2>What data is collected</h2>
<ul>
<li>Messages, photos, or forwarded emails a family member sends to the WhatsApp bot number, so the app can
extract event/task details (title, date, time, who it's for, category).</li>
<li>Google Calendar access (read/write), used only to create, read, and update events on the family's own
calendar.</li>
<li>Family member profile info entered during setup: name, a chosen color, and an icon.</li>
<li>A log of processed messages and their extraction results, kept so mistaken or duplicate entries can be
undone or corrected.</li>
</ul>

<h2>How it's used</h2>
<p>Solely to turn a forwarded message into a calendar event or task for that family, and to reply confirming
what was added. Nothing is used for advertising, profiling, or any purpose beyond running the family's own
schedule.</p>

<h2>Who has access</h2>
<p>Only the family that set up this instance of the app. Data is not sold, shared with third parties, or
used to train any model.</p>

<h2>Data retention</h2>
<p>Records are soft-deleted (marked removed, not immediately erased) so that undo/correction can work; a
family member can request permanent deletion by contacting the app owner directly.</p>

<h2>Contact</h2>
<p>Questions about this policy or a data deletion request can be sent to the person who set up this
instance of the app for your family.</p>
</body></html>`);
  });

  app.use('/auth', authRouter());
  app.use('/api', familyRouter());
  app.use('/api', botConfigRouter());
  app.use('/api', dashboardRouter());
  app.use('/webhook', webhookRouter());

  // Single-service Railway deploy: this server also serves the built React
  // app, so one `git push` is the whole deploy — no separate static host.
  app.use(express.static(WEB_DIST));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/webhook')) return next();
    res.sendFile(path.join(WEB_DIST, 'index.html'), (err) => {
      if (err) next();
    });
  });

  return app;
}
