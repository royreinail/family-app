# Family App — Architecture & Phased Scope

**Mission:** Lower cognitive overload, help families better manage routines, create short-term certainty for kids.

**Status:** Personal-use project first. Product-viability is a bonus outcome, not the design driver — scope favors "works well for one family fast" over "scales to strangers."

## Core users
- **Parents** — full read/write, sole audience for insights.
- **Kids** — read-only comprehension view (icon + color, no text dependency). No insights, no nudges — kid surface stays pure "what's happening."
- *(Deferred)* Caregiver/grandparent — view-only.
- *(Deferred)* Second parent as an independently-permissioned identity (not just a shared account) — data model should not block this later.

## Design principles (apply across all phases)
1. **Lean on existing trusted tools.** Google Calendar is the calendar. Don't rebuild what's already trusted and synced everywhere — own only the layers that don't exist yet (extraction, kid view, insights, tasks).
2. **One source of truth per data type**, even when it's surfaced through multiple channels (chat digest vs. web view). Push and pull are delivery channels, not separate systems.
3. **Interrupt sparingly.** Prefer tentative/visually-distinct states over approval inboxes. A wrong "conflict" flag is cheap to ignore; a nagging inbox defeats the mission.
4. **Cheapest possible test before each build.** Kid view: test with paper/static page before polish. Hardware: prove the web view works on a propped-up tablet before buying/building a device.
5. **Wireframe/mock before building.** No UI element gets built directly to code. Process for every screen/view in every phase (kid dashboard, task list, parent view toggle, future calendar UI): (a) find existing visual references first — competitor apps, real UI patterns for that type of screen — rather than inventing a layout from a blank page; (b) build a quick static mock grounded in those references; (c) review and iterate on the mock; (d) only once approved, hand it to Claude Code as the reference for the real build. Catches layout/UX problems while they're still cheap to change, and avoids reinventing patterns that already exist and work.
6. **Ground every UX question or debate in a real-world example.** Applies beyond screens — to interaction patterns and design decisions too (e.g. approval-inbox vs. tentative-state, push-digest vs. pull-view, icon-only comprehension for kids). Before deciding from first principles, find how an established product in a similar use case handles it. If nothing matches directly, define the specific functionality needed and find the closest established solution to that functionality, even from an adjacent category — never settle a UX debate purely on internal reasoning when a real precedent exists.

---

## Phase 1 — MVP (build now)

**Scope: A (Capture → Calendar) + B (Kid dashboard)**

### A — Capture → Calendar
- **Intake channels**, unified into one pipeline:
  - Forwarded WhatsApp message (parent manually shares to a dedicated bot chat — not a group participant, no ToS risk)
  - Photo of a flyer/schedule
  - Forwarded email
- **Extraction:** AI parses candidate event/task (title, date, time, person, category, reminder_requested, reminder_datetime) — see Bot mechanism below for the exact schema and why confidence scoring isn't part of it.
- **Write path (validated against real-world precedent — see below):** writes directly to Google Calendar, then the bot immediately replies once with the extracted result for a single glance-confirm ("Dance class, Thurs 4pm — added ✅, tap to edit"). Not a silent add relying on the parent noticing tentative styling later, and not a separate approval inbox — one message, right after capture, closes the loop. Calendar's native `TENTATIVE` status (RFC 5545 — "MAYBE" styling) can still be used for low-confidence extractions, but the default path assumes the AI got it right and surfaces a quick undo/edit rather than asking for upfront approval.
- Real-world precedent: established AI-capture apps in this exact category (Capture2Calendar, Text to Calendar, Smart Calendars AI) consistently use extract-then-review-once rather than either a silent add or a persistent approval queue — this is what that pattern is grounded in.
- **Color-coding:** per family member, carried through from calendar event tagging.
- Google Calendar remains the store for events themselves — no calendar data is duplicated into the app's own database.
- **Reminder policy (applies once tasks exist, from Phase 1 backbone onward):** no automatic WhatsApp reminder just because a task has a due date — validated against real precedent: even dedicated task apps like Todoist default automatic reminders to *off*, specifically to avoid notification fatigue. A task only gets proactively pinged if the parent explicitly asked for a reminder on that task, or if it's flagged really high importance. Regular due-date tasks stay silent until the parent checks the list themselves — consistent with design principle 3 (interrupt sparingly). Scope note: this is a hardcoded default, not a `rules` table entry, even though the rule engine's stated job is "tunable business logic lives in data." Deliberate for Phase 1 — it's a single global default with no per-message classification step, unlike `gate`/`assessment` which run per-message against varying input. If per-family or per-task-type reminder tuning becomes a real need, it's a natural third `rule_type` later, not a reason to touch this now.
- **QA/on-demand access before the Phase 2 UI exists:** the WhatsApp bot supports a "list tasks" command that replies with the current task list as plain text — lets the tasks backbone be tested end to end in Phase 1 without waiting for the Phase 2 web UI to exist.

### Bot mechanism — minimizing AI usage, maximizing determinism

