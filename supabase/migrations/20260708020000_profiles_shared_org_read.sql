-- Members of the same org may read each other's profiles (display name/email).
-- Surfaced by module 2: a professor's roster showed raw UUIDs because profiles
-- were own-row-only. Standard behavior for team tools; superadmin already saw all.

create function public.shares_org_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.org_members mine
    join public.org_members theirs on theirs.org_id = mine.org_id
    where mine.user_id = auth.uid()
      and theirs.user_id = target_user
  );
$$;

create policy profiles_select_shared_org on public.profiles
  for select using (public.shares_org_with(user_id));
