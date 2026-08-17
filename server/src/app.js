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
