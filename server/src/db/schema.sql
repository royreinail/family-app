-- Family App — Phase 1 schema
-- Conventions (future-proofing items in family-app-architecture.md):
--   * UUID primary keys everywhere
--   * family_id on every table
--   * UTC timestamps (timestamptz), per-family timezone stored on families
--   * soft delete only (deleted_at), never a hard DELETE from app code
--   * structured external refs: jsonb {provider, external_id}, never a bare id string

create extension if not exists "pgcrypto";

create table if not exists families (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'UTC',
  pin_hash text,                      -- bcrypt hash; null until onboarding step 6 sets one
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
-- Backlog 1.3: lazily generated, lets a second parent join this family.
-- ALTER ... ADD COLUMN IF NOT EXISTS (not a column in the create table
-- above) so this applies to already-deployed databases the same idempotent
-- way schema.sql's other statements do -- see db/migrate.js.
alter table families add column if not exists invite_code text unique;
-- D1 (proactive daily briefing): the local calendar date the briefing was
-- last sent for, so a periodic sweep (see pipeline/briefing.js) knows not
-- to resend it every tick for the rest of that same day. A plain date, not
-- a timestamptz — compared against the family's own local "today"
-- (todayInTimeZone), not a UTC instant.
alter table families add column if not exists last_briefing_sent_date date;

-- Backlog 1.3 (multi-parent support): every Google account authorized to
-- sign into a family. Kept separate from google_credentials, which stays a
-- single shared Calendar connection regardless of how many parents there
-- are -- a second parent joining doesn't need (or get) their own calendar
-- link, they share the one the family already has.
create table if not exists family_parents (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  google_account_email text not null unique,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists family_parents_family_idx on family_parents (family_id) where deleted_at is null;

-- Google OAuth credential state for a family's connected calendar account.
-- Kept in its own table (not on families) so future-proofing item 5 (thin
-- calendar-provider boundary) has one obvious place to add a second provider.
create table if not exists google_credentials (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  google_account_email text,
  access_token text,
  refresh_token text,
  scope text,
  expiry_date timestamptz,
  calendar_id text not null default 'primary',
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists family_members (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  name text not null,
  calendar_color text not null,       -- hex, matches design tokens palette
  kid_icon text not null,             -- emoji used on the kid dashboard
  photo_url text,                     -- optional uploaded portrait
  linked_calendar_ids text[] not null default '{}',
  is_parent boolean not null default false,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Generalized: (channel_type, external_identifier) -> family_member, so a
-- new intake channel is a new row, never a schema migration (future-proofing item 7).
create table if not exists source_mappings (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  channel_type text not null,         -- 'whatsapp' | 'email' | ...
  external_identifier text not null,  -- phone number / email address
  family_member_id uuid not null references family_members(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (channel_type, external_identifier)
);

create table if not exists activity_icons (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  keyword text not null,              -- matched against category/title, case-insensitive
  icon text not null,                 -- emoji or Material Symbols name
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Write-ahead log for every inbound message. A row is inserted the instant
-- the webhook fires, before the duplicate_message gate even runs, so a crash
-- mid-request never loses the fact that a message arrived.
create table if not exists extraction_log (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  raw_input text not null,
  sender_identifier text,             -- external_identifier the message arrived from
  external_message_id text not null,
  reply_to_external_id text,          -- set when this message is a WhatsApp reply/quote
  ai_candidate jsonb,                 -- the LLM's structured extraction, once run
  resulting_event_ref jsonb,          -- {provider, external_id}, null until written
  state text not null default 'received',
  fired_rule text,                    -- name of the rule (gate or assessment) that decided the outcome, if any
  error text,                         -- populated on state = 'failed'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint extraction_log_state_check check (
    state in ('received','extracted','written','needs_clarification','needs_time','stopped','failed','corrected','undone')
  )
);

-- A2 (cancel/reschedule, enhancement backlog): a parked "which one do you
-- mean?" state, same idempotent-ALTER pattern as families.invite_code
-- above for a constraint change applying to an already-deployed database
-- (CREATE TABLE IF NOT EXISTS above doesn't retroactively touch an
-- existing table's constraint, so the widened list has to be a real ALTER,
-- not just an edit to the CHECK list above).
alter table extraction_log drop constraint if exists extraction_log_state_check;
alter table extraction_log add constraint extraction_log_state_check check (
  state in ('received','extracted','written','needs_clarification','needs_time','needs_disambiguation','stopped','failed','corrected','undone')
);

-- Dedup key is scoped per family, excluding soft-deleted rows, matching the
-- duplicate_message gate's query ("prior row with the same external_message_id, excluding self").
create index if not exists extraction_log_dedup_idx
  on extraction_log (family_id, external_message_id)
  where deleted_at is null;

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  title text not null,
  due_date date,
  importance text not null default 'Med',   -- High | Med | Low
  owner_family_member_id uuid references family_members(id),
  status text not null default 'pending',   -- pending | done
  reminder_policy text not null default 'none', -- 'none' | 'requested'
  reminder_datetime timestamptz,
  reminder_sent_at timestamptz,
  source_extraction_log_id uuid references extraction_log(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint tasks_importance_check check (importance in ('High','Med','Low')),
  constraint tasks_status_check check (status in ('pending','done'))
);

-- One table, one evaluator (evaluateRules). `name` is an additive column
-- (not spelled out in the architecture doc's column list) so acceptance
-- fixtures can assert exactly which rule fired, per the doc's own testing
-- philosophy — trigger_type alone is not unique enough across the four
-- extraction_classification branches.
create table if not exists rules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  rule_type text not null,            -- 'gate' | 'assessment'
  trigger_type text not null,
  name text not null,
  conditions jsonb not null,          -- all/any/not boolean composition (json-rules-engine convention)
  action jsonb not null,
  priority integer not null default 100, -- lower runs first
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint rules_rule_type_check check (rule_type in ('gate','assessment'))
);

create index if not exists rules_lookup_idx
  on rules (family_id, rule_type, trigger_type, priority)
  where deleted_at is null and enabled = true;

-- C1 (standing rules taught in conversation, enhancement backlog): "art
-- therapy is always at the Rothschild clinic" taught once, in chat, applied
-- to every future matching message. Explicitly NOT the gate/assessment
-- `rules` table above — that one drives the fixed extraction_classification/
-- event_task_routing decision tree with json-rules-engine condition
-- objects; a standing rule is a much simpler "if this keyword appears,
-- default this field to this value" (or "change this named timing
-- parameter") shape, natural-language-taught rather than engineered, and
-- reviewed via a bot command only (D-3), not a Settings screen.
create table if not exists standing_rules (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  rule_text text not null,            -- articulated, human-readable restatement shown for yes/no confirmation
  rule_kind text not null,            -- 'event_default' | 'timing_param' | 'prep_association'
  match_keyword text,                 -- event_default: substring matched against a future message's title/text
  field text,                         -- event_default: which candidate field this defaults ('location'|'audience'|'duration_minutes'|'person')
  value text,                         -- event_default: the value to apply
  param_name text,                    -- timing_param: which named setting this changes (currently only 'briefing_send_time')
  param_value text,                   -- timing_param: the new value
  status text not null default 'pending', -- 'pending' | 'active' | 'discarded'
  sender_identifier text,             -- who proposed it — the yes/no confirmation is matched to this sender, not re-parsed by the LLM
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  deleted_at timestamptz,
  constraint standing_rules_kind_check check (rule_kind in ('event_default','timing_param')),
  constraint standing_rules_status_check check (status in ('pending','active','discarded'))
);
create index if not exists standing_rules_pending_idx
  on standing_rules (family_id, sender_identifier, status) where deleted_at is null;
create index if not exists standing_rules_active_idx
  on standing_rules (family_id, status) where deleted_at is null;

-- D2 (preparation awareness, enhancement backlog): widens rule_kind to add
-- 'prep_association' ("swimming always needs a towel") — standing_rules was
-- already deployed under C1, so CREATE TABLE IF NOT EXISTS above is a no-op
-- on that real database and can't retroactively touch its constraint; a
-- real ALTER is required, same idempotent drop/add pattern as
-- extraction_log's own state check further up this file.
alter table standing_rules drop constraint if exists standing_rules_kind_check;
alter table standing_rules add constraint standing_rules_kind_check check (
  rule_kind in ('event_default','timing_param','prep_association')
);

create table if not exists bot_config (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references families(id),
  channel_type text not null default 'whatsapp_business_api',
  phone_number_id text,               -- Meta phone number id the bot receives on
  waba_id text,
  bot_display_number text,            -- human-readable number shown in onboarding
  accepted_chat_ids text[] not null default '{}', -- explicit allowlist, never "listen to everything"
  webhook_verify_token text,
  digest_chat_id text,                -- used from Phase 2 on
  message_templates jsonb not null default '{}'::jsonb,
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