**LLM does exactly one job.** A single call reads raw input (text or image) and returns structured fields only — no confidence score, no routing decision, no reply wording:
```
{ title: string|null, date: string|null, time: string|null, person: string|null, category: string|null, reminder_requested: boolean, reminder_datetime: string|null }
```
Everything downstream is deterministic app code acting on this JSON — keeps behavior testable and avoids the LLM silently doing two jobs (extracting *and* deciding), a common source of inconsistent behavior in agent-built systems. Also minimizes cost — no reasoning-about-policy on every call.

**Commands are intercepted before the LLM is ever called.** "undo," "list tasks," "help" — matched by a cheap string/regex check first. Only messages that don't match a known command reach the extraction call. Prevents a known bug pattern (a command like "undo" getting misread as a calendar event because everything funnels through one generic prompt) and saves the API call entirely for these cases.

**Rule engine — all tunable business/edge-case logic lives in data, not code.** One table, one evaluator function, split into two tiers via `rule_type`:
```
rules table: id, family_id, rule_type ('gate' | 'assessment'), trigger_type, conditions (jsonb), action (jsonb), priority, enabled
```
- **`gate` rules run first, before the LLM is called.** Cheap, deterministic checks that can short-circuit the pipeline entirely — resolve the message directly (no extraction call) or explicitly allow it through. `duplicate_message` and `unknown_sender` live here: no reason to spend an LLM call on a message about to be silently ignored anyway. This tier is also where fast pattern-based shortcuts belong (e.g. "message contains 'grocery' → route straight to shopping list, skip extraction") — and it's deliberately the tier future user-defined rules (Phase 3-5) will extend, kept structurally separate from the system's own classification logic so a user rule can never interfere with core extraction/routing.
- **`assessment` rules run after extraction**, acting on the LLM's structured output: `extraction_classification` (field-presence tiering), `event_task_routing`.

`evaluateRules(ruleType, triggerType, context)` checks enabled rules for that tier/trigger, sorted by priority, returns the first match, falls back to one hardcoded default if nothing matches (system never has zero behavior). Full pipeline order, resolving the relationship with command interception above: **commands check → `gate` rules → LLM → `assessment` rules.** Commands run first and stay outside the rules table entirely, on purpose — they're fixed system behavior ("undo" always means undo), not tunable per-family business policy, so hardcoding them keeps the `gate` tier reserved for actual routing/filtering decisions. This is the same reasoning as keeping exceptions out of the rules table below: two different things that both look like "pre-LLM logic" but aren't the same kind of logic, so they're deliberately separate mechanisms rather than one.

**`conditions` schema — don't invent one.** Structure `conditions` using the `all` / `any` / `not` boolean-composition pattern (e.g. `{"all": [{"fact": "sender", "operator": "in", "value": [...]}]}`) rather than a bespoke format. This is the de facto convention in the JS rule-engine ecosystem (json-rules-engine and equivalents), not something specific to this project — reusing it means Claude Code is filling in a well-trodden schema instead of designing one from scratch. Recommend Claude Code use an actual existing library (json-rules-engine on npm, or the closest equivalent for whatever stack it lands on) for the evaluator itself rather than hand-rolling the boolean logic — this is solved, boring infrastructure and exactly the kind of code that's easy for an agent to get subtly wrong (precedence, null-handling, nested conditions) if built from scratch.

Built as the core mechanism in Phase 1, since it's cheap to build data-driven from the start; the *editing surface* stays minimal (direct DB edit) in Phase 1, a proper admin screen is a natural Phase 2 item, and user-facing rule authoring is a Phase 3-5 idea — the mechanism existing now is what makes that a natural extension later instead of a rewrite. When user-facing authoring ships, it's a **constrained template menu, not freeform JSON** — users pick from pre-validated patterns ("if message contains ___, always assign to ___" / "if from this number, skip extraction") that compile into the same `gate`-tier rule format underneath. Rules editable by someone outside the build process need a validated menu, not a text box; this also keeps user-authored rules structurally confined to the `gate` tier, never able to touch `assessment` logic.

Rule-set scale note: at real household size (~10-20 rules realistic ceiling, even years in), the well-known "rules pile up and tangle" failure mode of larger rule-engine deployments isn't a near-term risk — the mitigation that matters at this scale isn't conflict-detection tooling, it's the acceptance fixtures below actually asserting *which rule fired*, so a rule edit that silently breaks another rule's coverage gets caught by re-running the fixture set. No separate rule-versioning system needed either — an edited rule becomes a new row with the old one soft-deleted, same as everything else in the schema (future-proofing item 9).

Covers:
- `extraction_classification` (assessment) — field-presence tiering, replacing a fuzzy LLM-reported confidence score (unreliable, untestable) with plain logic on which fields came back null:

  | Fields present | Action |
  |---|---|
  | `date` + `time` | Write to Calendar, confirm reply |
  | `date` present, `time` null | Write to `tasks` tentative, Qualify reply asking for time |
  | `date` null | Don't write — Clarify reply asking for a date |
  | Nothing usable | Stop — no reply |
