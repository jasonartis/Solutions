-- Module 6: Speed Dating (key: 'speed-dating', prefix sd_).
-- Spec: docs/modules/module-6-speed-dating.md
--
-- DRAFT for review — NOT applied, NOT wired into supabase/migrations/. Becomes
-- supabase/migrations/<ts>_speed_dating.sql once a human security-reviews it and
-- folds in a modules/speed-dating/schema-fixes.sql (mirrors how
-- modules/classroom, modules/matchmaking and modules/nail-salon drafts became
-- real migrations, with a schema-fixes pass folded in afterward). Patterns
-- copied EXACTLY from those exemplars
-- (20260708010000_classroom.sql, 20260709020000_matchmaking.sql,
--  20260709030000_nail_salon.sql):
--   * explicit grants — CLI migrations do NOT inherit Supabase's API-role
--     grants, so every table is granted to authenticated + service_role
--     explicitly BEFORE RLS restricts rows (this bit the team before —
--     non-negotiable).
--   * RLS enabled on EVERY table.
--   * security-definer helper functions for cross-table role/ownership checks
--     (avoids RLS recursion — modeled on cls_can_manage / mm_can_manage /
--     sal_can_manage).
--   * updated_at maintained by the shared public.set_updated_at() trigger.
--   * scope-sync BEFORE INSERT/UPDATE triggers that derive org_id (and the
--     event_id, where a parent implies it) from the FK chain server-side, so a
--     client can never misfile a row into another org/event by supplying a bogus
--     id (the vulnerability class fixed in modules 1/2/5 — see cls_sync_from_*,
--     mm_sync_from_group, sal_sync_from_*). Postgres evaluates RLS WITH CHECK
--     AFTER BEFORE triggers, so the derived org_id is what the policy sees.
--
-- Relies on platform objects that already exist:
--   public.is_superadmin(), public.is_org_member(), public.set_updated_at()  (core migration)
--   public.has_module_role(org, module_key, role)                            (module 3 migration)
--
-- Module key used throughout: 'speed-dating'.
-- Role vocabulary (module_roles.role values): 'admin', 'organizer', 'host',
-- 'participant'. RLS tiers built from them:
--   sd_can_manage      = superadmin / org owner-admin / module 'admin'
--                        (org + user + organizer setup, platform ban list,
--                         everything). "Admin" in the spec ("sets up
--                         organizations, organizers, users; platform-wide bans")
--                        maps to this manage tier, NOT a separate live role.
--   sd_can_organize    = sd_can_manage OR module 'organizer'
--                        (event setup: time/eligibility/timing/recurrence; the
--                         live console: pause/extend/re-pair/broadcast/remove;
--                         post-event stats).
--   sd_can_staff_event = sd_can_organize OR module 'host'
--                        (the host/floater helper: greets the lobby, reads the
--                         rooms grid, handles reported rooms — NO event-setup
--                         rights, so host is NOT in the blanket organize write).
--   participant        = module 'participant' role gates REGISTRATION and
--                        open-event visibility; per-row access is by ownership
--                        (sd_owns_participant) — a participant sees the events
--                        they can register for, their own registration, the
--                        rounds/pairings that involve them, their own interest
--                        marks, and a MATCH only once it is mutual+revealed.
--
-- Observer seats (decided 2026-07-06: audience + mentor, both require the
-- observed participant's consent, collected at signup) are modeled as
-- sd_participants rows with seat_type in ('audience','mentor') rather than as
-- new module roles — the rotation/pairing/interest/match engine simply filters
-- seat_type = 'participant'. A mentor row points at its mentee via
-- mentee_participant_id; consent lives on the observed participant's own row
-- (allows_audience / allows_mentor). See the AMBIGUITY notes in the final
-- report — the audience live-view surface and mentor private-feedback surface
-- are largely a runtime/UI concern; the DB models the seats + consent only.
--
-- Per-EVENT configuration (round/break length, pool definitions, counts per
-- side, who rotates, repeat-pairing + resume-review toggles) lives on the
-- sd_events row (it is instance-specific, not org-wide). ORG-level module
-- defaults (default round length, default capacities, contact-share policy,
-- lobby lead time) live in org_modules.settings for module_key 'speed-dating' —
-- no ad-hoc config table (docs/03 rule).
--
-- DELIBERATELY NOT BUILT (documented — see spec + docs/01 primitives catalog):
--   * The Jitsi VIDEO PROVIDER integration (create room / issue token / close
--     room). The provider is a platform primitive with a swappable interface
--     (Jitsi/Daily/LiveKit/JaaS = config). sd_pairings carries a nullable
--     room_ref (+ room_provider) SLOT so the orchestrator can stamp the room
--     name once it exists; per-user JOIN TOKENS are short-lived and issued on
--     demand by the provider at join time — they are intentionally NOT persisted
--     here. No recording, ever (explicit product promise) — nothing in this
--     schema stores or references a recording.
--   * The Socket.IO LIVE ORCHESTRATION (server-authoritative state machine:
--     round clock, pairing advance, broadcasts). That is the worker/runtime
--     "real module"; this schema only models the STATE the orchestrator
--     reads/writes (events/rounds/pairings/participants). The event driver is
--     the pg-boss job 'speeddating.event-orchestrator' (docs/01 job catalog);
--     it uses the service_role and bypasses RLS, filtering by org_id explicitly.
--   * Notifications / email (event sign-up alerts, mutual-match notifications).
--     Those go through the platform notification + email queue primitives
--     (docs/03 hard-rule #5), not inline here.
--   * A generic REALTIME or SCHEDULING primitive — not invented speculatively
--     (CLAUDE.md). Rotation/round math stays in this module + the orchestrator.
--   * The QUESTION/ANSWER engine. The spec's "question-engine primitive" (user
--     criteria; resume-review event profile) and the FUTURE "module 1
--     compatibility scores seed the rotation" are owned by the platform question
--     engine (docs/01: primitive owned by modules 1 AND 6) — but that primitive
--     does NOT exist in packages/platform yet (only module 1's mm_ tables do,
--     which this module must NEVER import — CLAUDE.md). Building sd_questions/
--     sd_answers now would be speculative AND would duplicate a primitive due to
--     be extracted. Instead the opt-in resume-review card is stored lightweight
--     on the participant row (profile_card text + profile jsonb snapshot). When
--     the question engine is extracted upstream, criteria + resume review +
--     score-seeded rotations hook into it. See final-report AMBIGUITY note.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- A speed-dating event. Root table: org_id is client-supplied and the RLS write
-- gate (sd_can_organize) ties it to an org the caller runs, exactly like
-- cls_courses / mm_groups / sal_locations.
--
-- State machine (spec):
--   draft -> open (registration) -> running -> complete
--   (+ cancelled from draft/open/running).
-- The legal-transition ORDER is enforced by a guard trigger flagged as an
-- INTEGRATION NOTE below (RLS gates WHO writes, not WHICH transition is legal).
--
-- Format is CONFIGURATION not code (spec): the load-bearing timers are columns
-- (the orchestrator reads them on the hot path); the arbitrary pool definition
-- (default hetero two-sided, but any; counts per side flexible — 7v7 typical,
-- 1v7 dating-show supported; who rotates) is Zod-validated jsonb in `format`.
-- current_round_id is the running pointer maintained by the orchestrator
-- (deferred FK added after sd_rounds exists — the events<->rounds cycle).
create table public.sd_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  description text,
  scheduled_at timestamptz,
  -- Lobby opens ~15 min early (spec); nullable = app derives from scheduled_at
  -- and the org's lobby-lead-time setting.
  lobby_opens_at timestamptz,
  state text not null default 'draft'
    check (state in ('draft', 'open', 'running', 'complete', 'cancelled')),
  round_duration_seconds integer not null default 420 check (round_duration_seconds > 0),
  break_duration_seconds integer not null default 30 check (break_duration_seconds >= 0),
  -- Optional planned round count; the orchestrator may instead derive N from the
  -- pool sizes (balanced round-robin: everyone meets everyone in N rounds).
  rounds_planned integer check (rounds_planned is null or rounds_planned > 0),
  -- Pool definitions + counts-per-side + who-rotates + per-side capacities.
  -- Zod-validated at the write site (docs/03 rule #7), not by a CHECK here.
  format jsonb not null default '{}'::jsonb,
  -- Organizer toggles (spec): repeat pairings across events, and the classic-blind
  -- vs. resume-review event profile (off by default).
  allow_repeat_pairings boolean not null default false,
  resume_review_enabled boolean not null default false,
  current_round_id uuid,   -- deferred FK to sd_rounds (running pointer); see below
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Registration for an event, and ALSO the observer seats (audience/mentor).
-- DESIGN DECISION: one row per (event, user) — a person holds ONE seat at an
-- event (unique below). seat_type selects participant vs the two observer seats;
-- the rotation engine filters seat_type='participant'.
--   pool_side  = which side of the format's pool this participant is on (e.g.
--                'a'/'b' or a label). "Who meets whom" is DERIVED by the
--                orchestrator from format's pool-pairing rules + pool_side; this
--                column is the matching dimension the spec leaves to config
--                (default hetero two-sided, but arbitrary).
--   status     = registration lifecycle: 'registered' (a confirmed seat),
--                'waitlisted' (capacity/balance not yet available — auto-promoted
--                by the waitlist job, see INTEGRATION NOTE), 'withdrawn' (user
--                pulled out), 'removed' (organizer/host ejected a disruptive
--                user — spec live-console action).
--   checked_in = lobby camera/mic test done / present (spec lobby ~15m early).
--   mentee_participant_id = for seat_type='mentor', the participant they observe.
--   allows_audience / allows_mentor = the OBSERVED participant's consent, taken
--                at signup (spec: "both require participant consent").
--   profile_card / profile = the opt-in resume-review event profile (short
--                free-text card + a jsonb answer snapshot). Lightweight stand-in
--                until the question-engine primitive is extracted (header note).
-- org_id derived from the event by scope-sync.
create table public.sd_participants (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  event_id uuid not null references public.sd_events (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  seat_type text not null default 'participant'
    check (seat_type in ('participant', 'audience', 'mentor')),
  pool_side text,
  status text not null default 'registered'
    check (status in ('registered', 'waitlisted', 'withdrawn', 'removed')),
  checked_in boolean not null default false,
  checked_in_at timestamptz,
  mentee_participant_id uuid references public.sd_participants (id) on delete set null,
  allows_audience boolean not null default false,
  allows_mentor boolean not null default false,
  profile_card text,
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, user_id)
);

-- A timed round within a running event. The orchestrator advances state and
-- stamps the clock; participants read-only. State:
--   pending -> active -> break -> complete.
-- The single-active-round-per-event invariant + legal transitions are a guard
-- trigger flagged as an INTEGRATION NOTE below.
create table public.sd_rounds (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  event_id uuid not null references public.sd_events (id) on delete cascade,
  round_number integer not null check (round_number > 0),
  state text not null default 'pending'
    check (state in ('pending', 'active', 'break', 'complete')),
  starts_at timestamptz,
  ends_at timestamptz,
  break_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, round_number)
);

-- Deferred FK now that sd_rounds exists (the events<->rounds cycle: an event
-- points at its current round, a round belongs to an event).
alter table public.sd_events
  add constraint sd_events_current_round_fkey
  foreign key (current_round_id)
  references public.sd_rounds (id) on delete set null;

-- Who meets whom in a round — the rotation schedule the orchestrator writes and
-- advances. DESIGN DECISION: ONE row per meeting (not one per participant).
-- participant_b_id NULL = a BYE for participant_a ("you're back in next round",
-- spec) — handles odd counts / asymmetric pools. A participant's "current room"
-- is the pairing in the active round where they are a or b.
--   room_ref      = the Jitsi (or other provider) room NAME slot, stamped by the
--                   orchestrator once the video provider creates the room; NULL
--                   until then. Per-user join tokens are NOT stored (issued on
--                   demand at join time — header note).
--   room_provider = which provider minted room_ref ('jitsi' first); NULL in v1.
-- org_id + event_id derived from the round by scope-sync; the same trigger
-- validates both participants belong to that event and a<>b.
create table public.sd_pairings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  event_id uuid not null references public.sd_events (id) on delete cascade,
  round_id uuid not null references public.sd_rounds (id) on delete cascade,
  participant_a_id uuid not null references public.sd_participants (id) on delete cascade,
  participant_b_id uuid references public.sd_participants (id) on delete cascade,
  room_ref text,
  room_provider text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (participant_b_id is null or participant_a_id <> participant_b_id)
);

