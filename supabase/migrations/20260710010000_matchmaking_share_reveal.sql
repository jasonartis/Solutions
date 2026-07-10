-- Module 1: the share-with-match reveal (spec + CLAUDE.md flagged gap).
-- A single opts per answer into "share this answer with a potential match";
-- RLS rightly blocks cross-single reads of mm_answers, so the reveal is a
-- definer function exposing EXACTLY the shared slice, and only between
-- actual matches:
--   - caller must hold the module 'single' role (docs/03 #13: definer
--     re-checks role gates internally);
--   - the two users must have a scored, non-excluded pair (a dealbreaker
--     exclusion means no reveal in either direction);
--   - only answers with share_with_match = true are returned, joined with
--     the question text and labels so the UI can render them.
create function public.mm_shared_answers(check_other_user uuid)
returns table (
  question_text text,
  scale_labels jsonb,
  answer_position integer,
  answer_care integer
)
language sql
stable
security definer
set search_path = public
as $$
  select q.text, to_jsonb(q.scale_labels), a.position, a.care -- aliased by RETURNS TABLE order
  from public.mm_answers a
  join public.mm_questions q on q.id = a.question_id
  where a.user_id = check_other_user
    and a.share_with_match = true
    and q.status = 'approved'
    -- Caller is a single in the same org as the answer…
    and public.has_module_role(a.org_id, 'matchmaking', 'single')
    -- …and the two are a real (non-excluded) scored pair.
    and exists (
      select 1 from public.mm_pair_scores s
      where s.org_id = a.org_id
        and s.excluded = false
        and (
          (s.user_a = auth.uid() and s.user_b = check_other_user)
          or (s.user_a = check_other_user and s.user_b = auth.uid())
        )
    );
$$;

grant execute on function public.mm_shared_answers(uuid) to authenticated;