- `event_task_routing` (assessment) — `date`+`time` both present → Calendar; `date` only or to-do-shaped → `tasks`. Never an LLM decision.
- `duplicate_message` (gate) — default rule: `external_message_id` already seen → skip, no reply, no LLM call.
- `unknown_sender` (gate) — default rule: sender not in `bot_config.accepted_chat_ids` → silent ignore, no LLM call.

**`extraction_log` state machine** — replaces ad hoc boolean flags, gives correction/undo a single source of truth:
```
received → extracted → written | needs_clarification | needs_time | stopped | failed
                              ↓
                    corrected | undone
```
- `received`: row created the instant the webhook fires, before *anything else* runs — including the `duplicate_message` gate check — so the write-ahead guarantee is real (a crash mid-request never loses the fact that a message arrived) and the dedupe check itself has something to query against. Concretely: write `received` row → run `duplicate_message` gate (query for a prior row with the same `external_message_id`, excluding this one) → if it matches, this row moves straight to `stopped`, no LLM call. A duplicate still gets logged, it just terminates immediately instead of being silently absent from `extraction_log`.
- `corrected` / `undone`: reached when a later message references this row via WhatsApp's reply/quote metadata (linking back to `extraction_log.id`) — e.g. "no, 5pm" or "undo."

**Exceptions are handled separately from the rule engine, not folded into it.** Rules answer "given valid input, what should happen" (tunable business policy); exceptions are technical failures (LLM timeout, Calendar API error) with no meaningful "rule" to write — just retry with backoff, then a `failed` state on the `extraction_log` row, no silent data loss. Deliberately kept out of the rules table so a transient API blip is never confused with an intentional business decision.

**Acceptance fixtures** — concrete input→output pairs as literal test cases, since coding agents have a documented bias toward satisfying a rule's literal wording while missing the edge case that motivated it. Each fixture asserts both the outcome *and* which rule produced it (`rule_id` / rule name), not just the extraction result — so a future rule edit that silently changes which rule wins on an existing case is caught by re-running this table, not discovered in production:

| Input | Expected outcome | Rule that should fire |
|---|---|---|
| "Dance class Thursday 4pm" | date+time present → write to Calendar, confirm reply | `extraction_classification` (date+time) |
| "Bring $10 for the field trip by Friday" | date, no time → write to `tasks` tentative, qualify reply | `extraction_classification` (date only) |
| "thanks!" | nothing extractable → stop, no reply | `extraction_classification` (nothing usable) |
| Same WhatsApp message ID sent twice | second one: no write, no reply | `duplicate_message` (gate) |
| Message from a number not in `accepted_chat_ids` | no write, no reply | `unknown_sender` (gate) |
| Reply-to a confirmation saying "no, 5pm" | edits the linked event, doesn't create a new one | correction path via `extraction_log.id` link, not a rule match |

