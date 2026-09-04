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
- `needs_time → written`: a parked "What time?" row is promoted in place when the sender's next message is a bare time answer ("8:30"), whether or not it carries reply/quote metadata — the stored `ai_candidate` is merged with the time and the row is repointed from its tentative task to the real Calendar event (see the Item 5 fix in the build log).

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

**Fixed bug: real families were created with an empty `rules` table.** `seedDefaultRules()` was only ever called from the test setup helper (`tests/setup/seedFamily.js`), never from the real Google sign-in flow (`routes/auth.js`) — so every family created through actual onboarding had zero gate/assessment rules. `evaluateRules` degrades safely when no rule matches (falls back to a hardcoded default, per its own design — "the system never has zero behavior"), but for `extraction_classification` that default is "stop, no reply," which looks identical to a working-but-quiet bot rather than an obviously broken one. This was the actual explanation for "I send messages and nothing happens" during first real-world testing, on top of two other real gaps found the same session: `bot_config.phone_number_id` was never populated from `WHATSAPP_PHONE_NUMBER_ID` on family creation (webhook lookups by phone number always missed), and the `unknown_sender` gate compared phone numbers by exact string instead of digits-only (WhatsApp's webhook sends bare digits; onboarding's field invites a "+countrycode..." format). All three now self-heal automatically — on `/auth/session`, on `/auth/google/callback`, and on `GET /api/bot-config` respectively — so a family created before these fixes recovers just by loading the app, no manual data fix needed. Also found in the same session: the account-level cause that made *nothing* arrive at all before these bugs were even reachable — a fresh WABA's phone number is subscribed to Meta's own default internal app, not automatically to whichever app you configure a webhook URL on; fixing it needs one `POST /{waba-id}/subscribed_apps` call using a token with `whatsapp_business_management` permission (the `whatsapp_business_messaging`-only token generated per the earlier walkthrough isn't enough for that specific call).

**Not yet configured on the live deployment:** WhatsApp message capture and Google Calendar sign-in are wired up but depend on credentials being added as Railway env vars (`server/.env.example` lists all of them) — see this doc's git history / conversation log for the exact walkthrough used to obtain each one, since Meta's and Google's consoles change their UI faster than this doc should try to track.

**One more real bug found and fixed the same session, after the three above:** Google Calendar's API rejects a bare `dateTime` (no UTC offset) unless a `timeZone` field travels with it — `calendar.js`'s `createEvent` never sent one. Fixed by threading the family's stored `timezone` from `webhook.js` through the pipeline into every calendar write (create, and the reply-correction update path); also gave every write a 1-hour default duration instead of `start === end`. **Confirmed working end-to-end in production after this fix:** a real WhatsApp message ("dance class Thursday 4pm") produced a real Calendar event and a real WhatsApp confirmation reply — `outcome=written rule=extraction_classification:date_time` in the server logs.

**Fix: "tomorrow" resolving one day too late.** Found in the post-launch backlog session. Two-part fix: (1) the LLM's reference date defaulted to the server's UTC "today" (`new Date().toISOString()`), which silently disagrees with the family's local date for part of every day depending on timezone — now computed via `todayInTimeZone(family.timezone)` (`classify.js`) and threaded through from `webhook.js`. (2) Regardless of reference-date correctness, "today"/"tomorrow" are unambiguous enough not to trust to LLM arithmetic at all — `overrideObviousRelativeDate` deterministically recomputes the date for exactly those two keywords straight from the raw message text, after extraction, independent of whatever the LLM returned; weekday names and fuzzier relative phrases still go through the LLM's own reasoning. Regression tests (`tests/regression/dateResolution.test.js`) deliberately feed a wrong LLM answer (the exact bug observed) and assert the override corrects it.

**Fix: edit/remove family members (backlog 1.2), plus a cross-family authorization gap found while building it.** `FamilyMembersStep.jsx` previously only supported creating new members — the existing member chips were read-only display, no click target, no delete affordance. The same single draft card now serves both create and edit: tapping a member chip loads them into the draft (`draft.id` set) and the card's button relabels to "Save changes"; a "New person" chip appears alongside the members to reset back to a blank create draft. Remove is a two-tap affordance ("Remove {name}" → "Tap again to remove") rather than a native `confirm()` popup or a modal, matching the app's existing no-interruption tone. While touching `PUT`/`DELETE /family-members/:id` to wire this up, found both routes (and the repository functions underneath, `familyMembersRepo.update`/`softDelete`) only ever filtered by the member's own `id` — never by `family_id` — so PIN verification was the only gate, and any signed-in family that learned another family's member UUID could edit or delete that member. Fixed by threading `req.familyId` through both the route and repository layer, scoping the `UPDATE` to `id = $1 and family_id = $2`; a mismatch now returns `null`/`false` from the repository and a 404 from the route instead of silently no-op'ing on the wrong row (or, before the fix, succeeding on it). Regression tests in `tests/regression/familyMemberAuth.test.js` create two families and assert cross-family update/delete attempts leave the real row untouched.

**Fix: calendar selection (backlog 2.1).** `calendar_id` on `google_credentials` already existed and every write already respected it (`calendar.js`'s `createEvent`/`updateEvent`/`deleteEvent`/`listEvents` all use `credentials.calendar_id || 'primary'`) — the missing piece was purely a way for a family to see and change it. Added `calendar.listCalendars(credentials)` (Google's `calendarList.list`, filtered to `accessRole` of `owner`/`writer` since a write to a read-only shared calendar would just fail) and `googleCredentialsRepo.setCalendarId(familyId, calendarId)` (scoped to the calling family, mirroring the family-member authorization fix above). New Settings Home row ("Calendar") lists every calendar the connected Google account can write to, radio-select, PIN-gated save — same settings-editor pattern as Timezone/WhatsApp. Deliberately settings-only, no onboarding step: a freshly-connected account only has its own calendars to pick from at that point anyway, so there's nothing meaningful to choose until later. Verified via the dev preview: not-yet-connected state, and — since the preview's fake OAuth tokens can't reach the real Google API — the "connected but couldn't load" fallback state, which caught a real bug in `CalendarSettings.jsx` before it shipped: the shared `api/client.js` `request()` helper throws on any non-2xx response (including this route's deliberate `502 calendar_unavailable`), so the first version of the `.catch` mislabeled "connected, API call failed" as "not connected" — fixed by having the catch branch assume `connected: true` (a clean "not connected" only ever arrives as a normal 200, never a thrown error). **Confirmed working end-to-end in production:** Roy tried Settings → Calendar live and confirmed his real calendars listed and selection stuck. A one-line temporary debug log captured the real `calendarList.list()` response for `tests/regression/calendarList.test.js`'s fixture, then was removed — the mapping/filter logic (`calendar.js`'s new `mapCalendarListItems`, split out from `listCalendars` specifically to be testable without mocking Google's API) is now covered against real field shapes: a reader-only calendar shared by another account, Google's own auto-added read-only holiday calendars, a family calendar with a `group.calendar.google.com` id distinct from any person's address, and non-Latin (Hebrew) summary text surviving unmangled. Real emails/calendar IDs were replaced with placeholders before committing the fixture, since this repo is public on GitHub.

**Fix: multi-parent / shared family support (backlog 1.3).** Design confirmed with Roy before building (per his own note that this needed deliberate thought, not a reactive patch): equal permissions for both parents (no admin/elevated role), invite delivered as a code + link via the OS share sheet (no in-app email sending), reachable from both onboarding and Settings.

Data model: a new `family_parents` table (`family_id`, `google_account_email`) tracks every Google account authorized to sign into a family — kept separate from `google_credentials`, which stays a single shared Calendar connection regardless of parent count, since a second parent joining shares the existing connection rather than getting their own. `families.invite_code` (unique, lazily generated via `familiesRepo.ensureInviteCode`) backs the join link (`/join/:code`).

The actual bug-prone part — deciding which family a signing-in Google account belongs to — was split out of `routes/auth.js` into `services/parentSignIn.js`'s `resolveFamilyForSignIn`, specifically so it has real unit-test coverage without mocking Google's OAuth API (auth.js's callback still can't be tested directly for the same reason `calendar.js`'s real API calls never have been). Checked in order: (1) an active session already mid-flow (e.g. `ConnectCalendarStep` re-running the same OAuth button) keeps its own family; (2) a returning parent matches by email against `family_parents`, falling back to `google_credentials` for accounts that signed up before `family_parents` existed — this fallback also backfills the real row, so it only ever triggers once per pre-existing account; (3) a new account with a valid invite code joins that family; otherwise a new family is created, unchanged from before. Caught in design, not after: without the (2) fallback, this feature would have silently broken every existing single-parent user the first time their session cookie expired — a fresh sign-in with no `family_parents` history and no invite code would have created a *second*, empty family for them. Also guarded: a second parent's OAuth callback no longer overwrites `google_credentials` with their own tokens (only writes when there's no existing connection, or the same account is refreshing its own tokens) — without this, whichever parent signed in most recently would silently become "the" calendar account.

Also fixed in the same pass: `PinStep` (onboarding) would silently overwrite an already-set family PIN if a second parent walked through the same onboarding sequence and set their own — the family has one shared PIN, not one per parent. Now shows a plain "PIN already set" confirmation instead of a fresh pad when `session.family.pinSet` is already true and it isn't the dedicated Settings "change PIN" flow.

New: `InviteCoParentStep` (reused in onboarding — 8th step now, after PIN — and Settings → "Invite a Co-Parent"), `JoinFamilyPage` (`/join/:code`, public preview of the family name before sign-in), and a "Have an invite code?" entry point on `SignInStep` for someone handed a bare code rather than a link. Regression tests (`tests/regression/multiParent.test.js`) cover every branch of `resolveFamilyForSignIn`, invite code minting/lookup, and the calendar-credential-preservation guard. Full suite: 38/38 passing. The real end-to-end join (two actual different Google accounts) can't be exercised in the dev preview — same class of limitation as backlog 2.1's calendar list — so this needs live verification with a second real account.

**Fix: event audience & kid visibility (backlog 4.1-4.3).** Scope ended up narrower than the original backlog note once the kid dashboard's actual current shape was accounted for: it's one shared board today, not per-kid views (clickable-kid-icon filtering is its own separate, not-yet-built, "needs its own design pass" item elsewhere in this doc) — so there's nowhere yet to point a kid-specific audience, and "audience" for now can only mean a binary hide-from-the-board vs. show.

Extraction schema (`llm.js`) gained one field: `audience: 'family' | 'parent_only'`, decided by the LLM itself (system prompt explicitly defaults to `'family'` whenever unclear — chosen over defaulting to `'parent_only'` so the board doesn't go quiet from ordinary ambiguous family events, confirmed with Roy). One deterministic override on top (`classify.js`'s `overrideExplicitAudienceKeyword`, applied in the pipeline the same way `overrideObviousRelativeDate` is): an explicit phrase like "just us parents" or "parents only" always wins over the LLM's own read — this is 4.3's "nice-to-have manual override," reshaped as a keyword catch rather than a UI toggle since there's no event-management screen in Phase 1 to put one on. Persisted via Google Calendar's `extendedProperties.private.audience` on the write (`calendar.js`'s `createEvent`) — invisible in Calendar's own UI, keeps this pure app metadata rather than cluttering the visible event. `GET /dashboard/tomorrow` filters using the pure `shouldShowOnKidBoard` helper before returning events; an event with no audience metadata at all (old writes, sample/preview events) defaults to shown, never hidden. Regression tests (`tests/regression/eventAudience.test.js`) cover the keyword override, the filter, and both real-write paths (default-to-family, and keyword-forced parent_only overriding what the LLM guessed). Full suite: 38/38 passing.

**Fix: mobile-triggered onboarding re-run.** Roy reported opening the app link on his phone forced him through the *entire* onboarding sequence again, despite the family already being fully set up. Root cause: `App.jsx`'s `RootRedirect` decided "onboarded" as `signedIn && calendarConnected && family.pinSet` — but PIN is explicitly skippable during onboarding ("I'll set this up later"), so a family that skipped it (as Roy's had) got routed through the full 8-step flow on *every* fresh session — any new device, a cleared cookie, a different browser — forever, since skipping the PIN never becomes "setting" it. Fixed by dropping `pinSet` from the check: `calendarConnected` is the one real hard requirement; family members/timezone/WhatsApp/PIN are all editable later from Settings and were never meant to gate re-entry. This also directly interacts with backlog 1.3's multi-parent invite flow — a second parent clicking their invite link would have hit the identical bug once matched into the existing family.

**Fix: kid dashboard — mobile portrait/landscape layouts.** `TomorrowBoard.jsx` only ever rendered one layout — a horizontal CSS grid row of tall tile-cards (`ActivityCard.jsx`) — which is what the approved mock (`Tomorrow Board.dc.html`, option 5a) actually specifies for a kiosk/propped tablet, and reasonably degrades for mobile *landscape* (option 5c) since it's the same shape at a smaller scale. On a real phone in portrait — how this thing is actually glanced at day to day — cramming 4-6 grid columns into a ~390px-wide viewport is illegible, and the mock has a genuinely different layout for that case (option 5b): a vertical stack of full-width horizontal strip-cards (icon left, title+time right), not a scaled-down version of the tile grid. Built `ActivityStripCard.jsx` for that shape (same `cardBackground`/`formatTime` logic as `ActivityCard.jsx`, single source of truth per frontend guardrail 1 — only the JSX arrangement differs) and now render both layouts in the DOM simultaneously, with a `@media (orientation: portrait)` rule in `globals.css` (using `!important`, the only way to override the row layout's inline `display: grid`, which also carries JS-driven values like `gridTemplateColumns`) picking which one shows. Deliberately not a JS resize-listener/matchMedia approach — the CSS swap applies immediately on device rotation with no flicker or render mismatch. Verified visually at 375×812 (portrait, correctly shows the new stack layout) and 812×390 (landscape, correctly shows the original row layout) via the onboarding preview's sample-data board (the real dashboard needs live Google Calendar data the dev preview's fake OAuth tokens can't provide — same limitation as backlog 2.1/1.3's live-data gaps).

**Follow-up fix: kid dashboard sizing now fluid via CSS container queries, not a hardcoded compact/full boolean.** The fix above only handled *arrangement* (row vs. stack) — Roy caught that *scale* was still broken: the header (icon, "Tomorrow", weekday, avatars, gear) never adapted at all, always rendering at fixed desktop-sized pixels regardless of screen, because it was only ever wired to a `compact` boolean used solely by the small onboarding-preview widget, never by the real dashboard. Discussed alternatives directly with Roy before rebuilding (his ask, correctly — this was the second miss on the same feature): plain `@media` viewport breakpoints were ruled out because they can't solve the actual hard part — the *same* board component also has to render correctly shrunk into the onboarding preview box, whose size has nothing to do with the browser window; only a container-relative technique sees that box's real size. Landed on container queries with `clamp()` bounds (not raw unclamped fluid values) — fluid within a sane min/max per element, so an extreme aspect ratio (very tall-narrow or very short-wide) can't push a size past what still looks right, which is standard practice for fluid CSS and also just matches the approved mock's own stated technique ("Sizing now uses container queries... so every element scales with the box itself").

Every `compact`-branched pixel value across `TomorrowBoard.jsx`, `ActivityCard.jsx`, `ActivityStripCard.jsx`, and `BookendIcon.jsx` became `clamp(min, Ncqw, max)` (the `compact` prop is gone entirely — no longer needed, since the same rule now self-adjusts to whatever box it's in). Values derived from arithmetic (avatar emoji size as a fraction of avatar diameter, mini-avatar-stack overlap) moved to CSS custom properties + `calc()` (e.g. `--avatar-size` then `calc(var(--avatar-size) * 0.5)`) since a `clamp()` string can't be multiplied in JS. Requires `containerType: 'size'` plus a *definite* height (not `minHeight`) on whichever wrapper actually bounds the board — set on `TomorrowBoardPage.jsx`'s root div (`height: '100vh'`) and `PreviewStep.jsx`'s preview box; `cqw`/`cqh` values inside `TomorrowBoard.jsx`'s children resolve against whichever of those two is the nearest container. The row/stack arrangement switch is untouched — still `@media (orientation: portrait)` in `globals.css`, since that's a genuine shape change, not a scale one, and stays independent of container size.

Verified visually via the onboarding preview at three real container sizes: the small onboarding-preview box (proportionate, no longer oversized), a full 375×812 portrait viewport (meaningfully larger container, scaled up correctly, not capped at preview-box scale), and 812×390 landscape (correct arrangement, though the onboarding preview's own competing title/button content in a 390px-tall viewport is a squeezed, not fully representative stand-in for the real fullscreen dashboard's landscape-mobile case — same live-data limitation as above prevents testing that specific combination directly). `clamp()` upper bounds were chosen to land close to the mock's own kiosk-scale (5a) values, so the kiosk case is expected to render correctly by construction even where it couldn't be pixel-verified live.

While in this code: found and fixed the same class of bug already caught once in `CalendarSettings.jsx` (backlog 2.1) — `TomorrowBoardPage.jsx`'s `getTomorrow().then(setData)` had no `.catch`, so the shared `request()` helper throwing on dashboard.js's `502 calendar_unavailable` left the kid-facing board stuck on a blank loading screen forever, silently, on any transient Calendar API hiccup. Now shows a distinct "Couldn't load tomorrow's board — try again in a bit" state instead.

**Fix: reminders firing hours off from the intended time.** Roy reported a "remind me to do the laundry at 22:30 today" reminder arriving at 1:30am instead — a real production bug, same family/class of issue as the earlier "Missing time zone definition" Calendar-write fix, just never extended to reminders. `reminder_datetime` from the LLM is a naive local wall-clock value (same convention as `date`/`time`), but unlike those fields — which only ever reach Google Calendar alongside an explicit `timeZone` (`calendar.js`'s `createEvent`) — it was inserted straight into `tasks.reminder_datetime` (a `timestamptz` column) with no offset attached. Postgres/`pg` interpret a bare timestamp string as the *server's* zone (UTC on Railway), not the family's, so 22:30 got stored as 22:30 UTC — which is 01:30 the next day in Asia/Jerusalem (UTC+3), exactly what Roy saw. Fixed with `classify.js`'s `localDateTimeToUtcIso(dateStr, timeStr, timeZone)` — no timezone library added; uses the same double-formatting technique as `todayInTimeZone` (format a UTC guess through `Intl` in the target zone, measure how far off it landed, correct by that amount) — applied in both places `reminder_datetime` gets persisted: the `write_task_reminder` branch in `pipeline.js`, and `reminders.js`'s `scheduleReminder` (now takes `timeZone`). The task's `due_date` (a plain `date` column, not `timestamptz`) is deliberately captured from the *local* string before conversion, not derived from the converted UTC value — near local midnight those two dates can differ by a day, which would just be reintroducing the "tomorrow" off-by-one bug in a new spot.

This was invisible to every existing reminder test because the acceptance fixtures never pass a non-UTC `timeZone` in pipeline deps (`seedFamily.js` sets the test family's DB record to `America/New_York`, but that value was never actually threaded into `handleIncomingMessage`'s deps — only the real `webhook.js` route does that), so `timeZone` silently defaulted to UTC, where the bug has zero visible effect (no offset to get wrong). New tests (`tests/regression/reminderTimezone.test.js`) exercise `Asia/Jerusalem` explicitly and reproduce Roy's exact scenario, asserting against the correct converted instant rather than a hardcoded expectation.

While fixing this, also fixed a real, unrelated, coincidentally-surfaced test bug: `reminderRouting.test.js`'s first fixture hardcoded an absolute date (`2026-08-18`) in the LLM's fake response while the message text says "today" — since `overrideObviousRelativeDate` correctly resolves "today" against the *real* current date independent of what the fake response claims, that test was silently one day away from breaking the moment real-world time crossed the date boundary it was authored on, which happened mid-session and broke it. Fixed to compute "today" the same way the pipeline does, so it stays correct on every future run rather than only the day it was written.

**Known: any reminder already scheduled before this fix keeps its (wrong) stored time** — this only corrects reminders written *after* it shipped; nothing was backfilled. If anything is currently pending, it'll still fire at the old incorrect time; worth just re-asking for it after this deploy if that matters.

**Fix: every dashboard event showing the same fallback icon.** Roy: "all of the icons on the app receive the same [fallback] icon." Same exact bug class, same fix shape as the earlier empty-rules-table bug: `activityIconsRepo.seedDefaults()` was only ever called from `tests/setup/seedFamily.js`, never from the real sign-in flow — so every real family's `activity_icons` table was empty, and `resolveIcon` (dashboard.js) fell through to its one hardcoded fallback (📌) for literally every event, regardless of what it actually was. Fixed the same way as rules/bot_config: `ensureFamilySetup()` now also seeds default activity icons when a family has none. New assertion added to the existing `familySetup.test.js` (which deliberately builds a family the real minimal way, not through the `seedFamily.js` shortcut that was masking this class of bug the first time). This alone restores icon variety for common English activities already in `DEFAULT_ICONS` (dance→💃, soccer→⚽, birthday→🎉, etc.).

**Fix: language-agnostic activity icons.** The seeding fix above only helps English titles — Roy confirmed (cost was the only concern, and it's negligible: this rides on the *same* extraction tool call as every other field, not a second LLM call) to add LLM-based classification as the fallback for everything else, given the family's real usage includes Hebrew. New `server/src/integrations/activityCategories.js` holds one canonical `{category, icon, keywords}` list — single source of truth, used two ways: `activityIconsRepo.DEFAULT_ICONS` is now *derived* from it (flattened to one `{keyword, icon}` row per keyword, replacing the old hand-duplicated array) for the free English-keyword path, and `llm.js`'s extraction schema gained `activity_category` (enum'd to the same category names) for the LLM to classify every message into regardless of language. Persisted via the same `extendedProperties.private` mechanism as `audience` (`calendar.js`'s `createEvent`). `dashboard.js`'s new `resolveEventIcon` tries the keyword match first (`activityIconsRepo.resolveIcon`, now returns `null` on a miss instead of a hardcoded fallback — that decision moved to the caller), falls back to `classify.js`'s `iconForCategory` reading the persisted category, and only reaches the true last-resort 📌 if neither resolved anything (an old pre-this-feature event, or a genuinely ambiguous message the LLM itself called `'other'`). Same category name → same icon on both paths, so which one actually resolved it is invisible in the result. `tests/regression/activityIcons.test.js` covers the full chain including the Hebrew case that motivated this. Full suite: 53/53 passing.

---

## Live testing round 2 (Aug 2026) — Roy's bug list

Roy's priority note: items 8 (silent non-response) and 1 (duration parsing) first — both silent-failure bugs where nothing signals anything went wrong; items 5+6 (conversational context) together next, since 6 depends on 5. Working through in that order; status noted per item as they land.

**Item 8 — messages receiving no response at all (✅ root cause found, partially fixed).** Two identical Hebrew messages got no reply whatsoever. Checked Railway logs for both exact timestamps first, per Roy's own recommendation — zero log output at all, not even the `Webhook:` line that fires unconditionally on every parsed webhook hit. Reading `webhook.js` explains why a gap like this could exist with literally no trace: `if (!phoneNumberId || !message) return;` was a **silent** early return — anything Meta posts to that URL that doesn't parse into a recognized message shape (which includes routine delivery/read-status callbacks, but could also be a real message in a shape the code didn't anticipate) exits with zero logging, before the diagnostic line even runs. Can't tell, after the fact, which of "Meta never called us" vs. "Meta called us with something we silently dropped" happened to Roy's two messages specifically — no trace exists either way. Fixed the observability gap so the *next* occurrence is actually diagnosable: now logs a warning with the payload's shape (except for genuine status callbacks, which are routine and stay silent) whenever this path is hit. Not a full fix for whatever caused these two specific misses — a real root cause needs to be caught live now that it'll actually leave a trace.

**Item 1 — event duration not captured (✅ fixed).** "8.9.26, Commanders Day - Maccabiah for Roy, 9:00-18:00" landed as a 9:00-10:00 event. Root cause: the extraction schema had no field at all for an end time — `pipeline.js` always computed `end = addOneHour(start)` unconditionally, so there was nowhere for "18:00" to even go. Added `llm.js`'s `end_time` (nullable — only set when the message gives an explicit end time or range), used in place of the 1-hour default when present; an end time earlier than or equal to the start rolls to the next day (handles an overnight range like "9pm-1am") rather than landing before the event starts. `confirmReply` now echoes the range back (`09:00–18:00`) when given, so a correctly- (or incorrectly-) captured duration is visible in the confirmation itself. `tests/regression/eventDuration.test.js`.

**Item 3 — known family member names not recognized (✅ fixed) / Item 4 — event color not following the person (fixed as a consequence).** "קניות עם שי לי, היום בשעה 14:00" ("Shopping with Shai, today at 2pm") created a title of "Shopping with Shai" instead of recognizing Shai as a real, pre-defined family member — `person` never got set, and `resolveEventColorId` (already correct — see the color-coding fix earlier in this doc) had nothing to match against, so color assignment silently fell back to default too. Roy's own diagnosis was exactly right: `webhook.js` already fetches the family's real members (`familyMembers`) but never threaded their names into the extraction call at all — the LLM had no way to distinguish "a real family member's name" from "any other word in the sentence." Fixed by adding `familyMemberNames` to `llm.js`'s `extract()` opts (`webhook.js` now passes `familyMembers.map(m => m.name)`), included in the system prompt (`buildSystemPrompt`, exported and unit-tested directly — the actual API call itself isn't, same as every other real LLM/Calendar call in this codebase) with instructions to set `person` to the matched name and keep it out of `title` once it's already captured there. Item 4 needed no separate code change — it was already correctly wired to `person`, just starved of a working `person` field. `tests/regression/knownFamilyMembers.test.js`. Full suite: 59/59 passing.

**Item 2 — image extraction failing entirely (✅ root cause found and fixed).** Roy sent the actual flyer image that failed (a real Hebrew event poster — clean, high-quality graphic, nothing genuinely illegible about it, which pointed away from "the LLM can't read this"). Root cause: WhatsApp represents a shared photo two different ways depending on how the sender sent it — the native "image" message type, or a "document" whose `mime_type` happens to be an image (common when someone deliberately avoids WhatsApp's own compression to keep flyer text legible — very plausibly what happened here, given the image quality). `webhook.js` only ever checked `message.type === 'image'`; a photo shared as a document fell straight through with neither an image nor any text at all, silently landing on `extraction_classification:nothing_usable` → `{type: 'stop', reply: 'none'}` — completely silent, indistinguishable from Meta never having called the webhook at all. Fixed with `resolveImageMediaRef(message)` (exported, pure, unit-tested directly — the real WhatsApp/media-download calls around it aren't, same as every other real integration call in this codebase), which recognizes both shapes. While in this code, also closed the general version of the same silent-failure hole: any message that isn't text, isn't a (successfully downloaded) image, or whose image download itself fails now gets an actual reply saying so, instead of falling through to the same silent stop — with one deliberate exception (a 👍-style reaction to a bot message doesn't get a reply; that would be a new annoyance, not a fix). `tests/regression/imageMessageType.test.js`. Full suite: 67/67 passing.

**Item 5 — the answer to a follow-up question lost the original message's context (✅ fixed).** From Roy's live transcript: "יום שני הקרוב טיפול באומנות לגאיה" ("art therapy for Gaia this coming Monday") → bot correctly extracted title + person + resolved the relative date, had no time, and asked "Got it — טיפול באומנות on 2026-08-31. What time?". Roy replied "8:30" and the bot created `<UNKNOWN>, 2026-08-27 08:30 — added ✅` — title gone, date reset to today, person dropped. Root cause: the "What time?" prompt (`qualifyReply`, the `write_task_tentative` → `needs_time` branch) had no counterpart handling for the *answer*. A bare "8:30" with no WhatsApp quote/reply metadata went through the full pipeline as a brand-new message — the LLM parsed a two-character fragment in isolation, so everything the first turn had already resolved (title, the relative date, the person) was simply not in scope. The quote-reply path (`handleCorrection`) was no better for this shape: it only knew how to patch an already-written Google event, and a `needs_time` row's `resulting_event_ref` points at the tentative *task*, so a quoted "8:30" answer set state to `corrected` and still created nothing on the calendar.

Fix (`pipeline.js` step 3b + `promotePendingEventWithTime`): a bare-time message — `commands.js`'s new `isBareTimeAnswer`, deliberately strict so a real standalone request that merely contains a time ("Dentist tomorrow 9am") still goes through normal extraction — from a sender who has a `needs_time` row parked within the last 12h (`extractionLogRepo.findRecentPendingFollowUp`) is treated as the answer to that question: the time is merged into the *stored* `ai_candidate` (title, date, person all kept), the event is promoted straight to the calendar via the shared `calendarPayloadFromCandidate` helper (extracted from the `write_calendar` branch so the two paths can't drift — same lesson as the `end_time`/duration bug), the tentative task is retired so it doesn't linger in "list tasks", and the original log is repointed at the real Google event so "undo" still works. The `handleCorrection` path now recognises the same `state === 'needs_time'` case and routes to the identical promotion, so a quoted answer and a bare answer behave the same. No second LLM call in either case. `tests/regression/followUpAnswer.test.js` covers the exact Hebrew transcript above (bare answer and quoted answer), the task-retirement/undo repoint, and the "not swallowed as a follow-up" guard. Full suite: 72/72 passing.

**Item 6 — forwarded messages default to the forwarder, with a correction mechanism (✅ fixed).** A forwarded flyer/schedule often doesn't name who it's for in the text itself (the person is implicit — whoever forwarded it). Design confirmed with Roy: always default to the forwarder rather than asking (a forward can just as easily be a friend's plan as a family one, and asking on every forward would be more annoying than an occasional wrong guess); state the assumption explicitly in the confirmation so it's never silently wrong; support correcting it afterward, bounded to a short window rather than left open-ended.

Detection: `webhook.js` reads Meta's own `message.context.forwarded` flag (distinct from `context.id`, which is reply/quote metadata) into `wasForwarded`, and resolves `senderFamilyMember` via the existing `source_mappings` table (same lookup the bot already uses to know who's messaging it). `classify.js`'s `applyForwardedSenderDefault(candidate, {wasForwarded, senderFamilyMember, familyMembers})` — pure, unit-tested — only overrides `person` when the message was actually forwarded, a real sender→family-member mapping exists, and the LLM didn't already resolve a real family member's name from the text (`matchSingleFamilyMember`, requires exactly one confident match — an ambiguous or absent match doesn't count as "already resolved"); sets `personAssumed: true` on the candidate when it fires. `confirmReply`/`qualifyReply` both grew a shared `assumedPersonNote()` that appends "(assumed, since you forwarded this — reply to change who it's for)" only when that flag is set, so the assumption is stated in the same message the user already reads, not a separate one.

Correction: `classify.js`'s `matchBarePersonCorrection(text, familyMembers)` recognizes a reply that is *just* a family member's name plus filler ("Theo", "actually Theo", "change it to Theo", Hebrew equivalents) — strict on purpose, so a message that happens to name someone but is clearly its own new request isn't swallowed. Two trigger paths in `pipeline.js`, both reusing the same `applyPersonCorrection` helper (updates the written Calendar event's `colorId` via `resolveEventColorId`, marks the original log `corrected`, replies "Updated — that's now for X ✅"): a bare-message correction (no quote), checked against `extractionLog.js`'s new `findRecentWrittenCalendarEventBySender` (most recent `written` Google-calendar row for that sender); and a quoted-reply correction inside `handleCorrection`, checked directly against the quoted log. Both bounded to 10 minutes since the event was written (Roy's call — tight enough that an unrelated later name-mention isn't misread as a correction of a stale event; kept short deliberately, unlike the 12h window item 5 uses for a still-open time question, since a *written* event is a much easier thing to accidentally mismatch a later message against). `tests/regression/forwardedSenderDefault.test.js` — pure-function coverage for all three new functions plus 7 full-pipeline integration tests (forwarder default, non-forwarded unaffected, already-named-so-not-overridden, bare correction, quoted correction, correction outside the 10-minute window not applied, a genuinely new request naming someone else not swallowed as a correction). Full suite: 83/83 passing.

**Item 7 — color picker UI applying a different shade than what was shown/picked (✅ fixed).** `FamilyMembersStep.jsx`'s color swatches dimmed every *unselected* color to `opacity: 0.55` — so every swatch read as a lighter, washed-out pastel of itself right up until tapped, then visibly snapped to a darker, more saturated shade once selected (`opacity: 1`), because that full-opacity value was always what actually got applied to the Calendar event — `personPalette` is the real hex, there's no separate "swatch tint" concept. Fixed by dropping the opacity dimming entirely; "selected" now reads purely from the existing ring (`boxShadow`), so what's shown always matches what's assigned. Frontend-only — verified visually in the browser preview (swatches now measured at `opacity: 1`, true RGB values, via the real Family Members settings screen) rather than with an automated test, consistent with how this codebase treats presentational-only CSS.

**Additional bugs found live-testing item 6 (✅ fixed) — all three traced back to one missing piece.** Roy forwarded a real message and reported: the created event didn't carry his assigned color, a time-range answer ("8:30-18:00") to the bot's "What time?" only kept the start time, and the confirmation didn't state who the event was for.

The color/owner bugs were the *same* root cause: `source_mappings` — the table `webhook.js`'s `senderFamilyMember` lookup depends on for item 6's default to fire at all — had an `insert` function (`sourceMappingsRepo.create`) that **nothing in the app ever called**. Onboarding's "Connect WhatsApp" step (and its Settings Home reuse) only ever recorded a number on `bot_config`'s accepted-senders allowlist, never who it belongs to — so `senderFamilyMember` silently resolved to `null` for every real message, for every family, since item 6 shipped. A second, compounding bug: even a manually-inserted row would have failed to match anyway — WhatsApp's webhook gives sender numbers as bare digits (`botConfig.js`'s own `normalizePhone` exists for exactly this), but onboarding's phone field invites a human `"+1 555-123-4567"` format, and `source_mappings` matched on the raw typed string.

Fixed: `sourceMappingsRepo` now normalizes on read and write (`findByIdentifier`/`create`), and gained `upsertSender` (find-then-update-or-create in JS, not `ON CONFLICT` — no precedent for it against pg-mem in this codebase, so kept consistent with the rest of the repo layer). `routes/botConfig.js`'s `POST /bot-config/confirm` now accepts an optional `familyMemberId` and calls it; `GET /bot-config` returns the current `senderMappings` so the client can reflect state. `WhatsAppStep.jsx` (onboarding step 5 *and* its Settings Home reuse) gained a "Whose number is this?" family-member picker, shown regardless of connected state — not just while first connecting — specifically so an *already*-connected number (every existing family, including Roy's own) can be retroactively linked without a fresh reconnect: re-enter the number (pre-filled when there's exactly one), pick the person, hit Save. `tests/regression/senderLinking.test.js` covers `upsertSender`'s create/re-link behavior, the format-mismatch round-trip, and a full reproduction (unlinked family member's forwarded-default and color silently no-op, then works once linked) exercising the pipeline exactly as production does it.

The time-range bug was separate: `promotePendingEventWithTime` (item 5's follow-up-answer merge) only ever extracted a single time from the reply (`parseCorrectedTime`'s regex takes the first match and stops), so a real duration given in the *answer* to "What time?" was silently dropped — the same class of bug item 1 fixed for the *initial* message, just never carried over to this later merge path. Fixed with `commands.js`'s new `parseCorrectedTimeRange(text)`, which also looks for a second time-shaped match after the first; wired into both follow-up-promotion call sites (bare-answer step 3b and the quoted-reply branch in `handleCorrection`), merging `end_time` alongside `time` into the promoted candidate — `calendarPayloadFromCandidate` already knew how to use it, it just never received it from this path. `isBareTimeAnswer`'s filler-word list also gained `to/until/till/through` (and Hebrew `עד`) so a range phrased as "8:30 to 18:00" (not just "8:30-18:00") is still recognized as an answer, not misrouted to fresh extraction. `tests/regression/followUpAnswer.test.js` covers both. Full suite: 91/91 passing.

**Known gap closed: reminder sends outside the 24h WhatsApp window (✅ code fixed, template needs Roy's one-time Meta submission).** `messenger.js`'s `send()` now catches Meta's specific rejection for this (error code `131047`, "re-engagement" — more than 24h since the customer's last message) and retries once as a `type: "template"` send via the new `sendTemplate()`, rather than trying to predict the window in application code (fragile — depends on the *user's* last message time, which this app doesn't track). This only ever engages for a reminder fired well after its triggering message; the capture → confirmation reply is always inside the window and unaffected. `tests/regression/reminderTemplate.test.js` covers the pure error-shape recognizer (`isReengagementWindowError`) the same way `isReauthRequiredError` is tested for Calendar — the real Graph API calls around it aren't.

This only works once a real template exists and is Meta-approved — that's a one-time manual submission only Roy can make (it needs his own Meta Business Manager access). Template to submit, in Meta's format:

| Field | Value |
|---|---|
| Name | `reminder_notification` |
| Category | `UTILITY` (not Marketing — avoids the opt-out-footer requirement and gets faster review; a reminder for something the user explicitly asked for qualifies) |
| Language | English (en_US) — the template's own fixed text is English; the `{{reminder_text}}` variable itself carries whatever language the reminder text is in (Hebrew included), which Meta doesn't validate against the declared language |
| Type of variable | Text (not Number) |
| Header | `Family App Reminder` (plain text, no variable) |
| Body | `⏰ {{reminder_text}} — sent by your Family App assistant.` |
| Sample for `{{reminder_text}}` | `Reminder: pick up the dry cleaning at 5pm` |
| Footer / Buttons | none |

Revised three times against Meta's real form: (1) WhatsApp Manager requires a *named* variable (lowercase + underscores, e.g. `{{reminder_text}}`), not the older positional `{{1}}`, and rejects one placed at the very start or end of the body; (2) a body that's just the variable plus a period ("too many variables for its length") needs more static text around it — Meta checks a fixed-text-to-variable ratio, not just position; (3) this account's form requires a Header, despite it being labeled "Optional" — given a plain static one, no variable needed there. The body's own fixed text still deliberately carries no "Reminder:" of its own because `reminders.js`'s `scheduleReminder` already builds `Reminder: {title}` into the text passed in as `{{reminder_text}}` — a template-side "Reminder:" too would double it up. `messenger.js`'s `sendTemplate()` sends the matching `parameter_name: "reminder_text"` on the API call, not a positional-only parameter, so it must stay in sync with whatever name is actually approved.

Submit at Meta's WhatsApp Manager: **https://business.facebook.com/wa/manage/message-templates/** (select the right WhatsApp Business Account first if more than one is available). Once Meta approves it (usually within a few hours to a day), no further action is needed — the fallback in `messenger.js` picks it up automatically. If the approved template's name, language, or variable name ends up different from the table above, set `WHATSAPP_REMINDER_TEMPLATE_NAME` / `WHATSAPP_REMINDER_TEMPLATE_LANGUAGE` / `WHATSAPP_REMINDER_TEMPLATE_PARAM_NAME` in Railway's env vars to match (all three default to the values above).

**Fix (found while investigating item 2): kid dashboard showing "couldn't load" indefinitely — dead Google refresh token never distinguished from a transient hiccup.** Roy reported "the dashboard view is broken," screenshotting the generic "Couldn't load tomorrow's board — try again in a bit" state. Checked real Railway logs (not guessed) and found the actual cause: `GaxiosError: invalid_grant` — Google refusing to refresh the access token because the refresh token itself is dead. Very plausibly the OAuth consent screen still being in "Testing" publishing status, where Google expires unused refresh tokens after 7 days — this is not a transient API blip; retrying the exact same request will never succeed, only reconnecting will. `dashboard.js` was treating every `calendar.listEvents` failure identically (`error: 'calendar_unavailable'`, "try again in a bit"), which for this specific cause is permanently, silently wrong advice. Fixed with `calendar.js`'s `isReauthRequiredError(err)` (checks both `err.response.data.error === 'invalid_grant'` and the error message, since that's what's actually visible in the logged error), which lets `dashboard.js` return a distinct `error: 'reauth_required'`; `TomorrowBoardPage.jsx` now shows "Calendar connection expired" with a real "Reconnect Google Calendar" button (linking straight to the existing `/auth/google` flow — re-authenticating the same account from an already-signed-in session lands back in the same family and refreshes the same credentials row, per backlog 1.3's multi-parent sign-in logic) instead of a dead-end "try again" that would loop on this specific failure forever. `tests/regression/reauthRequired.test.js`. Full suite: 62/62 passing.

(Superseded — see "Known gap closed: reminder sends outside the 24h WhatsApp window" above for the actual fix and the template text submitted.)

---

## Post-launch fix/feature backlog (Session 1 live testing)
Found by Roy testing the live Phase 1 build (Aug 2026). From this point, Claude Code owns this doc and
its implementation directly — no separate planning-chat handoff. Grouped by area; priority/dependency
notes are Roy's own from the handoff, kept verbatim where useful. Status updated in place as items land.

**Onboarding & family member management**
- Photo upload per family member during onboarding (currently no upload path — mocks show an "Add
  photo" affordance but there's no backend for it yet). — **deferred to Phase 2** (Roy's call, Aug 2026
  post-launch triage) — icon+color already covers member identification for Phase 1; not worth the
  storage/upload-endpoint work until the rest of this backlog lands.
- Edit/remove an existing family member, from both onboarding and Settings → Family Members. — ✅ fixed
- **Multi-parent / shared family support — ✅ fixed.** First parent creates the family and can generate
  an invite code/link (Settings → Invite a Co-Parent, and a late onboarding step); second parent joins
  the *same* family (shared calendar, shared kid profiles/WhatsApp allowlist, equal permissions — see
  "Fix: multi-parent / shared family support (backlog 1.3)" in the build log below for the full design
  and the real bugs caught while building it.

**Calendar configuration — ✅ fixed**
- No way to choose which Google Calendar events get written to — currently defaults to whichever
  calendar `google_credentials.calendar_id` was set to at OAuth time (effectively the signed-in parent's
  primary calendar). Needed: let a family designate a target calendar (e.g. a shared family calendar
  distinct from either parent's personal one). Fixed: see "Fix: calendar selection (backlog 2.1)" in
  the build log below.

**Settings navigation — ✅ fixed**
- No back button from Settings Home to the kid dashboard, and none from a settings sub-page back to the
  Settings Home menu. Fixed: `PhoneFrame`'s new `onBack` prop renders a small back arrow (top-left, same
  treatment as the dashboard's settings gear); wired into Settings Home, the PIN gate, and every settings
  sub-page. Onboarding's own use of `PhoneFrame` deliberately has no `onBack` — nothing to return to mid-signup.

**Event audience & kid visibility — ✅ fixed**
- Events have no audience concept — nothing distinguishes "for a parent" from "for a specific kid."
  Needed: extraction/assessment tier should identify intended audience; when ambiguous or missing, the
  bot should ask a clarifying follow-up rather than guess or silently default.
- Kid dashboard should filter by that audience field once it exists — parent-only events hidden from
  kids by default; only events explicitly aimed at (or including) a kid show on that kid's dashboard.
- *(Nice-to-have, not blocking)* per-event manual show/hide-from-kids override, as an escape hatch on
  top of the automatic audience default.
- Fixed: see "Fix: event audience & kid visibility (backlog 4.1-4.3)" in the build log below — scope
  ended up narrower than originally written above once the kid dashboard's actual current shape (one
  shared board, not per-kid views) was accounted for; see that entry for why.

**Date parsing bug — high priority, silent correctness bug — ✅ fixed**
- "Tomorrow" (and likely other relative dates) resolved to the wrong calendar date in real testing —
  observed one day later than intended. No visible error; this is the dangerous kind of bug (wrong data,
  not a crash). Fixed: see "Fix: 'tomorrow' resolving one day too late" in the build log below.

**Reminders — multi-parent routing** *(depends on multi-parent support above)*
- Once multiple parents can be connected to one family, a reminder must go to whichever parent
  created/requested it, not broadcast to every connected number and not silently default to the wrong
  (or no) recipient. Blocked on the multi-parent data model existing first.

**Multi-language support — explicitly deferred, not immediate**
- Hebrew support for both LLM extraction/reply generation and the client UI, noted now so future
  decisions don't paint the app into a corner. Right-to-left layout is explicitly out of scope for now
  (a larger overhaul) — noted, not to be built yet.

---

## Live testing round 2 — additional items (Aug 18 2026)

**Color coding: match Google Calendar's own event colors — ✅ fixed**
- Events written to Calendar should carry the color of the family member(s) they're for, and that color
  needs to be the *same* color as what's shown in our own UI (family member picker, kid dashboard) — not
  just a visually-similar one. Google Calendar only accepts event color from its own fixed 11-color
  palette (`colorId` 1–11), so our UI's assignable person-color palette needs to be exactly those 11
  colors, not an independently-chosen set. For an event involving more than one person (or an
  unmatched/ambiguous `person` field), fall back to one default color rather than guessing.
  Fixed: `server/src/integrations/googleColors.js` is now the canonical list (11 Google colorIds + hex);
  `web/src/theme/tokens.js`'s `personPalette` matches it value-for-value; `resolveEventColorId`
  (`pipeline/classify.js`) matches `candidate.person` against real family members and threads `colorId`
  into every Calendar write, defaulting to Graphite (colorId 8) for no/ambiguous match. Note: the app's
  own UI chrome (buttons, progress dots) keeps the original soft mock-derived accent colors
  (`color.personPurple` etc. in tokens.js) — those are unrelated generic accents, not tied to any family
  member's identity, so they didn't need to change.

**Photo/flyer message extraction — ✅ fixed (image support), Hebrew case not yet independently confirmed**
- A forwarded photo (a Hebrew-language flyer) produced no extraction at all. Root cause: the webhook
  handler only ever read `message.text.body` — image messages were never handled at all, despite being
  one of the three intake channels this doc scopes for Phase 1 ("Photo of a flyer/schedule"). Fixed:
  `webhook.js` detects `message.type === 'image'`, downloads the media via `messenger.js`'s new
  `downloadMedia()` (two-step Meta Graph API fetch: media ID → signed URL → bytes), and `llm.js`'s
  `extract()` now sends it to Claude as an actual vision content block instead of plain text; the system
  prompt explicitly says the image may be in any language, including Hebrew, and to extract without
  translating. Not covered by the automated test suite (same boundary-layer testing philosophy as the
  rest of `integrations/` — verified via real usage, not mocked unit tests) — needs a real retest with an
  actual forwarded photo to confirm the Hebrew case specifically now extracts correctly.

**Reminder routing: a pure reminder request became a calendar event instead of a task — ✅ fixed**
- "Remind me to do the laundry at 22:30 today" created a Calendar event titled "laundry" at 22:30,
  rather than going through the tasks + reminder mechanism as expected. Root cause: `extraction_classification`
  only ever looks at date+time field *presence* to route Calendar vs. tasks — it doesn't distinguish "a
  real event with its own date/time" from "a personal task whose only date/time IS the reminder time."
  Fixed via a new `isPureReminder` fact (true when `reminder_requested` and the extracted `date`/`time`
  exactly match `reminder_datetime`) and a new `extraction_classification:pure_reminder` rule at priority
  5 (before `date_time`'s 10) routing to a single task-with-reminder, no Calendar write. When they *don't*
  match (e.g. "remind me to pack the gym bag Thursday night, gym class is Friday 9am" — a real event plus
  an unrelated reminder, acceptance fixture 7's shape), the existing calendar-write-plus-separate-reminder
  behavior is unchanged and covered by a regression test alongside the new case.

**Settings back button: spacing regression, ✅ fixed — a real React inline-style gotcha worth remembering**
`PhoneFrame`'s `onBack` support was first added with `paddingTop: onBack ? 24 : undefined` sitting alongside
the existing `padding` shorthand in the same style object. React does **not** skip a style key whose value
is `undefined` — it actively clears that specific longhand, even one just set moments earlier by a shorthand
key processed first in the same object. So on every screen without `onBack` (all of onboarding), this wiped
out the entire top padding, jamming the progress dots and every screen's content flush against the rounded
top corner. Fixed by only including `paddingTop` in the style object at all when `onBack` is truthy
(conditional spread), rather than including the key with a nullish value — the general lesson: never mix a
CSS shorthand and one of its own longhands in the same React inline-style object where the longhand's value
might be `undefined`; omit the key entirely instead of passing `undefined`.

---

## Live testing round 3 (Aug 28 2026) — mobile layout + color picker follow-ups

**Color picker curated to a calmer palette (✅ fixed, Roy's call).** Roy: the full 11 Google Calendar
colors read too "busy"/harsh on the calendar itself. Google Calendar only accepts `colorId` from its
own fixed 11 — there's no way to submit a custom pastel hex — so "calmer" can only mean offering a
curated *subset* of those 11, never new color values. Presented three options (drop the 2 boldest, drop
down to 5 clearly-muted ones, or no change); Roy picked the middle ground — `tokens.js`'s new
`personPickerColors` drops Grape (vivid magenta), Peacock (vivid blue), Tomato (bright red), and
Graphite (already reserved as the "no match/shared" default color — offering it as a deliberate personal
choice too would be confusing right alongside that meaning), keeping Lavender/Sage/Flamingo/Banana/
Tangerine/Blueberry/Basil. `personPalette` (the full 11, matching `googleColors.js` value-for-value)
stays untouched and authoritative for hex↔colorId resolution — an existing member already assigned one
of the dropped colors keeps resolving correctly; only *new* picks steer into the calmer set
(`FamilyMembersStep.jsx`'s `nextUnusedColor` and the swatch row both switched to the curated list). If
someone already has a dropped color, their current swatch is appended as an extra, real, pickable option
in their own edit card — so editing them never shows *no* ring selected, which would've looked like their
color went missing.

**Mobile layout: color/icon rows silently shrinking instead of wrapping (✅ fixed) + a genuine landscape
content-collapse bug (✅ fixed).** Roy: icons overflow the edge in portrait; almost nothing renders for
Family Members edit in landscape except the header and Save. Investigated directly in the browser at
real mobile viewport sizes rather than guessing from the code.

Root cause of the "overflow": nothing technically overflowed the card's edge — the color row
(`display:flex`, no wrap, 11 fixed-40px circles needing ~540px) and the icon grid (`repeat(7,1fr)`) both
just quietly shrank via default flex-shrink to fit whatever width a real phone's card actually has
(~250-290px content area after the card's own padding) — 40px circles down to ~22px, comfortably
tappable icons down to ~30-36px. Nothing crashed or clipped, it just became cramped enough to read as
broken. Fixed: the color row is now `flexWrap: 'wrap'` with `flex: '0 0 auto'` per swatch (real, fixed
40px circles, spilling onto a second/third line instead of shrinking); the icon grid switched from
`repeat(7,1fr)` to `repeat(auto-fill, minmax(40px,1fr))` (same idea — a real floor, wraps instead of
shrinking). Verified in the browser at a real 375px-wide viewport: color swatches and icons both render
at full, comfortable, uniform size now.

Root cause of the landscape collapse: `PhoneFrame`'s card is a fixed `height:812` capped by
`maxHeight:'92vh'` — in landscape (~375px real device height), that caps to ~345px. `FamilyMembersStep`'s
own content area is `flex:1` with `overflowY:'auto'` and no minimum height; per the flexbox spec, an
`overflow:auto` flex item's automatic minimum size is 0 (not its content's natural size) — so when the
fixed-size siblings (title block, Save button) already claim more than the ~345px available, the
flexible middle section gets squeezed to *literally* 0px, not just "small." An `overflow:auto` box at 0
height renders nothing, not even a scrollbar — reading exactly as "everything but the header and Save
vanished," confirmed by directly measuring `scrollHeight`/`clientHeight` in the browser. Fixed with a
`minHeight: 220` floor on that section (160 for `CalendarSettings.jsx`, which had the identical
vulnerable pattern, `flex:1`+`overflowY:auto`+no floor) — this forces the *outer* `PhoneFrame` card
(which already has its own `overflowY:'auto'`) to pick up the overflow instead, making the whole card
scrollable as a unit. Confirmed in the browser at a real 812×375 landscape viewport: content that used to
render as literally nothing now shows a real, scrollable peek, and scrolling the card all the way down
reaches the full color/icon rows and a working Save button. Also made `PhoneFrame`'s card width explicit
(`width: 'min(390px, 100%)'` instead of a bare `width: 390` that happened to work only because it's a
flex child that gets implicitly shrunk) — same rendered result on every browser tested here, but the
intent is now a real CSS rule instead of a side effect of flexbox internals.

**WhatsApp Connection's family-member picker — investigated, not reproduced, hardened regardless.** Roy
reported the "Whose number is this?" picker (added for item 6's sender-linking fix) isn't showing at all
in Settings → WhatsApp Connection, guessing it's onboarding-only. Traced the code path directly: the
picker is gated only on `members.length > 0`, with no `editMode` distinction — should render identically
in both places. Tested in the browser at a real mobile portrait viewport (375×812, not the taller desktop
size used when this was first verified) with a real family member present, and it rendered and worked
correctly — could not reproduce the bug as described. Found and fixed a real robustness gap while
investigating, regardless: `getFamilyMembers()` had no `.catch()`, so a failed fetch for *any* reason
(network hiccup, a session edge case) would leave the picker silently absent forever with zero
indication why — identical in appearance to "you have no family members yet," a completely different,
actionable situation. `WhatsAppStep.jsx` now distinguishes loading / loaded-but-empty ("Add a family
member first...") / failed-to-load ("Couldn't load family members — reload and try again") and logs the
real error to the console for the failed case. If this still doesn't show up for Roy after this deploys,
the next step is a screenshot of the actual screen or a browser console check on his device — nothing
further to chase blind without one of those.

Frontend build clean throughout; backend untouched by any of these four (no server test suite changes needed).

**Calendar selection (backlog 2.1) silently reverting to 'primary' on reconnect (✅ fixed).** Roy: events
still land on his own personal calendar, not היומן המשפחתי (the family calendar), despite having
explicitly selected it in Settings → Calendar. Confirmed with him directly that he *had* selected it —
this ruled out "never configured" and pointed at a real regression. Root cause:
`googleCredentialsRepo.upsert()` is called on *every* OAuth round-trip — the very first connect, a
reconnect after a dead refresh token (the "Reconnect Google Calendar" flow from the `invalid_grant` fix
earlier this doc), or any later re-sign-in — and `auth.js`'s callback never passes a `calendarId` on any
of those calls, only the token fields. `upsert()` defaulted the missing `calendarId` to `'primary'` and
wrote it **unconditionally** in the UPDATE branch (no `coalesce` guarding it), so any one of those
routine, invisible-to-the-user OAuth round-trips silently discarded whatever the family had explicitly
picked in Settings, resetting back to the signed-in account's own calendar with zero notification that
anything had changed. Fixed: `calendarId` now defaults to `null` ("caller didn't specify one — leave
whatever's already there alone") and the UPDATE does `calendar_id = coalesce($7, calendar_id)`; only the
INSERT path (a genuinely first-time connection, nothing existing to preserve) still falls back to
`'primary'`. `tests/regression/calendarSelection.test.js` adds the exact real-world sequence — select a
calendar, then a same-account reconnect mirroring auth.js's actual call shape — asserting the selection
survives; plus a check that a brand-new connection still gets a sensible `'primary'` default. Full suite:
93/93 passing.

**Missing activity category: "ערב סרט" (movie night) landed on the 📌 pushpin (✅ fixed).** Not a
matching failure — the LLM's `activity_category` classification is deliberately language-agnostic (it's
what makes a Hebrew title resolve to the right icon at all, same mechanism as the shopping/dance
examples already covered by `tests/regression/activityIcons.test.js`) — the real gap was that there was
no `movie` category anywhere in `activityCategories.js`'s canonical list for the LLM to classify *into*,
English keyword or not. Added `{ category: 'movie', icon: '🎬', keywords: ['movie', 'movie night',
'cinema', 'film'] }`; since the LLM's schema enum and the DB-seeded keyword list are both derived
directly from this one array (see the file's own header comment), no other code changed. Only fixes
*future* movie-night events — an already-created Calendar event has its `activityCategory` baked into
`extendedProperties` at write time, so Roy's existing "ערב סרט" event keeps showing 📌 unless
recreated; there's no reclassify-in-place mechanism (yet — same "nice-to-have" gap as the audience
manual-override item noted earlier in this doc). Separately worth noting: `ensureFamilySetup`'s
icon-seeding is all-or-nothing (`existingIcons.length === 0`) — an *already-provisioned* family (Roy's)
won't retroactively get the new `movie` row added to its own `activity_icons` table, so the fast
English-keyword path (`resolveIcon`) won't short-circuit for a future English "Movie night" title either
— but the fallback (`iconForCategory`, which reads the canonical list directly, not per-family DB rows)
still resolves it correctly regardless, so this has no user-visible effect, just a minor efficiency note
for later. `tests/regression/activityIcons.test.js` covers the exact Hebrew case. Full suite: 94/94
passing.

*(Superseded by the entry immediately below, same day — Roy's follow-up: patching one missing category
at a time doesn't scale; stop gatekeeping icons behind a fixed list entirely.)*

**Icon selection redesigned: the LLM picks a real emoji directly, no fixed category list gatekeeping it
(✅ fixed, Roy's call).** The `movie` category fix above was still the old pattern: someone has to notice
a gap and hand-add one more `{category, icon, keywords}` entry, every time, forever — Roy's explicit
feedback: "we should have the full spectrum... we don't need to gatekeep this part... it should be of no
additional cost." Redesigned rather than patched again:

- `llm.js`'s extraction schema replaces the old `activity_category` **enum** field (constrained to
  `activityCategories.js`'s fixed list) with a free-text `activity_icon` field — the LLM picks *one
  emoji* that genuinely fits the activity, in any language, not from any predefined list. Same required
  field in the same single extraction call as everything else (title/date/time/etc.) — **no second LLM
  call, no added cost**, just a different value in the one call that was already happening.
- `classify.js`'s new `sanitizeActivityIcon()` validates the response before it ever reaches a real
  Calendar event: rejects anything containing a plain letter/digit (a leftover category word slipping
  through instead of an emoji), anything implausibly long for one emoji, or anything with no recognizable
  pictographic character — falls back to 📌 only for a genuinely malformed response, not as the routine
  path. A forced tool call still doesn't guarantee a clean single emoji, so this runs both at write time
  and again on read (an already-approved icon isn't trusted forever without the same check a fresh one
  gets).
- `calendar.js` stores it as `extendedProperties.private.activityIcon` (replacing `activityCategory` for
  all new writes) — the dashboard reads this straight through, no category-to-icon lookup needed at all
  anymore for anything written from here on.
- **Backward compatible on purpose:** `activityCategories.js`'s old list and `iconForCategory()` aren't
  deleted — they still back the free English-keyword fast match (`activityIcons.js`'s
  `resolveIcon`/`DEFAULT_ICONS`, unrelated to the LLM's field, still useful, still free) and now serve as
  a **read-time-only fallback** for any event written before this change, so an old event doesn't regress
  to the pushpin. `dashboard.js`'s `resolveEventIcon` priority: keyword match, then the icon actually
  stored on *this* event (re-validated), then the legacy category mapping for pre-change events, then 📌
  as the true last resort. No new "movie" categories (or any other) ever need adding again — this was the
  last one.
- `tests/regression/activityIcons.test.js` rewritten for the new shape: `sanitizeActivityIcon` validation
  (real emoji accepted, plain words/phrases/empty rejected), the full priority chain including a
  legacy-event case, a real pipeline write for something with **no category ever defined for it**
  (camping trip → 🏕️, proving the "no gatekeeping" claim concretely, not just re-testing movie night), the
  original movie-night bug itself, and a malformed-LLM-response case sanitized before it's written. Full
  suite: 96/96 passing. Frontend untouched (icon is already fully resolved server-side before reaching
  the client).

**Confirmation message still leaving out who an event was for — a self-inflicted scoping mistake (✅
fixed).** Roy's complaint kept recurring across multiple rounds of item 6 testing even after the
forwarded-sender-default note shipped: "the confirmation... were still missing the confirmed event party
it was set for." Root cause was my own original scoping call, stated explicitly in the code comment at
the time: `assumedPersonNote` (classify.js) only ever added " for X" when the person was *assumed* (the
forwarded-sender default) — a plainly-stated person, resolved with full confidence from the message
itself, got no mention at all, on the reasoning that "that case already reads fine without narration."
That reasoning was simply wrong per Roy's actual, repeated expectation: renamed to `personNote` and
broadened to state who the event is for whenever `person` is known at all — the "(assumed, since you
forwarded this...)" qualifier still only appends for the actual forwarded-default case, unchanged.
Affects both `confirmReply` (the ✅ confirmation) and `qualifyReply` (the "What time?" follow-up
question) identically. `tests/regression/forwardedSenderDefault.test.js`'s existing unit test rewritten
(it had explicitly asserted the old, now-wrong behavior — `doesNotMatch(confirmReply(stated), /for
Dana/)` — a real example of a test locking in the actual bug); `tests/regression/eventColor.test.js`'s
existing real-pipeline write test gets new assertions on the reply text itself, not just the written
event's fields, per the standing principle that a confirmation's actual wording is a real, separate
thing to verify from what got written behind the scenes. Full suite: 96/96 passing.

**Kid dashboard card color didn't match the assigned kid color (✅ fixed) — two independent "who is
this for" resolutions that could drift apart.** Roy: dashboard card colors don't match the assigned kid
color. Root cause: `dashboard.js`'s `matchMembersToEvent` decided which family member(s) a card belongs
to (and therefore its color, via `scheduleLogic.js`'s `colorForMember`) by scanning the Calendar event's
**title/description text** for a family member's literal name — a completely separate, independent
guess from the *actual* match already made and colored at write time (`classify.js`'s
`calendarPayloadFromCandidate` → `resolveEventColorId`). Most real titles never contain the person's
name at all — "Dance class" for Mia, "Dentist" for Theo, "Commanders Day" for Roy — so the text-scan
found nothing, and the card silently fell back to a neutral/gray background even though the real
Calendar event had been correctly colored the entire time. Two independent resolutions of the same
question, free to drift apart — this was always going to eventually disagree.

Fixed at the source: `calendarPayloadFromCandidate` now also stores the *same* matched family member's
id as `extendedProperties.private.personId` (alongside the `colorId` it was already deriving from that
identical match), and `dashboard.js`'s `matchMembersToEvent` reads that back directly instead of
re-guessing — one resolution instead of two. The old text-scan isn't deleted: it still runs (a) as the
fallback for any event written *before* `personId` existed (so nothing regresses), and (b) unioned
alongside a stored `personId` to catch a *second* person genuinely named in the message text — the
extraction pipeline only ever resolves one `person` field, so text-matching remains the only way the
existing 2-person-stripe / 3+-avatar-stack card styles (`scheduleLogic.js`'s `cardBackground`) can ever
detect more than one participant.

Item 6's person-correction path (`applyPersonCorrection`) also needed to repoint `personId`, not just
`colorId` — otherwise correcting who an event is for would leave the dashboard showing the *old*
person's color, the exact same drift bug this fix exists to close. Deliberately **not** trusting
Calendar's PATCH to merge `extendedProperties.private` correctly on a partial update (unverified
whether it merges the nested map per-key or replaces it wholesale — guessing wrong would silently wipe
`audience`/`activityIcon` on every correction, a real visibility bug, not a cosmetic one): the
correction sends the *complete* intended private-props object every time (personId plus whatever
`audience`/`activityIcon` the original write already had, read back from the extraction log), the same
way `createEvent` always has, rather than a partial `{personId}}` patch.

Only fixes *future* events — same limitation as the movie-icon and multi-round item-6 fixes above: an
already-created Calendar event has no `personId` in its `extendedProperties`, so it still falls back to
the old text-only heuristic until recreated or corrected. `tests/regression/dashboardCardColor.test.js`
(new) covers `calendarPayloadFromCandidate` storing `personId`, `matchMembersToEvent`'s new priority
(stored id, then legacy text fallback, then the two combined for a genuinely multi-named event, then
nothing found), a real pipeline write for a title that never names the person at all (the bug itself),
and a person-correction repointing `personId` while confirming `audience`/`activityIcon` survive
untouched. Full suite: 103/103 passing.

**WhatsApp Connection's Save gave zero feedback either way (✅ fixed).** Roy, testing the re-link fix for
the sender-linking bug above: "the save confirmation is unclear... the save button is still clickable
and no saved confirmation is provided." Real gap, not a misunderstanding — `WhatsAppStep.jsx`'s
`confirm()` had two separate problems. First, for the exact re-link scenario this screen exists for (a
number that's *already* connected), the UI before and after a successful save looked completely
identical — "Connected" was already showing, the button already said "Save" — so a successful save
changed nothing visible at all, no way to tell it had actually happened. Second, `confirm()` had no
`try`/`catch` at all: a failed request (network hiccup, a bad response) would throw straight out of the
function, meaning `confirming` never got reset to `false` — the button stuck permanently disabled with
zero explanation, indistinguishable from "still saving." Fixed with an explicit `saveState`
(`idle`/`saved`/`error`): a green "✓ Saved" confirmation appears next to the button on success
(auto-clears after 3s), a red "Couldn't save — try again" on failure, and the button itself now reads
"Saving…" while in flight. Verified directly in the browser: filled in a number, connected, saved again
(the exact already-connected re-link case) — "✓ Saved" appeared clearly both times. Frontend-only;
backend untouched, full suite still 103/103.

**Follow-up, same conversation: Save should only appear when there's actually something to save.**
Roy: "works though lets present the save button dinamically only in case a change was made." Added an
explicit saved baseline (`savedNumber`/`savedMemberId`, separate from the live form fields) that the
form is compared against — the Save button (already-connected case only; "I sent a message" for a
first-time connect is unaffected, there's no baseline to compare yet) only renders while the form
actually differs from what's persisted, and disappears the instant a save succeeds (the baseline moves
to match). While wiring the baseline, fixed a related latent bug: the initial `memberId` guess and the
`senderMappings` fetch used to run in two independent, unordered `.then()` chains — whichever resolved
last silently won, so the "sole parent" default could clobber a real existing mapping depending on
network timing. Combined into one `Promise.all`, with the real mapping (matched on normalized digits,
same comparison `botConfig.js` uses server-side) always taking priority over the guess. Verified in the
browser end to end: connect a number → Save disappears immediately (nothing left to save); reload the
page → still correctly hidden (the real persisted mapping loads as the baseline, not just a guess);
change the picker to a different person → Save reappears immediately. Frontend-only; full backend suite
still 103/103.

---

## Design system: the Save Changes rule (Aug 2026)

Roy: "keep this saving behavior across all of the app, lets call it save changes... lets have suggest how
to tackle both scenarios that will be applied for all and will create a rule for future ux decision
points for this app." Standing rule for every future edit/settings screen, not just a description of
what shipped this round — read this section before adding a new one.

**The rule itself — one bottom button per screen, its label is the state:**
- **Clean** (nothing differs from what's actually persisted): button reads **"Continue"** and only
  navigates back — no network call, since there's nothing to save.
- **Dirty** (something differs): button reads **"Save Changes"** — saves, then navigates back, as one
  atomic action on success. Never leaves two taps where one will do.
- **On error:** stay on the screen (never navigate away on a failed save), show a plain inline message
  in the same style everywhere (`color: '#b3564a'`, bold 14px, centered), button stays actionable so the
  next tap retries. A save action with no error handling at all was a real, repeated bug this session
  (WhatsApp Connection's original Save, `CalendarSettings`'s `save()`, `FamilyMembersStep`'s
  `saveMember()` all had this independently) — every screen following this rule gets a `try`/`catch`
  around its save call as part of adopting it, not as an afterthought.
- A screen with no prior persisted value to compare against (a first-time WhatsApp connect, onboarding's
  first-time timezone pick) has no "clean" state yet — its button stays a distinct, real call-to-action
  ("I sent a message", "Yes, that's right") rather than a premature "Continue"/"Save Changes" that would
  be misleading before anything exists to compare.

**Scenario 2 — nested list editors (Family Members is the only one today, but the pattern generalizes to
any future "manage a list of things" screen):** two saves, kept deliberately distinct so they're never
confused —
- **Local** (per-item): unchanged from how it already worked — "Save changes" / "+ Add to family" commits
  *that one item* and stays on the screen so the user keeps managing the list.
- **Global** (the whole screen): follows the *same* Continue/Save Changes labeling as scenario 1, but its
  dirty check also has to account for an open, uncommitted local draft. Roy's call on that exact edge
  case: **if the open draft is complete** (has everything a real entry needs — in practice just a name,
  since color/icon always carry a default), **auto-save it** as part of leaving, no extra step. **If it's
  incomplete** (started typing, no name), **don't** silently discard the typed-in work and **don't**
  silently save something half-finished — surface a plain inline message ("{name or 'This person'} still
  needs a name before they can be saved") and stay put. `isDraftPristine`/`isDraftComplete`
  (`FamilyMembersStep.jsx`) are the two checks this decision is built on; keep both when adapting this to
  a future list-editor screen, not just a single "has it changed" flag.

**Explicitly exempt — don't force this pattern onto these, and don't assume a future similar screen
needs it either without checking first:**
- **PIN entry** (`PinStep.jsx`) — submitting a new PIN *is* the action; there's no old plaintext value to
  diff against (only a hash is ever stored), so "clean vs. dirty" isn't a meaningful question here.
- **Pure view/action screens with nothing persisted to edit** (`InviteCoParentStep.jsx`) — just a "Done"
  button that navigates, no save concept, nothing to compare.

**Applied this round:** `WhatsAppStep.jsx`, `TimezoneStep.jsx`, `CalendarSettings.jsx` (scenario 1, all
three previously had a static "Save"/"Continue" pair or a single always-on "Save" with no dirty check and
no error handling), `FamilyMembersStep.jsx` (scenario 2, both the per-item/global distinction and the
uncommitted-draft handling above). Verified directly in the browser for `WhatsAppStep`/`TimezoneStep`/
`FamilyMembersStep` (first-connect stays put and shows "Connected" before offering Continue; a clean
reload correctly shows Continue, not a stray Save; changing a field brings Save Changes back
immediately; an incomplete family-member draft blocks with the message instead of silently discarding or
saving; a complete one auto-saves and leaves) — `CalendarSettings` follows the identical, by-then-proven
pattern but couldn't be exercised live without a real Google Calendar connection. Full backend suite
untouched throughout, still 103/103 (frontend-only across all of this).

---

## Live testing round 4 — items 9 & 10 (Aug/Sep 2026)

**Item 9 — editing the assignee of an existing event via reply didn't work, quoted or not (✅ fixed,
three real bugs, not one).** Roy: "this fails whether the reply quotes the original message or not."
Investigated the real code fresh rather than assuming the earlier item 6 mechanism was intact:

1. **The quoted-reply path reused the bare-reply path's 10-minute window for no real reason.** The
   window exists to guard the *bare* (unquoted) correction against genuine ambiguity — an unquoted name
   sent later could plausibly be unrelated. A **quoted** reply doesn't have that problem: quoting a
   specific message already unambiguously identifies which event is meant, no matter how old it is.
   Applying the same 10-minute cutoff there meant "editing the assignee of an *existing* event" (very
   plausibly more than 10 minutes old) silently failed every time. Removed the age check from the quoted
   path in `pipeline.js`'s `handleCorrection`; the bare path's window is untouched and still guards the
   case that actually needs it.
2. **A quoted reply that matched neither a time nor a person correction got a confidently wrong reply.**
   `handleCorrection`'s fallback used to send `"Updated — {title} now at {time}"` *unconditionally*
   whenever neither the time-correction nor person-correction branch matched — even when `newTime` was
   `null` and nothing had actually changed. A correction attempt the bot didn't understand looked
   identical to one that succeeded. Now replies honestly ("I couldn't tell what to change from that...")
   and leaves the original event untouched when nothing was recognized.
3. **Hebrew commonly attaches a one-letter preposition directly to a name with no space at all** —
   "לגאיה" ("to Gaia") is one token, ל + גאיה, not two words. `matchBarePersonCorrection`'s "the whole
   message must reduce to exactly the name" check correctly found "גאיה" as a substring but then failed
   on the single leftover "ל", since neither filler list covered a bare grammatical prefix. Given Roy's
   real usage is substantially Hebrew, this is very plausibly why the bare-reply path failed just as
   often as the quoted one. Now forgives exactly one leftover Hebrew prefix letter (ל/ב/מ/ה/ו/כ/ש) —
   still rejects a longer leftover, so this stays a narrow grammar allowance, not a loophole. Also
   broadened the English filler list slightly (assign/reassign/make/should/switch/set) to tolerate a
   little more natural phrasing than the original bare-name-plus-tiny-filler-set design.

`tests/regression/forwardedSenderDefault.test.js`: a quoted correction a full day after the event was
written still succeeds; a quoted reply matching neither pattern gets the honest failure reply and leaves
the event untouched; the Hebrew-prefix case with both a positive and a "still correctly rejects a longer
leftover" boundary case; broadened English filler phrasing coverage. **Not changed, and worth noting
explicitly:** the bare (unquoted) path's 10-minute window itself — only what happens *within* it (the
matching logic) was fixed. If corrections still feel too narrow for the unquoted case specifically,
that's a real, separate design question (how long should an unquoted correction stay "live"?) worth its
own discussion, not something guessed at here.

**Item 10 — reminder requests not recognized, created as regular events instead (✅ fixed).** Roy: "This
should be handled as an intent-classification problem, not a keyword match... natural phrasing rather
than requiring a specific trigger word." Confirmed exactly that on inspection: `llm.js`'s
`reminder_requested` field had **no schema-level description at all**, relying entirely on one system
prompt sentence — "Only set reminder_requested to true if the message explicitly asks to be reminded
(e.g. 'remind me to...')" — anchored to one English phrase, not intent. Rewrote both: the schema field
now carries its own real description (judge intent, not phrasing; several varied English/Hebrew examples
— "don't let me forget to...", "ping me about...", "תזכיר לי", "שלא אשכח" — explicitly "any other natural
phrasing... counts"), and the system prompt sentence points to it rather than repeating the old
single-example framing. The real extraction call this feeds isn't unit-tested (same boundary-layer
convention as every other real LLM/Calendar call in this codebase) — `tests/regression/reminderRouting.test.js`
adds a prompt-text assertion confirming the old anchored wording is actually gone, which is what's
directly verifiable here; the classification quality itself needs a real live retest with varied natural
phrasing, in both languages, the same way image extraction and other LLM-judgment fixes have needed
retesting this session.

Two secondary, code-level (fully testable) fixes bundled in since they touch the exact same mechanism:
- **`isReminderOnlyMessage` used a raw string-prefix comparison** between `reminder_datetime` and
  `` `${date}T${time}` `` — trailing seconds or other formatting the LLM's ISO output might carry (e.g.
  `"09:00:00.000Z"` vs. plain `"09:00"`) would silently break an otherwise-correct match, misrouting a
  real pure reminder to a Calendar event. Now compares only date+hour+minute (`slice(0,16)`), robust to
  that formatting variance.
- **The confirmation for a real event that *also* carries a separate reminder request never mentioned
  the reminder at all** — `scheduleReminder` ran right after `confirmReply` was already sent, with no
  trace of it in what the user actually read. This is the item's other explicit requirement ("the
  confirmation reply must explicitly state that a reminder was set"). `confirmReply`'s new
  `reminderNote` appends "(I'll also remind you at {time})" whenever `reminder_requested` +
  `reminder_datetime` are present — the *pure*-reminder case already routes to the distinctly-worded
  `reminderConfirmReply` ("Got it — I'll remind you..."), so there's no risk of double-mentioning the
  same reminder from two different code paths.

Full suite: 108/108 passing. Frontend untouched.

---

## Enhancement backlog (claude-code-enhancements.md) — build in progress

Roy handed over a full capability-expansion backlog (`claude-code-enhancements.md`, kept in
`~/Downloads/`, not in this repo) with an explicit build order and five decisions pre-answered
("DECISIONS — ANSWERED" — build to those, don't re-ask). Building item by item, in that order, each
with its own tests/deploy/verify pass, same discipline as every fix in this doc. This section tracks
progress; the source doc has the full backlog and rationale for anything not summarized here.

**A1 — Read-back queries (✅ built).** The bot could only ever write; this makes it two-way — "what's on
tomorrow?", "מה יש לגאיה ביום שלישי?" get an actual answer instead of silently becoming (or failing to
become) a new event.

- **Intent classification, not a keyword, same lesson as item 10.** `llm.js` now defines a second tool,
  `record_query`, alongside the existing `record_extraction` — `tool_choice` changed from forcing
  `record_extraction` specifically to `{type: 'any'}`, which still guarantees exactly one tool call
  every time (never a free-text non-tool reply), but lets the model choose *which* tool actually fits.
  Still **one LLM call per message**, not two. `extract()`'s return value now carries a `type`
  discriminator (`'capture'` or `'query'`) so callers can branch — fully backward compatible, since a
  capture result still carries every original field at the top level unchanged, and the fake LLM test
  helper's registered candidates (none of which set `type`) fall through to `'capture'` handling exactly
  as before.
- **Pipeline routing:** `pipeline.js`'s `handleIncomingMessage` branches to a new `handleReadBackQuery`
  immediately after the LLM call, before any of the capture-only steps (relative-date override, audience
  override, forwarded-sender default, assessment rules, a write) — none of those apply to "tell me what's
  already there."
- **D-1's two decided filters, reusing existing logic rather than inventing new:** the *exact* audience
  filter the kid dashboard already uses (`shouldShowOnKidBoard`) applies to every query result; a
  person-scoped question ("what does Gaia have Tuesday?") narrows further via `matchMembersToEvent` — the
  same personId-first/text-match-fallback resolution the dashboard-card-color fix already relies on, so
  "whose event is this" is answered exactly one way everywhere it's asked, not a third guess.
- **A real architectural cleanup along the way:** `matchMembersToEvent` used to live in `routes/dashboard.js`
  — reusing it from `pipeline.js` that way would have made pipeline/ depend on routes/, backwards from
  every other dependency in this codebase. Moved it into `classify.js` (the shared pure-logic module both
  already sit on top of); `dashboard.js` now imports it from there instead of defining it locally.
- **`calendar.listEvents` added to the pipeline's injected `calendar` interface** (`webhook.js`), reusing
  the exact same real Google Calendar read `dashboard.js` already calls — no new integration code.
  `calendarConnected` also threads through from `webhook.js` (`!!credentials`) so a query before Google
  Calendar is connected gets a clean "connect it from Settings first" reply instead of a raw thrown-error
  message.
- **Reply formatting:** new `formatQueryReply` (classify.js, alongside the other reply-wording functions)
  — lists matching events with their time (skips the time entirely for a genuine all-day event), or says
  plainly there's nothing, scoped by person/date range when given.

`tests/regression/readBackQueries.test.js` (new): `formatQueryReply`'s own shape (empty/general/scoped/all-day),
a query routing to a read and never creating anything, a query listing a real previously-written event, the
audience filter excluding a `parent_only` event, person-scoping correctly isolating one family member's
events from another's (via personId, not just text), and the not-connected case's clean reply. Full suite:
114/114 passing. Frontend untouched (no UI surface for this — WhatsApp only, matching how every other
bot-facing capability in this codebase works). **Real intent-classification quality itself is unverified**
(same boundary-layer convention as every other real LLM call) — needs a live retest with real, varied
phrasing in both languages, same caveat as item 10.

**A2 — Cancel / reschedule existing events (✅ built).** "Cancel dance class Thursday", "move it to
17:00" — the bot's third intent (`llm.js`'s new `record_management` tool, alongside `record_extraction`/
`record_query`; `tool_choice` stays `{type: 'any'}`, so still one LLM call per message across all three).
D-2's decision, built exactly as specified: when a description matches more than one event, list them
and ask which one — never refuse, never silently guess.

- **Lookup:** `classify.js`'s new `matchEventsByDescription(events, {titleHint, dateHint})` — word
  overlap between the description and the event's title (not exact/substring match, since a real
  description rarely repeats the title verbatim, and either side can be in either language), narrowed to
  an *exact* same-day match when a date hint is given — no partial credit for "close," since a wrong-day
  cancel is exactly the mistake this whole flow exists to prevent. Search window: the hinted date if one
  was given, else 60 days forward from today (canceling/rescheduling something in the past is unusual
  enough not to warrant an unbounded query).
- **Deliberately does *not* apply `shouldShowOnKidBoard`** the way A1's read-back query does — audience
  only controls what the *kid dashboard* shows, not what a parent can manage through the bot. A
  `parent_only` event must still be findable and cancellable here.
- **Disambiguation is a real parked state**, not just a reply: a new `needs_disambiguation`
  `extraction_log` state (schema.sql's CHECK constraint widened via the same idempotent
  `ALTER ... DROP/ADD CONSTRAINT` pattern already established for `families.invite_code`, since
  `CREATE TABLE IF NOT EXISTS` doesn't retroactively touch an existing table's constraint) stores the
  matched candidates (capped at 5) plus the pending action. `commands.js`'s new
  `bareDisambiguationChoice` resolves the sender's next bare reply ("2", "#2", "number 2") the same
  strict way `isBareTimeAnswer` resolves a "What time?" answer — a genuinely new message that happens to
  contain a digit elsewhere must still go through normal extraction, not get misread as picking an
  option. A 30-minute window (`findRecentPendingDisambiguation`) bounds how long the prompt stays live,
  same recency-window philosophy as every other parked-state lookup in this file.
- **Cancel** deletes the real event and retires its original `extraction_log` row (state `'undone'`, the
  same convention the `undo` command already uses — via the new `findByCalendarEventId` lookup) so a
  stale `'written'` row doesn't keep pointing at a Calendar event that no longer exists (which a later
  item-6 person-correction attempt could otherwise try, and fail, to patch).
- **Reschedule** preserves the event's original duration (computed from its own real start/end, not
  reset to a default) and asks "what time should I move it to?" instead of silently no-op-ing when the
  message gives no target time/date at all — a real gap caught while building this: without the guard, a
  bare "move dance class" would default the missing new time to the event's *own current* time, "moving"
  it to exactly where it already was. **A genuine, caught-mid-build bug in the reschedule math itself:**
  computing the new end time by round-tripping the naive wall-clock start/end strings through plain
  `new Date()` + `.toISOString()` silently picked up the *server process's* own local timezone offset —
  the exact bug class `addOneHour`/`localDateTimeToUtcIso` already exist elsewhere in this file to avoid,
  and this hit it anyway. Fixed with two new, narrowly-scoped helpers, `naiveDateTimeToUtcMs`/
  `utcMsToNaiveDateTime` (UTC as neutral scratch space only, same reasoning as `addOneHour`'s own
  comment) — never parse a naive wall-clock string with a bare `new Date()` in this codebase; this pair
  (or `addOneHour`, or `localDateTimeToUtcIso` for a real instant) is why.
- **A pre-existing test fake shape gap surfaced along the way:** `tests/setup/fakes.js`'s `updateEvent`
  only ever unwrapped the real Google patch shape's `extendedProperties.private` back into the fake's
  flat internal storage, not `start.dateTime`/`end.dateTime` — meaning a *pre-existing* acceptance test
  (fixture 6, item 9's time-correction case) was asserting against a stale, never-actually-unwrapped
  nested key that happened to still exist from `...rest` spreading. Fixed the fake to unwrap both
  consistently, updated that one pre-existing assertion to the same flat convention every other field in
  the fake already uses (`written.startDateTime`, not `written.start.dateTime`).

`tests/regression/eventManagement.test.js` (new): `matchEventsByDescription`'s word-overlap and
date-narrowing behavior, `bareDisambiguationChoice`'s strictness, both reply formatters, a real
single-match cancel (event actually deleted, original log retired), the full multi-match →
list-and-ask → bare-number-resolves-it → correct-one-deleted flow, an out-of-range disambiguation reply
changing nothing, a real reschedule preserving duration, the missing-target-time guard, the no-match
case, a `parent_only` event still being manageable, the not-connected case, and the
`naiveDateTimeToUtcMs`/`utcMsToNaiveDateTime` round-trip directly. Full suite: 126/126 passing. Frontend
untouched — same WhatsApp-only surface as A1. **Real intent-classification quality is unverified**, same
caveat as A1/item 10 — needs a live retest with real phrasing.

**A3 — Multi-event extraction from one message (✅ built).** A forwarded school schedule/flyer often
lists several dates at once; the extraction schema only ever had room for one event, so extraction
silently dropped everything past the first — same failure class as the already-fixed duration-loss
bug, just at the message level instead of the event level. `record_extraction` gains
`additional_events`: a reduced per-item shape (no reminder fields, no `category`) carrying anything
beyond the primary item, fully backward compatible with every caller that only ever knew about a
single flat capture. Processed independent of how the *primary* item itself routed
(write/qualify/clarify/stop) — one awkward primary item next to two well-formed additional ones
shouldn't lose the good ones. Each additional item is routed by a plain has-a-time check
(write_calendar vs. a tentative task), not a second pass through the family's own assessment rules
table (real additional items overwhelmingly carry both a date and a time — that's the whole failure
mode this exists to stop losing), and gets the same forwarded-sender person default / explicit
"just us parents" override as the primary item, since both are about the whole message's context, not
anything specific to being first vs. additional. Sent as its own short follow-up message right after
the primary confirmation, deliberately NOT folded into `confirmReply` itself — keeps every existing
single-event confirmReply call site and test byte-for-byte untouched. `writeAdditionalEvent` in
pipeline.js, `formatAdditionalEventsNote` in classify.js.
`tests/regression/multiEventExtraction.test.js` (5 tests): writing/skipping/routing an additional
item, the overrides applying per-item, and the overwhelmingly-common empty-array case staying
single-message.

**B1 — Location capture (✅ built) + B2 — Recurring events (✅ built).** Grouped together per the
backlog (cheap schema additions, high daily value). B1 adds a `location` field, written straight to
the Calendar event's own native location field (`calendar.js`'s `createEvent`) instead of getting
stuffed into the title text, which is what happened before this existed — stated back in the
confirmation too (`locationNote`), same "confirm what was actually understood" pattern as the
existing person/reminder notes. B2 adds a `recurrence` field (`weekly`/`biweekly`/`monthly`/`null`,
judged by intent the same way `reminder_requested` already is — "every Tuesday" vs. "this Tuesday"),
turned into a real RRULE array (`classify.js`'s `buildRecurrenceRule`) on the Calendar event; Google
owns all the actual repeat-occurrence behavior once that's set, no repeat logic to build. A2's
cancel/reschedule composes with this for free: Google's own `listEvents(singleEvents: true)` already
expands a recurring event into individually-addressable instances, so canceling "one Tuesday" of a
weekly event needed no extra code at all. `tests/regression/locationAndRecurrence.test.js` (7 tests).

**C1 — Standing rules taught in conversation (✅ built).** A fourth bot intent (`record_rule`,
alongside create/query/manage): "art therapy is always at the Rothschild clinic", "never remind me
before 07:00", "send the daily briefing at 21:00" get remembered and applied going forward instead of
being treated as one-off events. Per D-3's specific efficiency requirement: the LLM detects
rule-defining intent AND articulates a human-readable `rule_text` in the SAME call (never a second
call to explain back what was just understood); the rule is held as a `'pending'` row in a new
`standing_rules` table, not committed, while the bot asks a plain yes/no; the yes/no reply is matched
directly against that pending row (`commands.js`'s `isYesNoAnswer`, a closed word list) —
`resolveStandingRule` in pipeline.js never re-parses it through the model. Three `rule_kind`s,
deliberately narrower than a free-form conditions/actions blob: `event_default` fills one field
(location/audience/duration_minutes/person) whenever a future message's title/text contains a keyword
(`applyStandingRuleDefaults` — fills gaps only, never overrides something the message itself stated);
`timing_param` changes a named bot setting (currently just the daily briefing's send time, wired up
for D1); `prep_association` (added under D2 below) teaches a packing/prep reminder for a kind of
event. More elaborate rules (day-conditional ownership like "Shani handles Tuesdays, I handle
Thursdays") are still recorded and shown back via `rule_text` for a human to read, but their
*application* is a known, stated scope limit, not a silent gap. Reviewable only via a bot command per
D-3 (no Settings screen): "rules"/"my rules" lists active rules, "delete rule N" removes one by that
numbering. `tests/regression/standingRules.test.js` (9 tests) covers the full propose → pending →
confirm/discard → applied-or-not lifecycle end to end, asserting the "never a second LLM call"
guarantee directly via the fake LLM's call count.

**D1 — Proactive daily briefing (✅ built).** The bot's first proactive (non-webhook-triggered)
behavior: an unprompted evening message, "here's tomorrow," per D-4's exact scope — each parent gets
their own items plus anything involving the kids, default send time 20:00, changeable via a standing
rule (C1) rather than hardcoded. Depends on A1 (same calendar-read + audience-filter reasoning,
different trigger). New `pipeline/briefing.js`'s `sweepDailyBriefings`, run on the same 60s
interval-sweep infrastructure `server.js` already established for the reminder sweep — realistic scale
is one household, so a real queue/cron system solves a problem this app doesn't have.
`shouldSendBriefingNow` (pure — never sent yet today AND the local clock has reached the configured
send time; fires on the first sweep tick at or after it, not only an exact-minute match, since a 60s
poll can't guarantee landing exactly on target) and `isRelevantToParent` (D-4's filter: a parent's own
events, any event involving a kid, and any unassigned event are relevant; only the OTHER parent's own
personal item is excluded — same "when in doubt, show it" default `shouldShowOnKidBoard` already uses
elsewhere) are both pure and directly tested. A new `families.last_briefing_sent_date` column (plain
local date, not a timestamp, compared against the family's own local "today" — idempotent ALTER, same
pattern as `invite_code`) is what actually prevents re-sending for the rest of a day.
`tests/regression/dailyBriefing.test.js` (5 tests), including a real two-parent sweep asserting each
parent's own filtered content and no-resend-same-day, forced to a `00:00` send-time threshold so it's
deterministic regardless of when the suite actually runs.

**B3 — Conflict detection (✅ built).** On create, checks whether the SAME person (via the personId
already resolved onto the new event's own payload — checking every family member would be mostly
noise, not real double-bookings) already has something overlapping that time; appends a note to the
confirmation reply, never blocks the write, per the backlog's own "does not block creation — just
flags." `classify.js`'s `findConflicts` (real interval overlap arithmetic, not just "same day") +
`formatConflictNote`. Best-effort in pipeline.js: a `listEvents` failure during the check is caught
and logged, never lets a conflict-check problem block the actual write.
`tests/regression/conflictAndProvenance.test.js` covers the overlap/no-overlap/different-person cases
and a real double-booking still writing successfully while flagging it in the reply.

**B4 — Provenance in event description (✅ built).** Writes the original WhatsApp message text into
the Calendar event's own description field (`calendarPayloadFromCandidate`'s new `sourceText` option)
— visible weeks later without digging through WhatsApp, and a debugging aid (tells "bot misread a
clear message" apart from "message was genuinely ambiguous"). Repurposes `calendar.js`'s `description`
field cleanly: its only prior writer, `attendeeNames`, was defined but never actually populated by any
caller, so this doesn't compete with or lose any real prior data. Threaded through all three
`calendarPayloadFromCandidate` call sites: the primary write (the raw incoming text), the
follow-up-promoted write (the *original* parked message, not the short "8:30" answer that merely
completed it — `pending.raw_input`), and A3's additional-event writes (the same forwarded message all
of them came from).

**D2 — Preparation awareness (✅ built).** "Events imply tasks: swimming means pack a towel." Depends
on D1 (delivery — this is a new section appended to the daily briefing, not a separate message or a
new write path) and C1 (a taught association reuses the standing_rules mechanism, a new `rule_kind`:
`prep_association`, `match_keyword` = the event-type word, `value` = the prep text). Per D-5, inference
from event type is also approved and never silently written as a task — always a clearly-labeled
suggestion section ("🎒 Possible prep (a suggestion, not added automatically)"). `classify.js`'s
`inferPrepSuggestions`: a Roy-taught association is checked FIRST and wins outright over the built-in
guess for the same title (an explicitly taught fact is more trustworthy than an inferred one); the
small built-in `BUILT_IN_PREP_ASSOCIATIONS` table (English + Hebrew, same "keyword substring against
the title" convention as `activityIcons.js`'s own `resolveIcon`) only fills in when nothing was taught.
Required its own idempotent `ALTER` on `standing_rules_kind_check` (a real migration, not just an edit
to the `CREATE TABLE` text — that table was already deployed live under C1 by the time this was built,
so `CREATE TABLE IF NOT EXISTS` alone would have been a silent no-op on the real database, and the very
first `prep_association` row written in production would have hit a constraint violation; caught
before shipping, not after). `tests/regression/prepAwareness.test.js` (4 tests).

**E1 — Voice notes as input (⏸️ shelved — Roy's call).** Real, verified reason a second AI vendor was
ever on the table at all: Anthropic's own Messages API has no audio-input content type (only
text/image/PDF as of this writing, confirmed directly against the current API reference and vision
docs, not assumed — an audio content block is an open, unresolved feature request on Anthropic's own
SDK repo), so transcription can't reuse `ANTHROPIC_API_KEY` the way image capture reuses it for vision.
The only viable path was a second, separate vendor (OpenAI's Whisper) for the transcription step alone,
with the resulting plain text still flowing into the *same* Anthropic-powered extraction pipeline
unchanged. **Roy's explicit call: not forking AI vendor support onto a second provider for this one
feature** — shelved rather than left half-built waiting on a credential. `integrations/transcription.js`
(the OpenAI Whisper call) was removed entirely, not just left unconfigured — no `OPENAI_API_KEY`
reference, no second-vendor fetch call anywhere in the codebase.

What's kept: `webhook.js`'s `resolveAudioMediaRef` still recognizes WhatsApp's `'audio'` message type
(a recorded voice note and a regular shared audio file both arrive as the same type — Meta's own
`voice` flag doesn't need different handling here) and declines it with its own honest reply, "I can't
understand voice notes yet — mind typing that instead?" — never silently dropped or lumped into the
generic "unsupported message type" message, same "every message gets some response" philosophy as
everywhere else in this handler. `tests/regression/voiceMessageType.test.js` (3 tests) covers
`resolveAudioMediaRef` directly, the same pure-recognition-function convention `resolveImageMediaRef`
already established. Revisit if Anthropic's own API ever adds audio input (no separate vendor needed
at that point) or if a second AI vendor becomes worth it for its own sake later.

**Full suite after all nine items above: 164/164 passing.** Frontend untouched throughout — every one
of these is a WhatsApp-only or purely-internal capability, matching how every bot-facing feature in
this codebase has worked since A1. **E2 (delegation between parents) remains explicitly blocked** —
needs multi-parent family linking (fix-list item 1.3), not built — and was not started.

**Audit pass (same day) — two real cross-feature gaps caught and fixed.** Roy asked for a systematic
recheck of every new field's full trace (schema → LLM tool schema → pipeline consumption → repo →
back out) across all nine items above, given this session's history of exactly this class of bug
(item 6's `sourceMappingsRepo.create()` existing but never being called). Grepping every new field
name end-to-end found the schema/LLM/repo wiring itself fully consistent (no orphaned or
never-produced field anywhere) — but surfaced two real behavioral gaps where one feature's logic
wasn't applied somewhere a sibling code path clearly implied it should be:
- **C1 defaults never reached A3's additional events.** `writeAdditionalEvent` built its candidate
  straight from the LLM's raw item, skipping `applyStandingRuleDefaults` entirely — a taught rule
  ("art therapy is always at the Rothschild clinic") applied to the *primary* item in a multi-event
  message but silently not to a second "art therapy" event later in the very same message. Fixed by
  passing `activeEventDefaults` into `writeAdditionalEvent` and calling
  `applyStandingRuleDefaults` there too.
- **That same fix exposed a second, subtler bug:** `applyStandingRuleDefaults`'s matching was written
  for the single-event case, where checking the rule's `match_keyword` against *both* the raw message
  text and the event's own title is intentional (a taught keyword phrase can still apply even when
  the LLM's title paraphrased it away). A multi-event message breaks that assumption — every event in
  `additional_events` shares the SAME raw text, so matching each one's defaults against the whole raw
  text let a keyword belonging to one event bleed onto an unrelated sibling (a "Swimming" event
  incorrectly inheriting the "art therapy" location default purely because the words "art therapy"
  appeared elsewhere in the same forwarded message). Fixed by scoping every event's match to its own
  `title` only whenever `additional_events` is present, keeping the richer title-or-raw-text match
  for the ordinary single-event message.
- **B3's conflict check only ran on the direct write_calendar branch**, not on the
  follow-up-promotion path (`promotePendingEventWithTime`) — even though completing a parked
  `needs_time` event with a time answer is exactly the same kind of real Calendar create the direct
  branch already flags conflicts for. Fixed by adding the identical best-effort conflict check there
  too.

Both fixes are additive-only (no existing behavior changed for a single, non-parked event) and each
has a dedicated regression test: `multiEventExtraction.test.js`'s new "a taught C1 event-default rule
applies to an additional_events item, not just the primary one" (asserting BOTH that the additional
item gets the default AND that the primary item does NOT cross-contaminate), and
`conflictAndProvenance.test.js`'s new "a conflict is also flagged when an event is completed via the
'what time?' follow-up." **Deliberately left as-is, not a gap:** A3's additional events still don't
get their own B3 conflict check (would multiply `listEvents` calls per additional item for a
lower-value, rarer case) and B4 excludes the RRULE for additional events (no `recurrence` field on
`additional_events` at all) — both stated scope cuts from the original build, re-confirmed as
deliberate rather than accidental during this pass, not upgraded to bugs.

Full suite after the audit fixes: 166/166 passing (2 new tests). Also fixed in passing: a stale JSDoc
return-type comment on `llm.js`'s `extract()` that still listed only two `rule_kind` values after D2
added the third (`prep_association`) — cosmetic, no runtime effect, caught by the same grep sweep.

**Event adoption — manually-added Google Calendar events (✅ built, same day).** Roy's own follow-up
question: "not all of the entries will be done by the bot" — is that actually handled? Every calendar
read in this app already pulls the WHOLE connected calendar (`calendar.js`'s `listEvents` is a plain
Google API range query, completely source-agnostic — nothing here was ever bot-only), so a
manually-added event was always *visible*. But it has no `personId` tag (only the bot sets that at
creation), so it fell back to a live text-match on every single read and, worse, was completely
invisible to B3's conflict check, which only ever compares `personId` directly with no text-match
fallback at all — a real double-booking against a manually-added event went unflagged.

New `pipeline/eventAdoption.js`'s `adoptUntrackedEvents`: when exactly one family member's name
confidently text-matches a not-yet-tracked event (`matchSingleFamilyMember` against title+description,
same "don't guess" philosophy used everywhere else in this codebase), it patches `personId` onto the
*real* Calendar event (invisible metadata only, same as every other personId write — nothing visible
changes) and writes a synthetic `extraction_log` row (state `'written'`, `sender_identifier: null`,
`ai_candidate.adopted: true`) so it shows up in the app's own audit trail and — just as importantly —
so that row's presence is what tells every future sweep "already considered this one," rather than
re-matching from scratch on every read. Zero or ambiguous (2+) name matches are left alone, same as
`matchSingleFamilyMember` itself. Wired into every calendar-read path per Roy's own choice ("everywhere,"
not just the daily brief): A1's read-back query, A2's cancel/reschedule search, B3's conflict check
(both the direct write and the follow-up-promotion path), D1's daily briefing sweep, and the kid
dashboard route — one shared function, so an event is adopted the first time ANY feature sees it, not
just whichever one happens to run first. Best-effort per item (a failed patch/write is logged and
skipped, never blocks the actual read it was running ahead of), and the caller's own in-memory `items`
batch is updated in place too — so, for example, B3's conflict check running immediately after
adoption in the same pipeline turn sees the new personId right away, not only on a future read.

Threading `familyId` into `adoptUntrackedEvents`'s call sites required adding it to several
pipeline.js function signatures that didn't carry it before (`handleReadBackQuery`, `handleCorrection`,
`promotePendingEventWithTime`) — pure plumbing, no behavior change to any existing call site that
doesn't also touch calendar reads.

`tests/regression/eventAdoption.test.js` (6 tests): a confident single-name match gets adopted (patch +
local record, in-batch mutation); zero/ambiguous matches are left alone; an already-tracked event is
skipped; a second read of the same event doesn't re-adopt it (idempotency via the local record, not
just an in-memory check); a manually-added event is adopted and found during a real A1 person-scoped
query; and — the actual motivating scenario — **a real double-booking against a manually-added event is
now correctly flagged**, which was silently impossible before this. Full suite: 172/172 passing.

---

## "Family App" naming inventory (Aug 2026)

Every place the literal product name "Family App" appears, so a future rename has a checklist instead of
a fresh grep each time. Found via `grep -rniI "family app|familyapp|family-app|family_app"` across the
whole repo (excluding `node_modules`/`dist`/`.git`). Grouped by how costly each is to change.

**User-facing copy (the ones that actually matter for a rename):**
| Where | What it says |
|---|---|
| [InviteCoParentStep.jsx:26](web/src/features/onboarding/steps/InviteCoParentStep.jsx) | Web Share API text when inviting a co-parent: `"Join our Family App"` / `"Join our family on Family App"` |
| [app.js:35,39](server/src/app.js) | The `/privacy` page (public, required by Meta's WhatsApp app-review checklist) — page `<title>` and opening sentence both say "Family App" |
| family-app-architecture.md (this doc, "Known gap closed" reminder-template section) | The WhatsApp message template proposed to Meta: Header `"Family App Reminder"`, Body `"...sent by your Family App assistant."` — **the costliest one to change**: once Meta approves a template it can't be edited, only replaced with a newly-submitted, newly-approved one, so a rename here means resubmitting and waiting on review again, not a quick edit |

**Code/config identifiers (internal, lower stakes, but a rename means touching all of these consistently):**
| Where | What it is |
|---|---|
| [package.json:2](package.json), [server/package.json:2](server/package.json), [web/package.json:2](web/package.json) | npm package names: `family-app`, `family-app-server`, `family-app-web` |
| [app.js:20](server/src/app.js) | Session cookie name: `'family-app-session'` — changing this logs every currently-signed-in user out once (cookie name mismatch), harmless but worth doing deliberately, not by surprise |
| [schema.sql:1-2](server/src/db/schema.sql) | Comment header only, not a real identifier — no data-model impact |
| [server.js:13](server/src/server.js) | Boot log line only (`console.log`), not user-visible |
| [messenger.js](server/src/integrations/messenger.js), [familySetup.js](server/src/services/familySetup.js) | Code comments pointing back to this doc's filename — would go stale if the *doc* is renamed, not the product name inside it |

**Outside the repo entirely (can't grep, can't fix in code):**
- GitHub repo: `github.com/royreinail/family-app` — GitHub auto-redirects the old URL after a rename, so low risk, but `git remote` URLs on any other clone would need updating manually.
- Railway's live URL: `family-app-production-9a73.up.railway.app` — Railway-generated from the service name; renaming the Railway service doesn't necessarily change an already-issued domain, and a custom domain is a separate, cleaner option regardless of this rename question.
- The WhatsApp bot's own display name (the "מרלין" persona name Roy sees in his own chat with it) — that's configured directly in Meta Business Manager, not anywhere in this codebase, so it's independent of any "Family App" rename here — worth remembering as a *separate* naming surface if a full rebrand ever happens.

**Explicitly not the same thing, don't conflate when renaming:** [index.html](web/index.html)'s browser-tab title is `"Tomorrow — Family Board"` — a different, deliberately-chosen name for the kid dashboard view specifically (see `TomorrowBoardPage.jsx`), not an instance of the product name "Family App." Changing one doesn't imply changing the other.