-- Post-encounter DIRECTIONAL interest — the privacy-critical shape borrowed from
-- module 1: interest is one-directional; a MATCH (sd_matches) exists only when
-- it is MUTUAL. End of event, per person met, the rater records a verdict:
--   'interested' | 'not_interested' | 'no_show'   (spec).
-- RLS below guarantees the rater sees only their OWN marks and the TARGET can
-- NEVER see who was (or wasn't) interested in them — "one-sided interest reveals
-- nothing" (same failure class as matchmaking's excluded/one-sided rows).
-- org_id + event_id derived from the rater participant by scope-sync; target
-- validated to be in the same event.
create table public.sd_interest (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  event_id uuid not null references public.sd_events (id) on delete cascade,
  rater_participant_id uuid not null references public.sd_participants (id) on delete cascade,
  target_participant_id uuid not null references public.sd_participants (id) on delete cascade,
  verdict text not null check (verdict in ('interested', 'not_interested', 'no_show')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rater_participant_id, target_participant_id)
);

-- A MUTUAL match: exists only when BOTH sides recorded 'interested'. Written by
-- the orchestrator / a definer reveal function — NEVER by participants (no
-- participant write policy). Canonical ordering (participant_a_id <
-- participant_b_id, enforced by CHECK, mirrors mm_pair_scores) so a pair yields
-- exactly one row; the writer sorts the two ids before upsert.
--   revealed = the reveal gate: a participant may read a match row ONLY when it
--              is a party AND revealed=true (RLS below). A match row that exists
--              but is not yet revealed still reveals nothing.
--   contact_shared = what each side opted to share on reveal (per user prefs or
--              organizer designation for the event, spec) — jsonb, populated at
--              reveal time; empty until then.
-- org_id + event_id derived from participant_a by scope-sync.
create table public.sd_matches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  event_id uuid not null references public.sd_events (id) on delete cascade,
  participant_a_id uuid not null references public.sd_participants (id) on delete cascade,
  participant_b_id uuid not null references public.sd_participants (id) on delete cascade,
  revealed boolean not null default false,
  matched_at timestamptz,
  contact_shared jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sd_matches_canonical_order check (participant_a_id < participant_b_id),
  unique (event_id, participant_a_id, participant_b_id)
);

