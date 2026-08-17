# Family App — Phase 1 (MVP)

Personal family scheduling app. Mission: lower cognitive overload, manage family routines, create
short-term certainty for kids. See [family-app-architecture.md](family-app-architecture.md) for the
full architecture, data model, and design rationale — this README is just the practical run/deploy guide.

Phase 1 scope: WhatsApp capture → Calendar pipeline with a data-driven rule engine, a read-only kid
dashboard, PIN-gated Settings Home, 7-step onboarding, and a tasks backbone (WhatsApp `list tasks`
only — no dedicated UI yet).

## Stack

- **Backend:** Node.js + Express + Postgres (`server/`)
- **Frontend:** React + Vite (`web/`), served by the same Express app in production
- **Rule engine:** [json-rules-engine](https://www.npmjs.com/package/json-rules-engine)
- **Hosting:** Railway (single service — one `git push` deploys both API and frontend)

## Repo layout

```
server/           Express API, rule engine, capture pipeline, Postgres schema
  src/
    db/           schema.sql (source of truth) + pool.js + migrate.js
    integrations/ thin boundaries: calendar.js, messenger.js, llm.js
    rules/        engine.js (evaluateRules) + defaultRules.js (seed data)
    pipeline/      commands.js, classify.js, reminders.js, pipeline.js
    repositories/ one file per table
    routes/        auth, family, botConfig, dashboard, webhook
  tests/
    fixtures/acceptance.test.js   the 7 required acceptance fixtures
    setup/                        pg-mem in-memory Postgres + fakes for LLM/calendar/messenger
  scripts/devPreview.js           local-only: boots the app against pg-mem, no real credentials needed

web/              React app (Vite)
  src/
    theme/         tokens.js (single source of truth for design tokens) + scheduleLogic.js
    api/client.js  the one shared data-fetching layer
    context/        FamilyContext (plain Context, no Redux)
    components/     shared primitives (PinPad, PrimaryButton, PhoneFrame, ProgressDots)
    features/
      onboarding/   7 step components + OnboardingFlow controller
      kid-dashboard/ TomorrowBoard, ActivityCard, BookendIcon, SettingsGear
      settings/     PinGate, SettingsHome, SettingsPage (reuses onboarding step components in edit mode)

Tomorrow's Schedule for Young Children/   Approved Claude Design mocks (visual source of truth)
```

## Local development

You need Node 20+ and a Postgres database (or use the in-memory dev preview below, which needs neither).

```bash
npm install                 # installs both workspaces (server + web)
cp server/.env.example server/.env   # fill in DATABASE_URL at minimum
npm run migrate             # applies server/src/db/schema.sql
npm run dev:server          # http://localhost:3000
npm run dev:web             # http://localhost:5173, proxies /api,/auth,/webhook to :3000
```

### No Postgres / no Google / no WhatsApp credentials handy?

`server/scripts/devPreview.js` boots the real Express app against an in-memory Postgres
(`pg-mem`) and adds two dev-only routes (`/dev/fake-signin`, `/dev/fake-calendar-connect`) so you can
click through onboarding, the kid dashboard, and Settings Home without any real credentials. It is
never imported by `src/app.js` or `src/server.js`, so it has zero footprint in production.

```bash
node server/scripts/devPreview.js   # :3000, in-memory DB
npm run dev:web                     # :5173
```
The Sign-in and Connect-calendar onboarding steps show a small "(dev preview: skip …)" link — only
rendered when `import.meta.env.DEV` is true, so it's stripped out of production builds entirely.

## Tests

```bash
npm test
```

Runs `server/tests/fixtures/acceptance.test.js` — the 7 required acceptance fixtures — plus a smoke
test, using Node's built-in test runner and an in-memory Postgres (`pg-mem`), so no real database or
API keys are needed. Every fixture asserts both the outcome and which rule fired, matching the
architecture doc's testing philosophy: these must keep passing as the `rules` table changes later.

## Deploying to Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. Attach Railway's managed Postgres plugin to the service — it sets `DATABASE_URL` automatically.
4. Set the remaining environment variables from `server/.env.example` in the Railway service settings
   (Google OAuth, WhatsApp System User token, `ANTHROPIC_API_KEY`, `SESSION_SECRET`, etc.). Never commit
   real values — `.env` is gitignored.
5. Railway picks up `railway.json` at the repo root: `npm run build` (builds the React app) then
   `npm start` (runs `server/src/server.js`, which applies `schema.sql` on boot and serves the built
   frontend). One `git push` redeploys both.
6. Point the WhatsApp Cloud API webhook at `https://<your-railway-domain>/webhook/whatsapp`, using the
   same value as `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
7. Point the Google OAuth redirect URI at `https://<your-railway-domain>/auth/google/callback`.

No manual server config beyond those environment variables — the schema migration and static-file
serving both happen automatically on boot.
