-- =============================================================================
-- Speed dating: "someone you said yes to has left the platform" (docs/21 §7.8,
-- founder decision 2026-10-08).
--
-- BEFORE: only a MUTUAL, revealed match whose counterparty left was reported
-- (sd_my_departed_matches). If you said yes and the other person said no OR
-- never decided, nothing was shown — and since the silhouette deletes the
-- pairing row, that person simply vanished from your event page.
--
-- NOW: sd_my_departed_interests(event) returns the seats YOU marked
-- 'interested' whose person has left, so the page can say so. The founder's
-- point, and why it does not break the reveal guard: "no" and "undecided" are
-- returned IDENTICALLY (both are "no match"), exactly as they already look.
--
-- Two conditions, both deliberate:
--   * the deletion has COMPLETED (account_deletions.state = 'deleted'), never
--     the 30-day grace period. That period is reversible; reporting it to a
--     non-match would leak a pending, private decision. (A revealed MATCH
--     still learns of the grace period through sd_my_departed_matches — a
--     match has a relationship with the person; this is not one.)
--   * the event is COMPLETE, so no decision can still change.
-- REVEALED mutual matches are excluded: sd_my_departed_matches covers them.
-- An unrevealed one is returned like any other yes (see the query).
-- Only the caller's own marks, only while they are an active org member.
-- =============================================================================

create function public.sd_my_departed_interests(check_event_id uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select i.target_participant_id
  from public.sd_interest i
  join public.sd_participants mine on mine.id = i.rater_participant_id
  join public.sd_participants other on other.id = i.target_participant_id
  join public.sd_events e on e.id = i.event_id
  where i.event_id = check_event_id
    and mine.user_id = auth.uid()
    and public.is_org_member(mine.org_id)
    and i.verdict = 'interested'
    and e.state = 'complete'
    and other.user_id <> mine.user_id
    and exists (
      select 1 from public.account_deletions d
      where d.user_id = other.user_id and d.state = 'deleted'
    )
    -- Skip only a REVEALED match: it is reported by sd_my_departed_matches.
    -- An UNREVEALED match must be returned exactly like a no or an undecided —
    -- revealing is a separate organizer step, so an event can be complete
    -- with matches still hidden, and skipping those would single out "they said
    -- yes too" (adversarial code review, 2026-10-09).
    and not exists (
      select 1 from public.sd_matches m
      where m.event_id = i.event_id
        and m.revealed
        and mine.id in (m.participant_a_id, m.participant_b_id)
        and other.id in (m.participant_a_id, m.participant_b_id)
    );
$$;

revoke execute on function public.sd_my_departed_interests(uuid) from public, anon, authenticated, service_role;
grant execute on function public.sd_my_departed_interests(uuid) to authenticated;

do $$
begin
  if has_function_privilege('anon', 'public.sd_my_departed_interests(uuid)', 'execute')
     or has_function_privilege('service_role', 'public.sd_my_departed_interests(uuid)', 'execute') then
    raise exception 'assert: sd_my_departed_interests is executable beyond authenticated';
  end if;
  if not has_function_privilege('authenticated', 'public.sd_my_departed_interests(uuid)', 'execute') then
    raise exception 'assert: authenticated cannot call sd_my_departed_interests';
  end if;
end $$;