### B — Kid dashboard (web-based, not hardware)
- Read-only, "today/tomorrow" focus.
- Icon + color per activity/person; no text dependency.
- Pulls straight from the same Google Calendar (filtered).
- Deliberately minimal build — if it doesn't land with a real kid, the cost of being wrong is small.
- **Cap the number of visible items** — show only a handful of activities at a time (today/tomorrow's key items), never a dense full-day listing. This isn't just a simplicity preference; it's an established constraint from the visual-schedule-app category (e.g. Choiceworks and similar tools), where showing too many steps at once is known to overwhelm a child rather than help them.
- **Multiple participants on one card:** for a 2-person activity, split the card background into a 2-color stripe (one color band per participant) — a deliberate aesthetic choice, not the more common pattern in the category (most established family calendar apps keep card backgrounds solid and signal multiple people via a small icon/avatar stack instead). Capped at 2 stripe colors max — for 3+ participants, fall back to a neutral card background with a small overlapping icon stack (adapted from the standard avatar-stack UI pattern, capped at 2-3 icons) rather than striping 3+ colors, to keep the card glanceable rather than busy.
- **Config/settings entry point (needed from Phase 1, not deferrable):** a small, low-visual-weight gear icon in a corner of the kid dashboard (confirmed against the approved Claude Design mock) opens a PIN-gated **Settings Home** — a menu, not a form: Family Members / Timezone / WhatsApp Connection / Log Out. Tapping an item goes directly into that single screen in edit mode (reusing the relevant onboarding screen as a component) and returns to Settings Home when done. Onboarding remains the only place these screens run sequentially — every later edit is a direct, single-screen jump, not a forced march through the full flow. Grounded in kiosk-app precedent for PIN-gating (a visible settings button on a kid-facing kiosk screen gets found and tapped by curious kids quickly, so the PIN is the real protection, not visual subtlety).
- **Wake up / bedtime as bookend markers, not cards:** small sun/moon icons flank the row of activity cards, marking day start/end — no color band, no title card, since they're day boundaries rather than activities. This keeps the 4-5 item cap meaningful (it applies to actual activities only) and resolves the earlier open item — the approved mock's 6 "cards" become 4 real activity cards plus 2 non-card bookend icons.
- **Wireframe/mock this before writing any code** (per design principle 5) — layout, icon sizing, and information density are the actual risk here, not the plumbing. Cheap to iterate on paper/Figma, expensive to iterate once built.
- Test path: static page first, styling later.

### Data model (Phase 1)
Events live in Google Calendar, but the app still needs a small amount of its own state — configuration and provenance — before extraction can work at all. This is deliberately lightweight (lookup tables and logs, no status workflows), and kept separate from Phase 2's model so Phase 1 doesn't quietly absorb Phase 2's complexity.

| Table | Purpose |
|---|---|
| `families` | name, timezone, pin_hash (protects the kid-dashboard settings entry point — never stored in plaintext, even for a 4-digit PIN) |
| `family_members` | name, calendar color, kid-view icon, linked calendar ID(s) |
| `source_mappings` | binds a WhatsApp sender number / forwarding email address → a `family_member`, so attribution works without asking every time |
| `activity_icons` | lookup of activity keyword/category → icon, for the kid view (starts as a short hardcoded list, editable later) |
| `extraction_log` | `raw_input`, `ai_candidate` (jsonb — the extraction schema below), `external_message_id` (dedup key for idempotency, future-proofing item 4), `resulting_event_ref` (structured `{provider, external_id}`, future-proofing item 8, null until written), `state` (the state machine below). Avoids duplicate adds on re-forwards, supports debugging bad extractions, and later lets you measure whether A is actually reducing effort. |
| `tasks` | title, due_date, importance (High/Med/Low), owner, status, reminder_policy (default: none — see Reminder policy below). Backbone only in Phase 1: table + write path exist so task-shaped captures have somewhere real to land, but the actual list UI doesn't ship until Phase 2. Resolves the earlier open question about what happens to task-shaped extractions before Phase 2's UI exists. |
| `rules` | family_id, rule_type ('gate' | 'assessment'), trigger_type, conditions (jsonb — `all`/`any`/`not` boolean-composition schema, json-rules-engine convention), action (jsonb), priority, enabled — the rule engine's data (see Bot mechanism below). Gate rules run pre-LLM and can short-circuit the pipeline; assessment rules act on extraction output. Editing surface is direct DB access in Phase 1; a proper admin UI is Phase 2; Phase 3-5 user-facing authoring is a constrained template menu (not freeform JSON), compiling to `gate`-tier rules only. |
| `bot_config` | bot identity (number/account, channel type — Business API vs. forwarding-style), accepted input chat ID(s) as an explicit allowlist (not "listen to everything"), webhook endpoint + auth token, digest destination chat ID (used from Phase 2 on), message templates for confirmations/digests. Distinct from Phase 3's group-participant bot, which needs session/device-pairing config instead — a different connection model, addressed separately when Phase 3 starts. |
| *(credentials)* | Google Calendar API auth state |

### Build this way from day one (future-proofing, near-zero cost now)
These are things that are cheap to do correctly in Phase 1 but expensive to retrofit later — each one either requires a data migration, a credential rotation, or an unrecoverable data loss if skipped now and fixed later. Deliberately not a longer list: multi-tenant isolation, provider-selection UI, queueing, encryption-at-rest, and formal privacy tooling are real Phase 4 concerns, not day-one insurance — building them now would just slow down shipping Phase 1.

1. **`family_id` on every table**, even with exactly one row for now. The highest-leverage item on this list — adding it later means migrating data and auditing every query for isolation bugs.
2. **All timestamps in UTC + an explicit timezone field per family.** Old timestamps become ambiguous and unrecoverable if this is added after the fact.
3. **Real secrets management from the first commit** (env vars / secrets store) — never hardcoded tokens or config committed to a repo.
4. **Idempotency on incoming messages.** Meta's webhooks retry on network blips; dedupe by WhatsApp message ID (via `extraction_log`) so retries don't create duplicate events. This isn't a future concern — it can bite in Phase 1 itself.
5. **A thin interface boundary around "calendar provider" and "messaging channel."** Business logic calls `calendar.createEvent(...)` / `messenger.send(...)`, never the Google/WhatsApp SDKs directly inline. Turns Phase 3's multi-provider sync into "add a second implementation," not a rewrite.
6. **UUIDs as primary keys**, not auto-incrementing integers — avoids ID collisions if data ever needs to move or merge across environments.
7. **Generalized `source_mappings`**: `(channel_type, external_identifier, family_member_id)` instead of a separate column per channel — new channels become new rows, not schema migrations.
8. **Structured external references**, e.g. `{provider: "google", external_id: "..."}` rather than a bare ID string, wherever `extraction_log`/`tasks` point at a calendar event — the storage-layer counterpart to item 5.
9. **Soft deletes only** (`deleted_at` timestamp, never a hard delete) — enables debugging and future undo; unrecoverable once real deletes have already happened.

### Onboarding flow
Validated against real-world precedent (Skylight Calendar's setup flow, the closest match since it's also a calendar-sync-first product): connect the calendar before configuring profiles, since profile/color setup means little against an empty calendar — <cite>each event needs to be tagged to a specific profile to keep the calendar organized and color-coded</cite>, confirming profile setup belongs early but after the calendar connection, not before.

1. **Sign in** — parent's Google account (reused for step 2, no separate auth system needed)
2. **Connect Google Calendar** — OAuth consent flow, immediately, since nothing downstream works without it
3. **Add family members** — name, color, kid-view icon per person (populates `family_members`)
4. **Set timezone** — default from device, explicit confirm/edit step (must be captured at the very start per future-proofing item 2 — not backfillable later)
5. **Connect the WhatsApp bot** — the account-level setup (Meta test-recipient registration) happens manually outside the app per earlier discussion; onboarding's job is to surface the bot's number/instructions clearly and confirm receipt once a test message is sent
6. **Set a settings PIN** — protects the config edit entry point on the kid dashboard (see Data model, `pin_hash`); short, kid-dashboard-appropriate (e.g. 4 digits), grounded in the kiosk-app pattern where settings access needs a real gate, not just visual subtlety
7. **Preview the kid view** — render the just-configured colors/icons live, so the parent sees the payoff before finishing rather than trusting it blindly

Per design principle 5, this flow gets mocked in Claude Design before any of it is built.

### Explicitly out of scope for Phase 1
No task list, no insights, no approval workflow, no bot-in-group, no hardware.

---

## Phase 2 — First real backend

**Trigger for complexity step-up:** Tasks and Insights don't natively fit in Google Calendar's data model (no "importance," no "conflict status"). This is the point the product needs its own datastore and its first authenticated parent-facing surface.

### Data model (introduced this phase)
| Table | Purpose |
|---|---|
| `tasks` | already exists as a backbone from Phase 1 — Phase 2 adds the real UI on top, no schema change needed |
| `shopping_items` | name, category (store-aisle grouping, e.g. Produce/Dairy — not due_date/importance), status. Deliberately a separate table from `tasks`, not a category tag on it — grounded in real precedent: established family apps (Cozi) treat shopping lists as structurally distinct from to-dos, since grocery items need check-off + aisle-grouping, not due dates or priority |
| `insights` | `type` (conflict / nudge / suggestion — only `conflict` active in Phase 2), `source`, `related_entity_ids`, `status` (new/dismissed/acted-on). Suggestion type now spans multiple targets — e.g. "add a playdate" points at a calendar action, "you're low on X" points at `shopping_items`, not just generic tasks |

Single canonical store per data type — the WhatsApp digest and the web view both read/write the same records, never a fork.

### Task UI (full build, this phase)
- **Tasks:** flat checklist, sorted by due date, importance shown as a small badge rather than separate swim-lanes — right-sized for household scale rather than borrowing a team-tool's kanban/grouped-by-owner pattern
- **Shopping list:** separate view from tasks, check-off + category headers (aisle-style grouping), following the Cozi precedent directly
- Both wireframed/mocked before building, per design principle 5

### Insights v1 — conflict detection only
- Rule-based, no LLM: double-bookings, missing owner, missing time, unassigned logistics gaps.
- Parent-facing only.
- **Gets its own dedicated page in the web app** — not just something surfaced incidentally via digest deep-links. The digest is the push notification; the insights page is where you browse/review at will.
- Suggestion breadth beyond conflict detection (still Phase 2, once past pure conflict-detection): pattern-based suggestions across multiple domains — playdate cadence, and now also low-inventory/replenishment-style nudges that point at the shopping list rather than the calendar or tasks.

### Delivery split (by data type, not duplicated per channel)
- **Insights → push + dedicated page.** Daily/twice-daily WhatsApp digest for time-sensitive glancing, plus a full web page for browsing anytime. Same canonical `insights` records either way.
- **Tasks → pull.** Web page: list view, mark done, re-prioritize.
- **Shopping list → pull.** Separate web page, same pull model as tasks but its own view given the different shape.
- **Calendar → stays in Google Calendar.** No custom calendar UI this phase — resist scope creep here specifically.

### Parent ↔ kid view toggle
- Same web app now includes a mode switch: parent can flip into the kid view from their own phone (e.g. kid asks to see it on the go), not just on the fixed kitchen device.
- Implementation-cheap: kid view was already "render calendar data in kid-mode" — this is a shared component, gated by kiosk-mode vs. logged-in-parent, not a second build.
- Open question deferred to Phase 3: does the wall-mounted instance ever diverge from the phone instance (e.g. kid check-off interactions only on the physical device)? Not decided now — keep the component unified until there's a real reason to split it.
- Wireframe both the task list page and the toggle placement before building (per design principle 5) — this is the first authenticated parent surface, worth getting the layout right before it's real code.

### Other Phase 2 items
- Onboarding/completeness nudges ("connect your calendar," "add your work hours") — driven by a simple completeness score, not AI.
- Pattern nudges (e.g. playdate cadence) — sequenced after enough real usage data accumulates; not viable on day one of Phase 2.
- Task importance inference from signals (sender, keywords, recurrence) as an upgrade to manual tagging.
- Data model support for two independently-permissioned parent identities (built quietly now, not exposed in UI) — avoids a rewrite if co-parenting/visibility needs emerge later.

---

## Phase 3 — Speculative / higher-risk bucket

Each item here is contingent on Phase 1/2 actually proving useful in daily use — not committed to.

- **WhatsApp bot-as-group-participant.** Requires an unofficial client library (e.g. Baileys-style) automating a real WhatsApp account/number so it can join a group like a person — the official Business API cannot be added to personal groups. This is against WhatsApp's ToS; risk is real but lower at personal/low-volume use than at product scale. Ship opt-in, with the risk stated plainly, not silently.
- **Multi-provider calendar sync.** Real households often split across Google/Outlook/Apple/Exchange. This breaks the "Google Calendar is the interface" assumption — requires a normalization layer across providers (differing auth, event models, webhook vs. polling sync). This is very plausibly the point a **dedicated, owned calendar UI becomes necessary** rather than scope creep, since no single provider can render the true merged picture. Treat as an architectural fork, not an incremental add — Phase 2's data model should not assume single-provider so this doesn't require a rework.
- **Generative/agentic insights.** Proactive suggestions with drafted follow-through (date-night ideas → babysitter message draft), built on the same underlying agent as the on-demand "converse with an agent" story — two entry points, one agent, shared memory of preferences.
- **Hardware / eink dashboard.** Only after the web-based kid view has proven out on a propped-up tablet.
- **Third-party task app integrations** (e.g. Todoist).
- **Caregiver/grandparent read-only role.**
- **Full co-parenting UX** — separate households, custody-aware permissions — only if it becomes a real personal need; not the primary use case now.
- **Clickable kid icons on the dashboard** — tapping a child's icon filters the view to show only that child's activities. Worth flagging explicitly: this is the first interactive element proposed for the kid dashboard, which Phase 1 scoped as fully read-only/no controls. When this gets built, it needs its own pass through design principles 5 and 6 (find real-world precedent, mock before building) — filtering-by-tap introduces a new interaction a young child needs to discover and understand, not just glance at.

---

## Open decisions log
Carry forward — revisit as each phase starts, don't need answers now.

1. Does kid-view ever need device-specific behavior (wall tablet vs. parent's phone)? — deferred to Phase 3.
2. Exact WhatsApp bot identity path for Phase 3 group-participation (which unofficial library, which number) — not decided.
3. Whether multi-provider sync forces a fully owned calendar UI, or a lighter merge-view suffices — decide once Phase 3 starts, informed by how many providers actually show up in practice.


---

## Stack & Hosting Decision (Phase 1)

**Language/runtime:** Node.js (Express or Fastify) + Postgres.
Rationale: aligns with json-rules-engine (the recommended rule-engine library, also Node-based) so the app doesn't span two ecosystems for no reason. Well-trodden shape for a webhook-receiver + DB + external-API-calls app. Python was the closest alternative (stronger if heavy data/ML work ever emerged, weaker rule-engine alignment); Go was considered and rejected as solving a scale problem this app doesn't have. None of the three mainstream choices meaningfully affect future scale for a household-sized app — the thing that would force a rewrite is a structural change (e.g. Phase 3 multi-provider calendar sync), not the language choice.

**Hosting:** Railway (Hobby plan, ~$5/month).
Rationale: simplest deploy path (GitHub-connected, automatic HTTPS domain + managed Postgres, no manual TLS/tunnel config) — solves the public HTTPS requirement as a side effect of deployment rather than as a separate dev-environment problem. Fly.io was the close alternative (slightly more flexible/edge-capable, but requires config files + CLI, unnecessary complexity at this scale). Free tiers (Render) were rejected due to cold-start delays on idle, which risks silently delaying/missing unpredictable incoming WhatsApp webhooks — unacceptable for a household-dependability tool. Neither Railway nor Fly.io meaningfully lock in the app long-term, since the existing thin-interface-boundary principle (future-proofing item 5) already keeps hosting swappable.

**WhatsApp token:** Use a Meta System User token (Business Settings → Users → System Users), not a User Access Token — does not expire on a fixed timer, unlike the 24h token used during initial setup/testing.


**Frontend:** React.
Rationale: pairs naturally with the Node backend (same language, JavaScript, across both layers — no context-switching between ecosystems), has the largest ecosystem of the mainstream options (React, Vue, Svelte), and is the safest choice if a React Native mobile app is ever built later (Phase 3+), since concepts and code patterns transfer directly. Vue was the close alternative (gentler learning curve, smaller ecosystem); Svelte was considered and set aside as newer/leaner but less battle-tested for a solo-maintained project.

**Full stack backbone, Phase 1, all layers decided:** Postgres (database) + Node.js/Express or Fastify (backend) + React (frontend), deployed on Railway (hosting).


**Frontend guardrails (for Claude Code, Phase 1 build):**
1. **Single source of truth for every shared calculation/lookup.** Any logic used in more than one place — icon/color lookup per family member, date/time formatting, the 4-5 item dashboard cap, field-presence classification display logic, etc. — must live in exactly one shared module, imported everywhere it's needed, never duplicated or reimplemented per-component. This applies especially across the parent view and kid view, which per Phase 2 share components/mode-switch — they must genuinely share the underlying logic, not just look similar. If Claude Code is about to write a calculation that resembles one that already exists elsewhere in the codebase, it should extract/reuse rather than duplicate.
2. **No premature state-management libraries.** Plain React state plus Context is sufficient for this app's scale — no Redux or equivalent. Same reasoning as ruling out Kafka/heavy orchestration on the backend: this app's actual complexity doesn't warrant it.
3. **All data fetching goes through one API-client layer**, mirroring the backend's thin-interface-boundary principle (future-proofing item 5). Components call functions from this shared client (e.g. `getTasks()`, `getFamilyMembers()`), never `fetch` directly and independently per-component. Keeps the frontend swappable/testable and prevents inconsistent assumptions about API shape creeping in component-by-component.


**Frontend project structure/conventions (for Claude Code, Phase 1 build):**
4. **Organize by feature, not by file type.** A folder per feature area (e.g. `kid-dashboard/`, `settings/`, `onboarding/`) each containing its own components, styles, and logic — not one giant `components/` folder mixed with a separate `styles/` folder, which gets unwieldy fast and scatters related code.
5. **Design tokens, not hardcoded values.** Colors, spacing, font sizes defined once in a shared theme/tokens file and referenced everywhere — never a hex code or pixel value typed directly into a component. This also directly protects design consistency between the kid dashboard and Settings Home, which are meant to share the same visual language.
6. **Component naming and size discipline.** Components named clearly by what they render (e.g. `ActivityCard`, not `Card2`), and kept small/single-purpose — if a component's logic starts handling more than one clear responsibility, it should be split, not grown.
7. **Consistent file naming convention** (e.g. PascalCase for component files matching the component name) applied uniformly across the whole project, not decided ad hoc per feature.


**PIN recovery flow (Settings Home, Phase 1):**
"Forgot PIN" link on the PIN entry screen. Since the app already sits behind Google sign-in (onboarding step 1), the PIN is a lightweight secondary gate, not a serious security boundary — so recovery re-uses the existing Google session as the identity check, rather than a separate security-question/email-code flow. Tapping "Forgot PIN" confirms the user is still signed in with Google (already true in normal use), then goes straight to a "Set new PIN" screen. No additional verification step needed — Google sign-in underneath is already the strong check. Precedent: Google/Apple parental-control PIN resets both work this way, tying recovery to the account already logged into rather than a standalone secret.


**Reminder request handling (extraction schema addition):** `reminder_requested` (boolean) and `reminder_datetime` (string|null) added to the LLM extraction schema, since the original 5-field schema had no way to represent an explicit reminder ask (e.g. "remind me to pack the gym bag Thursday night"). Same philosophy as the rest of the schema — plain factual extraction, not a routing decision. Downstream, the assessment tier checks `reminder_requested`: if true, it overrides the Phase 1 default of no-automatic-reminder for that specific item and schedules a WhatsApp reminder for `reminder_datetime`; if false, falls through to the existing default. Acceptance fixtures should be extended to cover this case (message with explicit reminder ask → confirms + schedules reminder, distinct from the default no-reminder path).

**Bot command summary (everything a user can trigger by messaging the bot directly, Phase 1):**
- **Forward a message/photo/email** — the core capture path. Triggers extraction and, depending on which fields come back, either writes to Calendar with a confirm reply, writes to tasks as tentative with a qualify reply, asks for clarification, or does nothing (see extraction_classification table).
- **"undo"** — hardcoded command, intercepted before the LLM call. Reverts the most recent write (event or task) linked to that sender.
- **"list tasks"** — hardcoded command, intercepted before the LLM call. Returns the current tasks backbone contents as a text reply — this is what lets tasks be tested/used in Phase 1 before a dedicated task UI exists in Phase 2.
- **"help"** — hardcoded command, intercepted before the LLM call. Replies with a short list of what the bot understands (forwarding messages, undo, list tasks).
- **Reply to a bot confirmation with a correction** (e.g. "no, 5pm") — not a command or a rule match; routed via the `extraction_log.id` link on the original message to edit the already-written event/task directly.
- All four hardcoded commands (undo, list tasks, help, and the correction-reply path) are matched via string/regex BEFORE any LLM call, and are deliberately NOT in the `rules` table — fixed system behavior, not tunable per-family business policy.

---

## Bot capabilities log
Running list of everything the bot can do, kept in one place so nothing gets added ad hoc and forgotten (this section exists because the reminder-scheduling gap above only got caught by chance in conversation, not by design). Update this whenever a new bot-triggered action is decided, even before it's built.

**Live in Phase 1:**
- Capture from forwarded WhatsApp message, photo, or forwarded email → extraction → Calendar/tasks write + reply (see extraction_classification).
- "undo" — revert most recent write.
- "list tasks" — reply with current tasks backbone contents.
- "help" — reply with a short capability summary.
- Reply-correction to a confirmation (e.g. "no, 5pm") → edits the linked event/task.
- Reminder-on-request: if a forwarded message explicitly asks to be reminded (`reminder_requested`), the bot sends a WhatsApp message at `reminder_datetime` reminding the family of that item — this is the one exception to the Phase 1 default of no automatic reminders, scoped to only messages that explicitly asked for one.

**Deferred / backlog (not built yet, listed here so they aren't lost — revisit each when its phase starts):**
- Automatic reminders beyond explicit requests (e.g. reminding before *any* event, not just ones that asked) — deliberately out of Phase 1 scope; the global default stays "no reminder" unless the family later defines this via a gate-tier rule (Phase 3+ user-authored rules).
- Bot-initiated proactive messages (e.g. "you have nothing planned tomorrow, want to add something?") — none of this exists yet; would need its own precedent pass per design principle 6 before being added.
- Any bot action that writes/edits beyond Calendar and tasks (e.g. shopping list via WhatsApp) — Phase 2+, once shopping_items exists.
- Group-participant bot behavior (Phase 3, ToS caveat already logged in Phase 3 section).

---

## Phase 1 build log (Claude Code)
Kept up to date as the implementation proceeds — same reasoning as the bot capabilities log above: decisions made during the build that aren't visible from reading this doc's earlier sections get lost otherwise. This section is a record of what actually shipped and where it deviates from or extends what's written above; it does not replace those sections, it supplements them.

**Repo & deploy:**
- Code: [github.com/royreinail/family-app](https://github.com/royreinail/family-app), `main` branch.
- Live: `https://family-app-production-9a73.up.railway.app`, single Railway service. Root `npm workspaces` (`server/`, `web/`) — `npm run build` builds the React app, `npm start` runs the Express server, which serves the built frontend itself (no separate static host) and applies `server/src/db/schema.sql` on every boot.
- Stack decision resolved: **Express** (not Fastify) for the backend.
- Known Railway/Nixpacks gotcha: a `package-lock.json` generated on macOS doesn't reliably satisfy `npm ci` on Railway's Linux builder for Vite/Rollup's optional platform binaries (`@rollup/rollup-linux-x64-gnu`, npm/cli#4828). Fixed via a `NIXPACKS_INSTALL_CMD=npm install` Railway service variable (more reliable than `nixpacks.toml`'s `[phases.install]` override, which Railway didn't consistently honor). Also: Railway's "Redeploy" button reuses the exact same source snapshot and Nixpacks' cached build plan — a genuinely new `git push` is required to force a plan regeneration after a Nixpacks-affecting config change.
- Google OAuth consent screen is in "Testing" mode (not verified/published) — expected and fine for personal use, but every Google account that needs to sign in must be added under **OAuth consent screen → Test users** first, or sign-in fails with `access_denied`.

**Data model additions beyond the table above (all additive, nothing removed):**
- `rules.name` (text) — added so acceptance fixtures can assert *which* rule fired by a stable identifier; `trigger_type` alone isn't unique across `extraction_classification`'s four branches.
- `google_credentials` table — holds the family's Google OAuth tokens (access/refresh token, scope, expiry, calendar_id), kept separate from `families` so a second calendar provider (Phase 3) has an obvious second implementation to add rather than a schema rework.

**Rule engine implementation note:** `evaluateRules` uses `json-rules-engine` for condition evaluation (the `all`/`any`/`not` schema), but evaluates a family's matching rules one at a time in priority order and stops at the first match — `json-rules-engine`'s own `Engine.run()` fires every matching rule rather than stopping at the first, so "first match wins" (as specified above) is enforced by this thin loop around the library, not by the library itself.

**Acceptance fixtures:** all 7 required fixtures (`server/tests/fixtures/acceptance.test.js`) pass, run via Node's built-in test runner against an in-memory Postgres (`pg-mem`) — no real database needed to run `npm test`.

**Not yet configured on the live deployment:** WhatsApp message capture and Google Calendar sign-in are wired up but depend on credentials being added as Railway env vars (`server/.env.example` lists all of them) — see this doc's git history / conversation log for the exact walkthrough used to obtain each one, since Meta's and Google's consoles change their UI faster than this doc should try to track.

**Known gap: reminder sends need a WhatsApp message template, not freeform text.** `messenger.send()` (`server/src/integrations/messenger.js`) always sends `type: "text"`, which only works inside the 24-hour customer-service window a user opens by messaging the bot. The bot capture→reply path is always inside that window (reply fires immediately), so it's unaffected. Reminder-on-request is not: `reminder_datetime` is very often hours or days after the triggering message, i.e. outside the window by the time `sweepDueReminders` fires it, which WhatsApp's policy classifies as a business-initiated message requiring a pre-approved message template. Fixing this means creating a template (e.g. "Reminder: {{1}}"), submitting it for Meta review, and branching `messenger.send` to use the `template` message type for reminder sends specifically. Not fixed yet — flagging so a reminder silently/loudly failing outside the window isn't mistaken for a pipeline bug.