-- Private notepad (spec): notes on the last encounter, kept in PRIVATE history.
-- DESIGN DECISION: keyed by the USER pair (author_user_id, about_user_id), NOT
-- the participant pair, so a re-encounter at a FUTURE event can surface "you met
-- on <date> — your note: …" across events. event_id = the event the note was
-- taken at (for the date + org scoping); pairing_id optional back-reference.
-- STRICTLY private: only the author reads/writes their own notes — NOT even the
-- organizer (a personal notepad, not event data). Hence sd_notes is deliberately
-- EXCLUDED from the blanket organize-write policy below.
-- org_id derived from the event by scope-sync.
create table public.sd_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  event_id uuid not null references public.sd_events (id) on delete cascade,
  author_user_id uuid not null references auth.users (id) on delete cascade,
  about_user_id uuid not null references auth.users (id) on delete cascade,
  pairing_id uuid references public.sd_pairings (id) on delete set null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, author_user_id, about_user_id)
);

-- Safety report on an encounter (spec: report button on every encounter — during
-- call + end-of-event form). Reviewed by organizer/host (staff_event tier). The
-- reported person must NEVER see the report (RLS: reporter + staff only).
--   during_call = raised live vs. via the end-of-event form.
--   state       = open -> reviewed -> actioned | dismissed.
-- org_id + event_id derived from the event by scope-sync.
create table public.sd_reports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  event_id uuid not null references public.sd_events (id) on delete cascade,
  reporter_participant_id uuid not null references public.sd_participants (id) on delete cascade,
  reported_participant_id uuid references public.sd_participants (id) on delete set null,
  pairing_id uuid references public.sd_pairings (id) on delete set null,
  reason text not null,
  detail text,
  during_call boolean not null default false,
  state text not null default 'open' check (state in ('open', 'reviewed', 'actioned', 'dismissed')),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Personal block list (spec: "never pair me with them again", enforced in the
-- rotation across ALL future events). Per-USER, org-scoped, cross-event — NOT
-- tied to any single event, so it is a root table (org_id client-supplied, RLS
-- ties it to the blocker being an org member). The blocked person must NEVER see
-- they were blocked (RLS: blocker + manage tier only). The orchestrator
-- (service_role) reads these to exclude blocked pairs when building rotations.
-- No updated_at — a block is create/delete only.
create table public.sd_blocks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  blocker_user_id uuid not null references auth.users (id) on delete cascade,
  blocked_user_id uuid not null references auth.users (id) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  check (blocker_user_id <> blocked_user_id),
  unique (org_id, blocker_user_id, blocked_user_id)
);

-- Admin ban list (spec: "admin platform ban list"). Manage-tier only, both read
-- and write. SCOPE DECISION: modeled ORG-SCOPED (an org's ban list) — a truly
-- PLATFORM-WIDE ban that spans orgs is a superadmin cross-org concern (docs/01:
-- cross-org lives in platform-owner tooling, not module RLS) and is deferred;
-- see the final-report AMBIGUITY note. The orchestrator excludes banned users
-- from registration/pairing.
create table public.sd_bans (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  banned_user_id uuid not null references auth.users (id) on delete cascade,
  reason text,
  active boolean not null default true,
  banned_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, banned_user_id)
);

