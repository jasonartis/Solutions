-- Item 3 (founder, 2026-07-12): the mutual-agreement -> introduction flow,
-- the last real gap in module 1's own spec (docs/modules/module-1-matchmaking
-- line 37: "Mutual agreement -> introduction ... One-sided interest reveals
-- nothing"). Until now a single could see their computed matches and any
-- share-flagged answers, but had no way to SAY "yes, I want to pursue this
-- specific person," and nothing gated an introduction on both sides agreeing.
--
-- mm_interests records a single's directional interest in one specific match.
-- Interest is PRIVATE to the person who expressed it — the SELECT policy never
-- exposes incoming interest, so a one-sided crush is invisible to its target
-- (no "they didn't pick me" signal). The reveal happens only when interest is
-- MUTUAL, via the definer functions below (mirroring mm_shared_answers /
-- sd_matches): once both sides have expressed interest AND they are a real
-- non-excluded scored pair, each sees the other's contact info — that IS the
-- introduction. A matchmaker/admin can see mutual pairs to facilitate.

create table public.mm_interests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  target_user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (org_id, user_id, target_user_id),
  constraint mm_interests_not_self check (user_id <> target_user_id)
);

create index mm_interests_target_idx on public.mm_interests (org_id, target_user_id);

grant select, insert, delete on public.mm_interests to authenticated, service_role;

alter table public.mm_interests enable row level security;

-- SELECT: a single sees only their OWN outgoing interest (never incoming —
-- that's the privacy invariant; mutual reveal is via the definer fn, not raw
-- rows). Admins see all for oversight. Matchmakers do NOT read raw rows (they
-- get mutual pairs via mm_mutual_pairs) so they can't observe one-sided
-- interest among their singles either.
create policy mm_interests_select on public.mm_interests
  for select using (
    user_id = auth.uid()
    or public.mm_can_manage(org_id)
  );

-- INSERT: a single expresses their OWN interest, and only in a real
-- (non-excluded) scored match — you can't express interest in someone the
-- engine never paired you with.
create policy mm_interests_insert_own on public.mm_interests
  for insert with check (
    user_id = auth.uid()
    and public.mm_is_single(org_id)
    and exists (
      select 1 from public.mm_pair_scores s
      where s.org_id = mm_interests.org_id
        and s.excluded = false
        and (
          (s.user_a = auth.uid() and s.user_b = mm_interests.target_user_id)
          or (s.user_a = mm_interests.target_user_id and s.user_b = auth.uid())
        )
    )
  );

-- DELETE: withdraw your own interest at any time (retracting before the other
-- side agrees means the pair never becomes mutual — nothing was ever revealed).
create policy mm_interests_delete_own on public.mm_interests
  for delete using (user_id = auth.uid());

-- The introduction: for the calling single, every person with whom interest is
-- MUTUAL (both rows exist) and who is a real non-excluded pair — returned with
-- contact info (display name + email). One-sided interest yields no row (the
-- self-join to `theirs` fails), so a single learns of interest only once it is
-- reciprocated. Caller must hold the single role (docs/03 #13).
create function public.mm_mutual_matches()
returns table (matched_user uuid, display_name text, email text)
language sql
stable
security definer
set search_path = public
as $$
  select mine.target_user_id, p.display_name, p.email
  from public.mm_interests mine
  join public.mm_interests theirs
    on theirs.org_id = mine.org_id
   and theirs.user_id = mine.target_user_id
   and theirs.target_user_id = mine.user_id
  join public.profiles p on p.user_id = mine.target_user_id
  where mine.user_id = auth.uid()
    and public.mm_is_single(mine.org_id)
    and exists (
      select 1 from public.mm_pair_scores s
      where s.org_id = mine.org_id
        and s.excluded = false
        and (
          (s.user_a = mine.user_id and s.user_b = mine.target_user_id)
          or (s.user_a = mine.target_user_id and s.user_b = mine.user_id)
        )
    );
$$;

grant execute on function public.mm_mutual_matches() to authenticated;

-- Facilitation view: mutual pairs the caller may act on — an admin
-- (mm_can_manage) sees every mutual pair in the org; a matchmaker sees only
-- pairs where they're assigned to at least one side (mm_matchmaker_can_see).
-- Returned once per pair in canonical (user_a < user_b) order. Singles get
-- nothing here (they use mm_mutual_matches for their own).
create function public.mm_mutual_pairs(check_org_id uuid)
returns table (user_a uuid, user_b uuid)
language sql
stable
security definer
set search_path = public
as $$
  select i1.user_id, i1.target_user_id
  from public.mm_interests i1
  join public.mm_interests i2
    on i2.org_id = i1.org_id
   and i2.user_id = i1.target_user_id
   and i2.target_user_id = i1.user_id
  where i1.org_id = check_org_id
    and i1.user_id < i1.target_user_id   -- one row per symmetric pair
    and exists (
      select 1 from public.mm_pair_scores s
      where s.org_id = i1.org_id
        and s.excluded = false
        and (
          (s.user_a = i1.user_id and s.user_b = i1.target_user_id)
          or (s.user_a = i1.target_user_id and s.user_b = i1.user_id)
        )
    )
    and (
      public.mm_can_manage(check_org_id)
      or (
        public.mm_is_matchmaker(check_org_id)
        and (
          public.mm_matchmaker_can_see(check_org_id, i1.user_id)
          or public.mm_matchmaker_can_see(check_org_id, i1.target_user_id)
        )
      )
    );
$$;

grant execute on function public.mm_mutual_pairs(uuid) to authenticated;
