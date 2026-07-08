-- Module 1: Make-a-Match (prefix mm_). Spec: docs/modules/module-1-matchmaking.md
-- DRAFT for review — NOT applied, NOT wired into supabase/migrations/. Becomes
-- supabase/migrations/<ts>_matchmaking.sql once a human security-reviews it
-- (mirrors how modules/classroom/schema-draft.sql became
-- supabase/migrations/20260708010000_classroom.sql, with fixes folded in
-- afterwards). Patterns copied from that exemplar: explicit grants (CLI
-- migrations do NOT inherit API-role grants), RLS on every table,
-- security-definer helpers to avoid RLS recursion, scope-sync BEFORE
-- INSERT/UPDATE triggers that derive org_id from the parent FK chain so a
-- client can never misfile a row into another org.
--
-- Relies on platform objects that already exist:
--   public.is_superadmin(), public.is_org_member(), public.set_updated_at()   (core migration)
--   public.has_module_role(org, module_key, role)                             (module 3 migration)
-- Module key used throughout: 'matchmaking'. Role vocabulary: 'single',
-- 'matchmaker', 'admin' (module_roles.role values — see docs/modules/module-1).
--
-- Column shapes are pinned to modules/matchmaking/src/scoring.ts's Zod schemas
-- (questionSchema, answerSchema, adminLocksSchema) — see scoring.test.ts for
-- the behavioral contract these columns must support (care −10..+10, position
-- 0-indexed into scaleLabels 2..5 entries, dealbreaker/auto/shareWithMatch).
--
-- Settings (top-X visible matches, care-slider label text, default locks) live
-- in org_modules.settings for module_key 'matchmaking' — no ad-hoc config
-- table (docs/03 rule: settings via the settings primitive only).
--
-- Messaging (spec: v1 users→admins only, via "the generic conversations
-- primitive") is deliberately NOT built here — grepped packages/platform and
-- supabase/migrations/*, no conversations/messages primitive exists yet.
-- Building one now for a single module would violate CLAUDE.md's "never build
-- platform primitives speculatively" rule; deferred until a second module
-- needs it (or founder greenlights extracting it for this one).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- Question = text + a 2..5 point labeled scale + optional admin locks.
-- Approval workflow: singles/matchmakers submit (status 'pending'), admin
-- tweaks and approves/rejects. admin_locks shape matches adminLocksSchema:
-- {answer?: int 0-indexed, care?: int -10..10, dealbreaker?: bool}.
create table public.mm_questions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  text text not null,
  scale_labels text[] not null,
  admin_locks jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  submitted_by uuid references auth.users (id) on delete set null,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 2..5 labeled points (questionSchema: scaleLabels.min(2).max(5)). Empty
  -- arrays report array_length() = NULL in Postgres, hence the coalesce.
  constraint mm_questions_scale_labels_len
    check (coalesce(array_length(scale_labels, 1), 0) between 2 and 5),
  -- admin_locks may only carry the three known keys (defense in depth; Zod
  -- adminLocksSchema is the primary validator at the app layer).
  constraint mm_questions_admin_locks_keys
    check (admin_locks - array['answer', 'care', 'dealbreaker']::text[] = '{}'::jsonb),
  constraint mm_questions_admin_locks_care
    check (not (admin_locks ? 'care') or ((admin_locks ->> 'care')::int between -10 and 10)),
  constraint mm_questions_admin_locks_answer
    check (not (admin_locks ? 'answer') or ((admin_locks ->> 'answer')::int >= 0)),
  constraint mm_questions_admin_locks_dealbreaker
    check (not (admin_locks ? 'dealbreaker') or jsonb_typeof(admin_locks -> 'dealbreaker') = 'boolean')
);

-- One row per (question, user). DESIGN DECISION (spec: "a newly approved
-- question materializes for a user only after they log in and see it"): there
-- is no separate "materialized" flag — a missing row IS the not-yet-seen
-- state (directionalScore() in scoring.ts already skips questions the other
-- side hasn't answered, so an absent row is mathematically inert, matching
-- the spec exactly). Rows are created lazily by mm_ensure_answer() below when
-- a user first views a question, as the spec's vanilla auto-answer
-- (middle position, care 0), with admin locks materialized in immediately.
-- auto=true means "system-generated, untouched"; flips to false when the
-- user (or the app, on their behalf) writes a real value.
create table public.mm_answers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  question_id uuid not null references public.mm_questions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  position integer not null check (position >= 0),
  care integer not null default 0 check (care between -10 and 10),
  dealbreaker boolean not null default false,
  auto boolean not null default true,
  share_with_match boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (question_id, user_id)
);

-- Persisted pair scores (spec: percent + excluded, never null — pairScore()
-- in scoring.ts always returns a concrete result). Canonicalized ordering
-- (user_a < user_b, enforced by CHECK, not a trigger) means the worker/writer
-- is responsible for sorting the two ids before upserting — this is what
-- prevents duplicate/mirrored (A,B) and (B,A) rows for the same pair.
-- stale: set true whenever either user's answers change (mm_mark_pairs_stale
-- trigger below); the matchmaking.rescore worker (docs/01 job catalog)
-- recomputes stale rows and sets stale=false, computed_at=now().
create table public.mm_pair_scores (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_a uuid not null references auth.users (id) on delete cascade,
  user_b uuid not null references auth.users (id) on delete cascade,
  percent integer not null default 0 check (percent between 0 and 100),
  excluded boolean not null default false,
  stale boolean not null default true,
  computed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mm_pair_scores_canonical_order check (user_a < user_b),
  unique (org_id, user_a, user_b)
);

-- Admin-defined groups of singles (spec: "admin defines groups of singles and
-- assigns matchmakers to individuals or groups").
create table public.mm_groups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.mm_group_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  group_id uuid not null references public.mm_groups (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);

-- A matchmaker is assigned to exactly one target: an individual single OR a
-- group (never both — enforced below). Multiple matchmakers may be assigned
-- to the same single/group; a matchmaker may hold several assignment rows.
create table public.mm_matchmaker_assignments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  matchmaker_id uuid not null references auth.users (id) on delete cascade,
  target_type text not null check (target_type in ('individual', 'group')),
  target_user_id uuid references auth.users (id) on delete cascade,
  target_group_id uuid references public.mm_groups (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint mm_assignments_one_target check (
    (target_type = 'individual' and target_user_id is not null and target_group_id is null)
    or
    (target_type = 'group' and target_group_id is not null and target_user_id is null)
  )
);

-- Prevent duplicate identical assignments (partial unique — plain UNIQUE
-- can't span two nullable alternative-target columns; same technique as
-- cls_grades_target_unique in the classroom exemplar).
create unique index mm_assignments_individual_unique
  on public.mm_matchmaker_assignments (matchmaker_id, target_user_id)
  where target_user_id is not null;

create unique index mm_assignments_group_unique
  on public.mm_matchmaker_assignments (matchmaker_id, target_group_id)
  where target_group_id is not null;

-- ---------------------------------------------------------------------------
-- Indexes (FK lookups + the query shapes the module actually needs)
-- ---------------------------------------------------------------------------

create index mm_questions_org_status_idx on public.mm_questions (org_id, status);
create index mm_answers_user_idx on public.mm_answers (user_id);
create index mm_answers_question_idx on public.mm_answers (question_id);

-- "Top X matches for user N from either side": a plain OR on (user_a, user_b)
-- can't use one btree efficiently, so provide one index per side; the app/
-- worker should query as
--   (select ... where org_id=$1 and user_a=$2 and not excluded order by percent desc limit X)
--   union all
--   (select ... where org_id=$1 and user_b=$2 and not excluded order by percent desc limit X)
--   order by percent desc limit X
-- so each leg hits its own index.
create index mm_pair_scores_user_a_idx
  on public.mm_pair_scores (org_id, user_a, percent desc) where not excluded;
create index mm_pair_scores_user_b_idx
  on public.mm_pair_scores (org_id, user_b, percent desc) where not excluded;
-- Worker's stale-row scan (matchmaking.rescore).
create index mm_pair_scores_stale_idx on public.mm_pair_scores (org_id, stale) where stale;

create index mm_group_members_group_idx on public.mm_group_members (group_id);
create index mm_group_members_user_idx on public.mm_group_members (user_id);
create index mm_assignments_matchmaker_idx on public.mm_matchmaker_assignments (matchmaker_id);
create index mm_assignments_target_group_idx
  on public.mm_matchmaker_assignments (target_group_id) where target_group_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at triggers (tables whose rows get edited after creation)
-- ---------------------------------------------------------------------------

do $$
declare t text;
begin
  foreach t in array array['mm_questions', 'mm_answers', 'mm_pair_scores', 'mm_groups']
  loop
    execute format(
      'create trigger %I_updated_at before update on public.%I
         for each row execute function public.set_updated_at();',
      t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants first (migrations do not inherit defaults — see core migration note).
-- RLS below restricts rows; service_role (worker) bypasses RLS for the
-- matchmaking.rescore job and must filter by org_id explicitly in that code.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete
  on public.mm_questions, public.mm_answers, public.mm_pair_scores,
     public.mm_groups, public.mm_group_members, public.mm_matchmaker_assignments
  to authenticated, service_role;

alter table public.mm_questions enable row level security;
alter table public.mm_answers enable row level security;
alter table public.mm_pair_scores enable row level security;
alter table public.mm_groups enable row level security;
alter table public.mm_group_members enable row level security;
alter table public.mm_matchmaker_assignments enable row level security;

-- ---------------------------------------------------------------------------
-- Role helpers (security definer: they read tables the caller may not).
-- ---------------------------------------------------------------------------

-- Staff = superadmin, module-role admin, or org owner/admin. Mirrors
-- cls_can_manage in the classroom exemplar.
create function public.mm_can_manage(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_superadmin()
      or public.has_module_role(check_org_id, 'matchmaking', 'admin')
      or exists (
           select 1 from public.org_members
           where org_id = check_org_id
             and user_id = auth.uid()
             and role in ('owner', 'admin')
         );
$$;

create function public.mm_is_matchmaker(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_module_role(check_org_id, 'matchmaking', 'matchmaker');
$$;

create function public.mm_is_single(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_module_role(check_org_id, 'matchmaking', 'single');
$$;

-- A matchmaker sees a single if assigned to them individually OR via a group
-- they belong to. Definer avoids RLS recursion across
-- mm_matchmaker_assignments / mm_group_members.
create function public.mm_matchmaker_can_see(check_org_id uuid, check_single_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.mm_matchmaker_assignments a
    where a.org_id = check_org_id
      and a.matchmaker_id = auth.uid()
      and (
        a.target_user_id = check_single_id
        or (
          a.target_group_id is not null
          and exists (
            select 1 from public.mm_group_members gm
            where gm.group_id = a.target_group_id and gm.user_id = check_single_id
          )
        )
      )
  );
$$;

-- The reverse direction: does the caller (a single) have check_matchmaker_id
-- assigned to them, individually or via a group they belong to? Used so a
-- single can see who their matchmaker is (spec: introductions happen "via a
-- matchmaker" — a single should know who that is).
create function public.mm_assignment_covers_me(check_matchmaker_id uuid, check_target_group_id uuid, check_target_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select check_target_user_id = auth.uid()
      or (
        check_target_group_id is not null
        and exists (
          select 1 from public.mm_group_members gm
          where gm.group_id = check_target_group_id and gm.user_id = auth.uid()
        )
      );
$$;

-- ---------------------------------------------------------------------------
-- Scope-sync + lock-enforcement triggers.
-- Derive org_id from the parent FK chain server-side so a client can never
-- misfile a row into another org by supplying a bogus org_id (the
-- vulnerability class the classroom module's security review found and
-- fixed — see modules/classroom/schema-fixes.sql). mm_questions/mm_groups are
-- root tables with no parent to derive from; their org_id is client-supplied
-- but RLS write checks (mm_can_manage / role checks scoped to that exact
-- org_id) already prevent misfiling, matching how cls_courses is handled in
-- the classroom exemplar.
-- ---------------------------------------------------------------------------

-- mm_answers: derive org_id from the question, and — this is the mechanism
-- spec decision #4 asks for — overwrite any locked field (per
-- mm_questions.admin_locks) so a user can only ever supply the UNLOCKED
-- parts of their answer. Also range-checks position against the question's
-- actual scale length (can't be a static CHECK on this table alone since it
-- depends on the parent question's scale_labels).
create function public.mm_answers_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.mm_questions%rowtype;
  scale_size integer;
begin
  select * into q from public.mm_questions where id = new.question_id;
  if not found then
    raise exception 'Unknown question %', new.question_id;
  end if;

  new.org_id := q.org_id;

  if q.admin_locks ? 'answer' then
    new.position := (q.admin_locks ->> 'answer')::int;
  end if;
  if q.admin_locks ? 'care' then
    new.care := (q.admin_locks ->> 'care')::int;
  end if;
  if q.admin_locks ? 'dealbreaker' then
    new.dealbreaker := (q.admin_locks ->> 'dealbreaker')::boolean;
  end if;

  scale_size := array_length(q.scale_labels, 1);
  if new.position > scale_size - 1 then
    raise exception 'position % out of range for question % (scale size %)',
      new.position, new.question_id, scale_size;
  end if;

  return new;
end;
$$;

create trigger mm_answers_before_write before insert or update on public.mm_answers
  for each row execute function public.mm_answers_before_write();

-- After an answer is written, mark every existing pair-score row involving
-- this user as stale (spec: "only their rows are marked stale — O(N) recompute
-- per update, not O(N²)"). New pairs that have never been scored are picked
-- up by the worker's own population sweep, not this trigger.
create function public.mm_mark_pairs_stale()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.mm_pair_scores
  set stale = true
  where org_id = new.org_id
    and (user_a = new.user_id or user_b = new.user_id)
    and stale = false;
  return new;
end;
$$;

create trigger mm_answers_after_write after insert or update on public.mm_answers
  for each row execute function public.mm_mark_pairs_stale();

-- mm_group_members: derive org_id from the group.
create function public.mm_sync_from_group()
returns trigger
language plpgsql
as $$
begin
  select g.org_id into new.org_id from public.mm_groups g where g.id = new.group_id;
  if new.org_id is null then
    raise exception 'Unknown group %', new.group_id;
  end if;
  return new;
end;
$$;

create trigger mm_group_members_scope before insert or update on public.mm_group_members
  for each row execute function public.mm_sync_from_group();

-- mm_matchmaker_assignments: when the target is a group, derive org_id from
-- it (belt-and-suspenders — only staff can write this table per the RLS
-- policies below, but this keeps the guarantee uniform with every other
-- child table). Individual-target rows keep the client-supplied org_id,
-- which RLS already ties to an org the caller manages.
create function public.mm_sync_assignment_org()
returns trigger
language plpgsql
as $$
begin
  if new.target_group_id is not null then
    select g.org_id into new.org_id from public.mm_groups g where g.id = new.target_group_id;
    if new.org_id is null then
      raise exception 'Unknown group %', new.target_group_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger mm_assignments_scope before insert or update on public.mm_matchmaker_assignments
  for each row execute function public.mm_sync_assignment_org();

-- Lazily materialize a user's answer to an approved question (spec: "a newly
-- approved question materializes for a user only after they log in and see
-- it" — see the design-decision comment on mm_answers above). Idempotent:
-- safe to call every time the question renders. Applies admin locks via the
-- same defaults mm_answers_before_write() would enforce on write.
create function public.mm_ensure_answer(check_question_id uuid)
returns public.mm_answers
language plpgsql
security definer
set search_path = public
as $$
declare
  q public.mm_questions%rowtype;
  result public.mm_answers%rowtype;
begin
  select * into q from public.mm_questions
  where id = check_question_id and status = 'approved';
  if not found then
    raise exception 'Unknown or unapproved question %', check_question_id;
  end if;

  insert into public.mm_answers (org_id, question_id, user_id, position, care, dealbreaker, auto, share_with_match)
  values (
    q.org_id,
    q.id,
    auth.uid(),
    coalesce((q.admin_locks ->> 'answer')::int, floor((array_length(q.scale_labels, 1) - 1) / 2.0)::int),
    coalesce((q.admin_locks ->> 'care')::int, 0),
    coalesce((q.admin_locks ->> 'dealbreaker')::boolean, false),
    true,
    false
  )
  on conflict (question_id, user_id) do nothing
  returning * into result;

  if result.id is null then
    select * into result from public.mm_answers
    where question_id = check_question_id and user_id = auth.uid();
  end if;

  return result;
end;
$$;

grant execute on function public.mm_ensure_answer(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- Uniform staff-write: admins (and org owners/admins/superadmin) have full
-- control of every module table.
do $$
declare t text;
begin
  foreach t in array array[
    'mm_questions', 'mm_answers', 'mm_pair_scores',
    'mm_groups', 'mm_group_members', 'mm_matchmaker_assignments']
  loop
    execute format(
      'create policy %I_write_staff on public.%I for all
         using (public.mm_can_manage(org_id))
         with check (public.mm_can_manage(org_id));',
      t, t);
  end loop;
end $$;

-- mm_questions: singles/matchmakers see approved questions plus their own
-- pending/rejected proposals (so they get feedback on what they submitted).
-- Bare org members with no matchmaking role see nothing.
create policy mm_questions_select_participant on public.mm_questions
  for select using (
    (public.mm_is_single(org_id) or public.mm_is_matchmaker(org_id))
    and (status = 'approved' or submitted_by = auth.uid())
  );

-- Singles/matchmakers may propose questions (always landing as 'pending';
-- admin does all subsequent editing/approval via the staff policy above).
create policy mm_questions_insert_proposer on public.mm_questions
  for insert with check (
    submitted_by = auth.uid()
    and status = 'pending'
    and (public.mm_is_single(org_id) or public.mm_is_matchmaker(org_id))
  );

-- mm_answers: a single manages only their own row; a matchmaker reads the
-- rows of singles they're assigned to (individually or via group).
create policy mm_answers_select on public.mm_answers
  for select using (
    user_id = auth.uid()
    or public.mm_matchmaker_can_see(org_id, user_id)
  );

create policy mm_answers_insert_own on public.mm_answers
  for insert with check (
    user_id = auth.uid() and public.mm_is_single(org_id)
  );

create policy mm_answers_update_own on public.mm_answers
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- mm_pair_scores: a single sees pairs involving them; a matchmaker sees pairs
-- involving a single they're assigned to. Excluded pairs are hidden from both
-- (spec: a failed dealbreaker means "no scoring, no list appearance" — full
-- exclusion, not just a 0%). Writes are worker/service_role or staff only —
-- no policy grants ordinary users insert/update/delete here.
create policy mm_pair_scores_select on public.mm_pair_scores
  for select using (
    not excluded
    and (
      user_a = auth.uid()
      or user_b = auth.uid()
      or public.mm_matchmaker_can_see(org_id, user_a)
      or public.mm_matchmaker_can_see(org_id, user_b)
    )
  );

-- mm_groups: staff manage; a matchmaker may read a group they're assigned to
-- (to see its roster via mm_group_members). Singles do not read group rows
-- directly (ambiguous call — see final report).
create policy mm_groups_select_assigned on public.mm_groups
  for select using (
    exists (
      select 1 from public.mm_matchmaker_assignments a
      where a.target_group_id = mm_groups.id and a.matchmaker_id = auth.uid()
    )
  );

-- mm_group_members: staff manage; an assigned matchmaker reads the roster of
-- a group they serve.
create policy mm_group_members_select_assigned on public.mm_group_members
  for select using (
    exists (
      select 1 from public.mm_matchmaker_assignments a
      where a.target_group_id = mm_group_members.group_id and a.matchmaker_id = auth.uid()
    )
  );

-- mm_matchmaker_assignments: staff manage; a matchmaker sees their own
-- assignment rows; a single sees the assignment(s) that cover them (so they
-- know who their matchmaker is).
create policy mm_assignments_select on public.mm_matchmaker_assignments
  for select using (
    matchmaker_id = auth.uid()
    or public.mm_assignment_covers_me(matchmaker_id, target_group_id, target_user_id)
  );

-- ---------------------------------------------------------------------------
-- Deferred (documented, not built — see header comment):
--   * conversations/messages primitive for users→admin messaging (spec v1).
--   * mm_top_matches-style convenience RPC: the app can query
--     mm_pair_scores directly under RLS using the UNION ALL pattern noted by
--     the indexes above; not adding an extra function until real usage shows
--     it's needed.
-- ---------------------------------------------------------------------------