-- ---------------------------------------------------------------------------
-- Indexes (FK lookups + the query shapes each role's views actually need)
-- ---------------------------------------------------------------------------

create index sd_events_org_state_idx on public.sd_events (org_id, state);
create index sd_events_org_scheduled_idx on public.sd_events (org_id, scheduled_at);

create index sd_participants_event_idx on public.sd_participants (event_id);
create index sd_participants_user_idx on public.sd_participants (user_id);
-- Waitlist job scan: "waitlisted seats for this event, by side".
create index sd_participants_event_status_idx
  on public.sd_participants (event_id, status);
create index sd_participants_mentee_idx
  on public.sd_participants (mentee_participant_id) where mentee_participant_id is not null;

create index sd_rounds_event_idx on public.sd_rounds (event_id);

create index sd_pairings_round_idx on public.sd_pairings (round_id);
create index sd_pairings_event_idx on public.sd_pairings (event_id);
create index sd_pairings_participant_a_idx on public.sd_pairings (participant_a_id);
create index sd_pairings_participant_b_idx
  on public.sd_pairings (participant_b_id) where participant_b_id is not null;

create index sd_interest_event_idx on public.sd_interest (event_id);
-- Reciprocal-interest lookup (the mutual-match detector reads by target).
create index sd_interest_target_idx on public.sd_interest (target_participant_id);

create index sd_matches_event_idx on public.sd_matches (event_id);
create index sd_matches_participant_a_idx on public.sd_matches (participant_a_id);
create index sd_matches_participant_b_idx on public.sd_matches (participant_b_id);

-- Cross-event re-encounter lookup ("you met this person before — your note").
create index sd_notes_author_about_idx on public.sd_notes (author_user_id, about_user_id);
create index sd_notes_event_idx on public.sd_notes (event_id);

create index sd_reports_event_state_idx on public.sd_reports (event_id, state);

-- Rotation enforcement: "who has this user blocked" and "who blocked this user".
create index sd_blocks_blocker_idx on public.sd_blocks (blocker_user_id);
create index sd_blocks_blocked_idx on public.sd_blocks (blocked_user_id);

create index sd_bans_user_idx on public.sd_bans (banned_user_id) where active;

-- ---------------------------------------------------------------------------
-- updated_at triggers (tables whose rows get edited after creation).
-- Excluded: sd_blocks is create/delete only (no updated_at column).
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array[
    'sd_events', 'sd_participants', 'sd_rounds', 'sd_pairings',
    'sd_interest', 'sd_matches', 'sd_notes', 'sd_reports', 'sd_bans']
  loop
    execute format(
      'create trigger %I_updated_at before update on public.%I
         for each row execute function public.set_updated_at();',
      t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants first (migrations do not inherit defaults — see core migration note).
-- RLS below restricts rows; the service_role (the speeddating.event-orchestrator
-- worker + the waitlist/mutual-match jobs) bypasses RLS and MUST filter by
-- org_id explicitly in that code (docs/01 rule #3).
-- ---------------------------------------------------------------------------

grant select, insert, update, delete
  on public.sd_events, public.sd_participants, public.sd_rounds,
     public.sd_pairings, public.sd_interest, public.sd_matches,
     public.sd_notes, public.sd_reports, public.sd_blocks, public.sd_bans
  to authenticated, service_role;

alter table public.sd_events        enable row level security;
alter table public.sd_participants  enable row level security;
alter table public.sd_rounds        enable row level security;
alter table public.sd_pairings      enable row level security;
alter table public.sd_interest      enable row level security;
alter table public.sd_matches       enable row level security;
alter table public.sd_notes         enable row level security;
alter table public.sd_reports       enable row level security;
alter table public.sd_blocks        enable row level security;
alter table public.sd_bans          enable row level security;

-- ---------------------------------------------------------------------------
-- Role / ownership helpers (security definer: they read tables the caller may
-- not, and break RLS recursion — same technique as cls_* / mm_* / sal_* helpers).
-- ---------------------------------------------------------------------------

-- Manage tier: superadmin, org owner/admin, or module 'admin'. Org/user/organizer
-- setup, the ban list, everything.
create function public.sd_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_superadmin()
      or public.has_module_role(check_org_id, 'speed-dating', 'admin')
      or exists (
           select 1 from public.org_members
           where org_id = check_org_id
             and user_id = auth.uid()
             and role in ('owner', 'admin')
         );
$$;

-- Organize tier: manage plus module 'organizer'. Event setup + full live console.
create function public.sd_can_organize(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sd_can_manage(check_org_id)
      or public.has_module_role(check_org_id, 'speed-dating', 'organizer');
$$;

-- Event-staff tier: organize plus module 'host'. Lobby greeting, rooms-grid read,
-- reported-room handling. NO event-setup rights (host is not in the blanket
-- organize write policy). NOTE: host is org-wide here; per-EVENT host assignment
-- (a host attached to specific events only) is a deferred refinement, exactly
-- like nail-salon deferred per-location staff scoping (CLAUDE.md: don't build
-- speculatively).
create function public.sd_can_staff_event(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.sd_can_organize(check_org_id)
      or public.has_module_role(check_org_id, 'speed-dating', 'host');
$$;

-- Has the module 'participant' role — gates REGISTRATION and open-event browsing.
create function public.sd_is_participant(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_module_role(check_org_id, 'speed-dating', 'participant');
$$;

-- The caller is the user behind this participant/observer row.
create function public.sd_owns_participant(check_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sd_participants p
    where p.id = check_participant_id
      and p.user_id = auth.uid()
  );
$$;

-- The caller holds any seat in this event (participant/audience/mentor) — used to
-- read the event + its rounds.
create function public.sd_in_event(check_event_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sd_participants p
    where p.event_id = check_event_id
      and p.user_id = auth.uid()
  );
$$;

-- The caller is scheduled to meet (or has met) this participant — there is a
-- pairing in the same event linking the caller's seat to check_participant_id.
-- This is what limits a participant's roster visibility to their OWN scheduled
-- partners (spec: the "7 names" partner list / "up next: Sarah"), rather than
-- exposing the whole event roster + pool sides.
create function public.sd_paired_with(check_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.sd_pairings pr
    join public.sd_participants me on me.user_id = auth.uid()
    where (pr.participant_a_id = check_participant_id and pr.participant_b_id = me.id)
       or (pr.participant_b_id = check_participant_id and pr.participant_a_id = me.id)
  );
$$;

-- The caller is the mentor observing this participant (their mentee).
create function public.sd_mentors(check_participant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.sd_participants m
    where m.mentee_participant_id = check_participant_id
      and m.user_id = auth.uid()
      and m.seat_type = 'mentor'
  );
$$;

-- ---------------------------------------------------------------------------
-- Scope-sync BEFORE triggers — derive org_id (and event_id where a parent
-- implies it) from the FK chain so a client can never misfile a row into another
-- org/event by supplying bogus ids. Root tables (sd_events, sd_blocks, sd_bans)
-- have no parent; their org_id stays client-supplied and the RLS write checks on
-- that exact org already prevent misfiling (same as cls_courses / mm_groups /
-- sal_locations).
-- ---------------------------------------------------------------------------

-- Tables carrying event_id directly whose ONLY derivable scope is org_id, taken
-- from the event: sd_participants, sd_rounds, sd_notes, sd_reports.
create function public.sd_sync_from_event()
returns trigger
language plpgsql
as $$
begin
  select e.org_id into new.org_id
  from public.sd_events e where e.id = new.event_id;
  if new.org_id is null then
    raise exception 'Unknown event %', new.event_id;
  end if;
  return new;
end;
$$;

-- sd_pairings: derive org_id + event_id from the round, and validate BOTH
-- participants belong to that event (a consistency check that can't be a static
-- CHECK because it depends on parent rows — same idea as
-- sal_appointments_before_write). Definer: reads sd_rounds / sd_participants.
create function public.sd_pairings_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r public.sd_rounds%rowtype;
begin
  select * into r from public.sd_rounds where id = new.round_id;
  if not found then
    raise exception 'Unknown round %', new.round_id;
  end if;
  new.org_id := r.org_id;
  new.event_id := r.event_id;

  if not exists (
    select 1 from public.sd_participants p
    where p.id = new.participant_a_id and p.event_id = new.event_id
  ) then
    raise exception 'Participant % is not in event %', new.participant_a_id, new.event_id;
  end if;

  if new.participant_b_id is not null and not exists (
    select 1 from public.sd_participants p
    where p.id = new.participant_b_id and p.event_id = new.event_id
  ) then
    raise exception 'Participant % is not in event %', new.participant_b_id, new.event_id;
  end if;

  return new;
end;
$$;

-- sd_interest: derive org_id + event_id from the RATER participant, validate the
-- target is in the same event, and forbid rating oneself. Definer.
create function public.sd_interest_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare p public.sd_participants%rowtype;
begin
  select * into p from public.sd_participants where id = new.rater_participant_id;
  if not found then
    raise exception 'Unknown rater participant %', new.rater_participant_id;
  end if;
  new.org_id := p.org_id;
  new.event_id := p.event_id;

  if new.rater_participant_id = new.target_participant_id then
    raise exception 'A participant cannot record interest in themselves';
  end if;

  if not exists (
    select 1 from public.sd_participants t
    where t.id = new.target_participant_id and t.event_id = new.event_id
  ) then
    raise exception 'Target % is not in event %', new.target_participant_id, new.event_id;
  end if;

  return new;
end;
$$;

-- sd_matches: derive org_id + event_id from participant_a, validate participant_b
-- is in the same event (canonical a<b is enforced by CHECK). Definer.
create function public.sd_matches_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare p public.sd_participants%rowtype;
begin
  select * into p from public.sd_participants where id = new.participant_a_id;
  if not found then
    raise exception 'Unknown participant %', new.participant_a_id;
  end if;
  new.org_id := p.org_id;
  new.event_id := p.event_id;

  if not exists (
    select 1 from public.sd_participants b
    where b.id = new.participant_b_id and b.event_id = new.event_id
  ) then
    raise exception 'Participant % is not in event %', new.participant_b_id, new.event_id;
  end if;

  return new;
end;
$$;

create trigger sd_participants_scope before insert or update on public.sd_participants
  for each row execute function public.sd_sync_from_event();
create trigger sd_rounds_scope before insert or update on public.sd_rounds
  for each row execute function public.sd_sync_from_event();
create trigger sd_notes_scope before insert or update on public.sd_notes
  for each row execute function public.sd_sync_from_event();
create trigger sd_reports_scope before insert or update on public.sd_reports
  for each row execute function public.sd_sync_from_event();
create trigger sd_pairings_scope before insert or update on public.sd_pairings
  for each row execute function public.sd_pairings_before_write();
create trigger sd_interest_scope before insert or update on public.sd_interest
  for each row execute function public.sd_interest_before_write();
create trigger sd_matches_scope before insert or update on public.sd_matches
  for each row execute function public.sd_matches_before_write();

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- Uniform organize-write: organizers (and manage tier / superadmin) have FULL
-- control of the operational event tables. DELIBERATELY EXCLUDES:
--   * sd_notes  — a private notepad, author-only even from organizers (below).
--   * sd_blocks — a personal block list, blocker-only + manage-read (below).
--   * sd_bans   — manage-tier only (below).
-- Host and participant carve-outs are added explicitly per table after this.
do $$
declare t text;
begin
  foreach t in array array[
    'sd_events', 'sd_participants', 'sd_rounds', 'sd_pairings',
    'sd_interest', 'sd_matches', 'sd_reports']
  loop
    execute format(
      'create policy %I_write_organize on public.%I for all
         using (public.sd_can_organize(org_id))
         with check (public.sd_can_organize(org_id));',
      t, t);
  end loop;
end $$;

-- --- Events ------------------------------------------------------------------
-- Staff (organizer/host) see every event incl. drafts. A participant-role member
-- sees non-draft events in their org (to register / attend / see results) and
-- any event they hold a seat in.
create policy sd_events_select on public.sd_events
  for select using (
    public.sd_can_staff_event(org_id)
    or public.sd_in_event(id)
    or (public.sd_is_participant(org_id) and state in ('open', 'running', 'complete', 'cancelled'))
  );

-- INTEGRATION NOTE (event state-machine guard): the organize-write policy lets
-- an organizer set `state` to anything. Spec's lifecycle is ordered
-- (draft -> open -> running -> complete, + cancelled). RLS is row-level and
-- cannot enforce legal TRANSITIONS. Add a BEFORE UPDATE trigger that rejects
-- out-of-order jumps (e.g. draft -> running, or any change out of a terminal
-- 'complete'/'cancelled'), and stamps derived timestamps. This is the events
-- analogue of the sal bill/appointment lifecycle guards — flagged, not built.

-- --- Participants ------------------------------------------------------------
-- Read: staff see the full roster; a participant sees their own seat, the seats
-- they are scheduled to meet (partner list / "up next"), and — for a mentor —
-- their mentee. AMBIGUITY (final report): audience-seat "watch the active room"
-- visibility of the two active participants is an observer feature left to the
-- runtime/definer layer, NOT granted here.
create policy sd_participants_select on public.sd_participants
  for select using (
    public.sd_can_staff_event(org_id)
    or public.sd_owns_participant(id)
    or public.sd_paired_with(id)
    or public.sd_mentors(id)
  );

-- Self-registration: a participant-role member registers THEMSELVES, landing as
-- 'registered' or 'waitlisted' (the waitlist job promotes; a user cannot
-- self-confirm off the waitlist — pinned at integration). Covers participant +
-- observer seats (audience/mentor) the same way.
-- INTEGRATION NOTE: this permits registering while the event is in any state;
-- registration-window enforcement (only while state='open', capacity/balance
-- checks) is module logic / a validating trigger to add at integration — RLS
-- only proves ownership + org scoping + role here.
create policy sd_participants_insert_self on public.sd_participants
  for insert with check (
    user_id = auth.uid()
    and public.sd_is_participant(org_id)
    and status in ('registered', 'waitlisted')
  );

-- Self-service update of one's own seat (lobby check-in, resume-review profile,
-- observer-consent toggles, withdraw).
-- INTEGRATION NOTE (column pins — the participant analogue of
-- cls_pin_submission_columns / sal_pin_appointment): RLS cannot restrict WHICH
-- columns a participant changes. Add a BEFORE UPDATE trigger that, for a
-- non-staff self-editor, PINS event_id/user_id/seat_type/pool_side/
-- mentee_participant_id and constrains status to (unchanged, or -> 'withdrawn'),
-- leaving only checked_in/checked_in_at/allows_audience/allows_mentor/
-- profile_card/profile writable. Name it to sort BEFORE sd_participants_scope so
-- a tampered event_id is reverted to OLD before org_id is derived from it
-- (exactly the sal_appointments_pin < sal_appointments_scope ordering note).
create policy sd_participants_update_self on public.sd_participants
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- INTEGRATION NOTE (host removal): "remove a disruptive user instantly" is a live
-- action. The organize-write policy already lets organizers do it; a HOST needs a
-- narrow update too. Add a staff_event UPDATE policy PLUS a column pin so a host
-- may only flip status -> 'removed' (never reassign pools/seats). Left as a note
-- rather than a wide-open host write, to avoid granting hosts blanket
-- participant control before the pin exists.

-- --- Rounds ------------------------------------------------------------------
-- Read: staff, or any seat-holder in the event (their round clock/timeline).
-- Writes are organize/worker only (organize-write policy above).
-- INTEGRATION NOTE (round guard): add a BEFORE UPDATE/INSERT trigger enforcing
-- the pending->active->break->complete transition order AND the "at most one
-- active round per event" invariant (a partial unique index
-- `unique (event_id) where state='active'` covers the latter cleanly). The
-- orchestrator is the only writer, but this guards against a buggy/duplicate
-- advance.
create policy sd_rounds_select on public.sd_rounds
  for select using (
    public.sd_can_staff_event(org_id)
    or public.sd_in_event(event_id)
  );

-- --- Pairings ----------------------------------------------------------------
-- Read: staff (the rooms grid — connection status only, NEVER video), or a
-- participant for the pairings that involve them (their own schedule). Writes are
-- the orchestrator (worker) via the organize-write policy / service_role.
create policy sd_pairings_select on public.sd_pairings
  for select using (
    public.sd_can_staff_event(org_id)
    or public.sd_owns_participant(participant_a_id)
    or public.sd_owns_participant(participant_b_id)
  );

-- INTEGRATION NOTE (rotation invariants — orchestrator-owned): the rotation
-- engine must (a) never double-book a participant within a round (they are in at
-- most one room per round: enforce with partial uniques
-- `unique (round_id, participant_a_id)` and `unique (round_id, participant_b_id)`
-- PLUS a cross-slot check that a participant is not `a` in one row and `b` in
-- another of the same round — the cross case needs a validating trigger, not a
-- unique index); (b) honor allow_repeat_pairings and the sd_blocks list (never
-- pair blocked users, across all future events); (c) stamp room_ref from the
-- video provider. All of this is orchestrator logic (service_role); RLS only
-- scopes reads. room_ref is worker-written — no participant write path exists.

-- --- Interest (privacy-critical) --------------------------------------------
-- Read: organizers (running the event / match-rate stats) OR the rater for their
-- OWN marks. The TARGET has NO read path — "one-sided interest reveals nothing".
-- Note host is NOT granted interest read (matching data is sensitive; host's
-- domain is lobby/reports, not who-liked-whom).
create policy sd_interest_select on public.sd_interest
  for select using (
    public.sd_can_organize(org_id)
    or public.sd_owns_participant(rater_participant_id)
  );

-- A participant records/updates interest ONLY as themselves (their own seat is
-- the rater). The before-write trigger validates the target is in-event.
create policy sd_interest_insert_own on public.sd_interest
  for insert with check (public.sd_owns_participant(rater_participant_id));

-- INTEGRATION NOTE (identity pin): as with mm_pin_answer_identity, add a BEFORE
-- UPDATE trigger pinning rater_participant_id/target_participant_id for non-staff
-- so a participant cannot repoint an existing mark at a different pair (which
-- would corrupt the unique(rater,target) invariant and the mutual-match logic).
-- Name it to sort BEFORE sd_interest_scope so event_id/org_id are derived from
-- the correct (old) rater.
create policy sd_interest_update_own on public.sd_interest
  for update using (public.sd_owns_participant(rater_participant_id))
  with check (public.sd_owns_participant(rater_participant_id));

-- --- Matches (the mutual-interest reveal) -----------------------------------
-- Read: organizers see all; a participant sees a match ONLY when they are a party
-- AND revealed=true. There is NO participant write path — matches are created and
-- revealed by the orchestrator / a definer reveal function (organize-write +
-- service_role). An unrevealed match row therefore leaks nothing to either side.
create policy sd_matches_select on public.sd_matches
  for select using (
    public.sd_can_organize(org_id)
    or (
      revealed
      and (public.sd_owns_participant(participant_a_id) or public.sd_owns_participant(participant_b_id))
    )
  );

-- INTEGRATION NOTE (THE mutual-interest reveal MECHANISM — build in schema-fixes):
-- This is the privacy-critical heart of the module and is intentionally NOT built
-- in the draft so the reviewer builds it deliberately (like the classroom/
-- matchmaking splits). Precise spec:
--   1. Detection: when both directions of interest exist with verdict
--      'interested' for a pair (A rates B 'interested' AND B rates A 'interested'),
--      a match is created. Implement EITHER as an AFTER INSERT/UPDATE trigger on
--      sd_interest (SECURITY DEFINER, like sal_feed_earnings) that, on a new
--      'interested' verdict, checks for the reciprocal 'interested' row and, if
--      present, upserts a canonical-ordered sd_matches row — OR as a step in the
--      'speeddating.event-orchestrator' worker at event close. A trigger gives
--      near-live "it's a match!"; the worker gives a controlled end-of-event
--      reveal. Reviewer picks per the desired UX.
--   2. Reveal gate: set revealed=true only when BOTH sides are 'interested'
--      (mutual). One-sided interest must NEVER create a revealed row — a rejected
--      side must be indistinguishable from a not-yet-decided side to the other
--      party. If matches are created eagerly, keep revealed=false until the
--      organizer's configured reveal moment; the RLS above already hides
--      unrevealed rows from participants.
--   3. Contact sharing: on reveal, populate contact_shared from each user's
--      share preferences / the event's organizer designation (spec). Never expose
--      more than the sharer opted into.
--   4. Immutability: pin sd_matches for non-staff entirely (no participant write
--      policy exists, so this is belt-and-suspenders) and ensure a participant
--      cannot set revealed themselves.

-- --- Notes (strictly private notepad) ----------------------------------------
-- Author-only, both read and write — NOT visible to organizers/host. Excluded
-- from the blanket organize-write on purpose. Cross-event history works because
-- the author reads their own rows by (author_user_id, about_user_id).
create policy sd_notes_all_own on public.sd_notes
  for all using (author_user_id = auth.uid())
  with check (author_user_id = auth.uid());

-- INTEGRATION NOTE: pin author_user_id/about_user_id/event_id on UPDATE for the
-- author (only `body` should change) so a note can't be silently re-pointed;
-- minor, but keeps the cross-event key stable.

-- --- Reports (safety) --------------------------------------------------------
-- Read: staff_event (organizer + HOST — "handles reported rooms") see all; the
-- reporter sees their own. The reported person has NO read path.
create policy sd_reports_select on public.sd_reports
  for select using (
    public.sd_can_staff_event(org_id)
    or public.sd_owns_participant(reporter_participant_id)
  );

-- A participant files a report as themselves (their seat is the reporter). The
-- organize-write policy already covers organizer edits; host review needs its own
-- update policy since host is not in organize-write.
create policy sd_reports_insert_own on public.sd_reports
  for insert with check (public.sd_owns_participant(reporter_participant_id));

-- Host (and organizer, already covered) may review/triage reports: update state /
-- reviewed_by / reviewed_at.
-- INTEGRATION NOTE: pin reporter/reported/event/pairing/reason on this host
-- update so a host can only triage (state + review stamps), not rewrite the
-- report; stamp reviewed_by = auth.uid() server-side.
create policy sd_reports_update_staff on public.sd_reports
  for update using (public.sd_can_staff_event(org_id))
  with check (public.sd_can_staff_event(org_id));

-- --- Blocks (personal, cross-event) ------------------------------------------
-- The blocker manages their own list; the manage tier may read it for safety
-- review. The blocked person NEVER sees it. Insert requires the caller to be the
-- blocker AND an org member (root table — no parent to derive org from).
create policy sd_blocks_select on public.sd_blocks
  for select using (
    blocker_user_id = auth.uid()
    or public.sd_can_manage(org_id)
  );

create policy sd_blocks_write_own on public.sd_blocks
  for all using (blocker_user_id = auth.uid())
  with check (
    blocker_user_id = auth.uid()
    and public.is_org_member(org_id)
  );

-- --- Bans (admin) ------------------------------------------------------------
-- Manage tier only, read and write. Participants/organizers do not see the ban
-- list. (Enforcement — excluding banned users from registration/pairing — is the
-- orchestrator + the registration path.)
create policy sd_bans_all_manage on public.sd_bans
  for all using (public.sd_can_manage(org_id))
  with check (public.sd_can_manage(org_id));

-- ---------------------------------------------------------------------------
-- Deferred (documented, not built — see header):
--   * Jitsi video-provider integration (room_ref/room_provider slots exist).
--   * Socket.IO live orchestration (this schema is the state it reads/writes;
--     driver = 'speeddating.event-orchestrator' pg-boss job).
--   * Notifications / email (sign-up alerts, "it's a match!" — via platform
--     primitives).
--   * Question/answer engine (criteria + resume review + FUTURE score-seeded
--     rotations) — via the platform question engine once extracted; NOT the
--     module 1 mm_ tables (CLAUDE.md: no cross-module table imports).
--   * Post-event feedback SURVEY (spec: "feedback survey — module 2's survey
--     primitive") — reuse the classroom survey primitive once extracted to
--     packages/platform; not duplicated here.
--   * Waitlist auto-promotion preserving per-side balance (spec) — a worker/app
--     job reading sd_participants(status='waitlisted') + the event's per-side
--     capacities in format; promotes to 'registered' only when balance holds.
--
-- INTEGRATION-TIME TODO SUMMARY (guards RLS cannot express — for schema-fixes.sql):
--   T1. sd_events state-machine transition guard (+ timestamp stamps).
--   T2. sd_participants self-update column pins (checked_in/profile/consent/
--       withdraw only) — trigger sorts BEFORE sd_participants_scope.
--   T3. sd_participants host-removal: staff_event UPDATE policy + pin to
--       status->'removed'.
--   T4. sd_rounds transition guard + single-active-round invariant (partial
--       unique `where state='active'`).
--   T5. sd_pairings rotation invariants (per-round single room; repeat/block
--       enforcement; room_ref worker-only) — orchestrator + validating trigger.
--   T6. sd_interest identity pin on UPDATE — trigger sorts BEFORE sd_interest_scope.
--   T7. THE mutual-interest reveal mechanism + contact-share population +
--       sd_matches immutability (trigger on sd_interest OR worker step).
--   T8. sd_notes author-column pin on UPDATE.
--   T9. sd_reports host-triage column pin + server-side reviewed_by stamp.
--
-- Storage buckets: none required in v1 (no recording, ever; no participant file
-- uploads). If avatars/resume-card images are added later, follow the
-- cls-submissions / syn-exports org-scoped-foldername bucket pattern in the
-- integration migration (storage.objects is shared platform state — kept out of
-- this draft).
-- ---------------------------------------------------------------------------

-- Integration-review additions (2026-07-09 security review of the draft).
-- Builds the draft's flagged TODOs T1–T9 (guards RLS cannot express) plus two
-- reviewer findings: sd_can_manage must delegate to the platform's
-- is_org_admin() (docs/03 convention #9, extracted 20260709040000), and the
-- match reveal needs one audited definer path. Each guard verified live
-- against Postgres before merge.

-- Reviewer finding A: delegate the org-admin tail to the platform helper.
create or replace function public.sd_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(check_org_id)
      or public.has_module_role(check_org_id, 'speed-dating', 'admin');
$$;

-- Reviewer finding B (found live): the draft's sd_participants_select checked
-- own-row access via sd_owns_participant(id) — a definer function that queries
-- sd_participants itself. During INSERT ... RETURNING the function's snapshot
-- does NOT include the row being inserted, so a participant's own registration
-- insert failed its RETURNING select. A table's OWN policies must use direct
-- column comparisons (user_id = auth.uid()), not self-referential lookups.
-- (sd_owns_participant stays correct for OTHER tables, whose seats pre-exist.)
drop policy sd_participants_select on public.sd_participants;
create policy sd_participants_select on public.sd_participants
  for select using (
    public.sd_can_staff_event(org_id)
    or user_id = auth.uid()
    or public.sd_paired_with(id)
    or public.sd_mentors(id)
  );

-- ---------------------------------------------------------------------------
-- T1: event state-machine guard. Legal transitions only:
--   draft -> open|cancelled, open -> running|cancelled,
--   running -> complete|cancelled; complete/cancelled are terminal.
-- Fires for the worker too (triggers ignore RLS bypass) — the orchestrator
-- must follow the same lifecycle.
-- ---------------------------------------------------------------------------
create function public.sd_guard_event()
returns trigger
language plpgsql
as $$
begin
  if new.state is distinct from old.state and not (
    (old.state = 'draft' and new.state in ('open', 'cancelled'))
    or (old.state = 'open' and new.state in ('running', 'cancelled'))
    or (old.state = 'running' and new.state in ('complete', 'cancelled'))
  ) then
    raise exception 'Illegal event transition % -> %', old.state, new.state;
  end if;
  return new;
end;
$$;

create trigger sd_events_guard before update on public.sd_events
  for each row execute function public.sd_guard_event();

-- ---------------------------------------------------------------------------
-- T2 + T3: participant column pins. Organizers keep full control. A HOST (staff
-- but not organize) may ONLY flip someone's status to 'removed' (live-console
-- ejection). A self-editor may only touch check-in, consent toggles, and the
-- resume-review profile, plus withdraw — they can NOT change seat/pool/event or
-- self-promote off the waitlist. Named "..._a_pin" to sort alphabetically
-- BEFORE sd_participants_scope so a tampered event_id is reverted to OLD before
-- org_id is derived from it.
-- ---------------------------------------------------------------------------
create function public.sd_pin_participant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.sd_can_organize(old.org_id) then
    return new;
  end if;

  -- Structural identity is pinned for everyone below organize tier.
  new.event_id := old.event_id;
  new.user_id := old.user_id;
  new.seat_type := old.seat_type;
  new.pool_side := old.pool_side;
  new.mentee_participant_id := old.mentee_participant_id;

  -- Host triage: removal only; nothing else on someone else's row.
  if public.sd_can_staff_event(old.org_id) and old.user_id <> auth.uid() then
    new.checked_in := old.checked_in;
    new.checked_in_at := old.checked_in_at;
    new.allows_audience := old.allows_audience;
    new.allows_mentor := old.allows_mentor;
    new.profile_card := old.profile_card;
    new.profile := old.profile;
    if new.status is distinct from old.status and new.status <> 'removed' then
      raise exception 'Host may only remove a participant';
    end if;
    return new;
  end if;

  -- Self-editor: check-in/consents/profile + withdraw. No waitlist self-promotion.
  if old.user_id = auth.uid() then
    if new.status is distinct from old.status and new.status <> 'withdrawn' then
      raise exception 'You may only withdraw your registration';
    end if;
    return new;
  end if;

  return old; -- unreachable under RLS; pin everything as a backstop
end;
$$;

create trigger sd_participants_a_pin before update on public.sd_participants
  for each row execute function public.sd_pin_participant();

-- Host needs an UPDATE path (organize-write doesn't cover host); the pin above
-- narrows it to removal.
create policy sd_participants_update_staff on public.sd_participants
  for update using (public.sd_can_staff_event(org_id))
  with check (public.sd_can_staff_event(org_id));

-- ---------------------------------------------------------------------------
-- T4: rounds — single-active-round invariant + legal transitions
-- (pending -> active -> break|complete, break -> complete).
-- ---------------------------------------------------------------------------
create unique index sd_rounds_one_active on public.sd_rounds (event_id) where state = 'active';

create function public.sd_guard_round()
returns trigger
language plpgsql
as $$
begin
  if new.state is distinct from old.state and not (
    (old.state = 'pending' and new.state = 'active')
    or (old.state = 'active' and new.state in ('break', 'complete'))
    or (old.state = 'break' and new.state = 'complete')
  ) then
    raise exception 'Illegal round transition % -> %', old.state, new.state;
  end if;
  return new;
end;
$$;

create trigger sd_rounds_guard before update on public.sd_rounds
  for each row execute function public.sd_guard_round();

-- ---------------------------------------------------------------------------
-- T5: pairing rotation invariants — a participant sits in at most one room per
-- round. Same-slot duplicates get hard partial-unique guarantees; the cross-slot
-- case (a in one row, b in another) is validated in the before-write trigger,
-- which we extend (create or replace of the draft's function).
-- ---------------------------------------------------------------------------
create unique index sd_pairings_round_a_unique on public.sd_pairings (round_id, participant_a_id);
create unique index sd_pairings_round_b_unique
  on public.sd_pairings (round_id, participant_b_id) where participant_b_id is not null;

create or replace function public.sd_pairings_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare r public.sd_rounds%rowtype;
begin
  select * into r from public.sd_rounds where id = new.round_id;
  if not found then
    raise exception 'Unknown round %', new.round_id;
  end if;
  new.org_id := r.org_id;
  new.event_id := r.event_id;

  if not exists (
    select 1 from public.sd_participants p
    where p.id = new.participant_a_id and p.event_id = new.event_id
  ) then
    raise exception 'Participant % is not in event %', new.participant_a_id, new.event_id;
  end if;

  if new.participant_b_id is not null and not exists (
    select 1 from public.sd_participants p
    where p.id = new.participant_b_id and p.event_id = new.event_id
  ) then
    raise exception 'Participant % is not in event %', new.participant_b_id, new.event_id;
  end if;

  -- Cross-slot double-booking within the round (T5).
  if exists (
    select 1 from public.sd_pairings x
    where x.round_id = new.round_id
      and x.id is distinct from new.id
      and (
        x.participant_a_id in (new.participant_a_id, new.participant_b_id)
        or x.participant_b_id in (new.participant_a_id, new.participant_b_id)
      )
  ) then
    raise exception 'A participant is already paired in round %', new.round_id;
  end if;

  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- T6: interest identity pin — a rater cannot repoint an existing mark at a
-- different pair (would corrupt unique(rater,target) + the mutual detector).
-- Sorts BEFORE sd_interest_scope.
-- ---------------------------------------------------------------------------
create function public.sd_pin_interest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.sd_can_organize(old.org_id) then
    new.rater_participant_id := old.rater_participant_id;
    new.target_participant_id := old.target_participant_id;
  end if;
  return new;
end;
$$;

create trigger sd_interest_a_pin before update on public.sd_interest
  for each row execute function public.sd_pin_interest();

-- ---------------------------------------------------------------------------
-- T7: THE mutual-interest reveal mechanism.
-- Detection is an AFTER trigger on sd_interest (near-live, à la
-- sal_feed_earnings): a new/updated 'interested' verdict checks for the
-- reciprocal 'interested' row and upserts one canonical-ordered match with
-- revealed = FALSE — existence alone leaks nothing (RLS hides unrevealed rows
-- from both parties). If a verdict later moves OFF 'interested' before reveal,
-- the unrevealed match is deleted; a revealed match stays (already seen).
-- The reveal itself is a single audited definer function the organizer calls
-- (typically at event close): flips revealed, stamps matched_at. Contact-share
-- population (spec: per user prefs / organizer designation) happens at the app
-- layer on reveal — there is no share-prefs column in v1.
-- ---------------------------------------------------------------------------
create function public.sd_sync_mutual_match()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
  b uuid;
begin
  a := least(new.rater_participant_id, new.target_participant_id);
  b := greatest(new.rater_participant_id, new.target_participant_id);

  if new.verdict = 'interested' and exists (
    select 1 from public.sd_interest r
    where r.rater_participant_id = new.target_participant_id
      and r.target_participant_id = new.rater_participant_id
      and r.verdict = 'interested'
  ) then
    insert into public.sd_matches (org_id, event_id, participant_a_id, participant_b_id)
    values (new.org_id, new.event_id, a, b)
    on conflict (event_id, participant_a_id, participant_b_id) do nothing;
  elsif new.verdict <> 'interested' then
    delete from public.sd_matches
    where event_id = new.event_id
      and participant_a_id = a
      and participant_b_id = b
      and revealed = false;
  end if;

  return new;
end;
$$;

create trigger sd_interest_mutual after insert or update on public.sd_interest
  for each row execute function public.sd_sync_mutual_match();

-- The audited reveal path. Returns how many matches were revealed.
create function public.sd_reveal_matches(check_event_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ev_org uuid;
  cnt integer;
begin
  select org_id into ev_org from public.sd_events where id = check_event_id;
  if not found then
    raise exception 'Unknown event %', check_event_id;
  end if;
  if not public.sd_can_organize(ev_org) then
    raise exception 'Only an organizer may reveal matches';
  end if;

  update public.sd_matches
  set revealed = true, matched_at = coalesce(matched_at, now())
  where event_id = check_event_id and revealed = false;
  get diagnostics cnt = row_count;
  return cnt;
end;
$$;

grant execute on function public.sd_reveal_matches(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- T8: notes — only body may change; the cross-event key (author/about/event)
-- stays stable. Applies to everyone (the author is the only updater anyway).
-- ---------------------------------------------------------------------------
create function public.sd_pin_note()
returns trigger
language plpgsql
as $$
begin
  new.author_user_id := old.author_user_id;
  new.about_user_id := old.about_user_id;
  new.event_id := old.event_id;
  new.pairing_id := old.pairing_id;
  return new;
end;
$$;

create trigger sd_notes_a_pin before update on public.sd_notes
  for each row execute function public.sd_pin_note();

-- ---------------------------------------------------------------------------
-- T9: report triage — a host (staff but not organize) may only change
-- state/review fields, never the report's substance; reviewed_by/reviewed_at
-- stamp server-side on any state change, for hosts AND organizers.
-- ---------------------------------------------------------------------------
create function public.sd_pin_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.sd_can_organize(old.org_id) then
    new.reporter_participant_id := old.reporter_participant_id;
    new.reported_participant_id := old.reported_participant_id;
    new.pairing_id := old.pairing_id;
    new.reason := old.reason;
    new.detail := old.detail;
    new.during_call := old.during_call;
  end if;
  if new.state is distinct from old.state then
    new.reviewed_by := auth.uid();
    new.reviewed_at := coalesce(new.reviewed_at, now());
  end if;
  return new;
end;
$$;

create trigger sd_reports_a_pin before update on public.sd_reports
  for each row execute function public.sd_pin_report();
