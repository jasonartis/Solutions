-- Public (no-login) schedule access for module 3.
-- Instead of anon RLS policies on the config tables, two security-definer
-- functions expose exactly what a public viewer may see: published weeks,
-- and the config needed to render one published week. Makers control the
-- list via syn_published_weeks (docs/modules/module-3: "maker allowed dates").

create function public.syn_public_weeks(p_org_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when o.id is null then null
    else jsonb_build_object(
      'org', jsonb_build_object('name', o.name, 'slug', o.slug),
      'weeks', coalesce(
        (select jsonb_agg(w.week_start order by w.week_start desc)
         from syn_published_weeks w
         where w.org_id = o.id and w.published),
        '[]'::jsonb
      )
    )
  end
  from (
    select o2.id, o2.name, o2.slug
    from orgs o2
    join org_modules om on om.org_id = o2.id
      and om.module_key = 'synagogue-schedules' and om.enabled
    where o2.slug = p_org_slug
  ) o
$$;

create function public.syn_public_week(p_org_slug text, p_week_start date)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select case
    when not exists (
      select 1
      from orgs o
      join syn_published_weeks w on w.org_id = o.id
      where o.slug = p_org_slug and w.week_start = p_week_start and w.published
    ) then null
    else (
      select jsonb_build_object(
        'org', jsonb_build_object('name', o.name),
        'settings', coalesce(
          (select om.settings from org_modules om
           where om.org_id = o.id and om.module_key = 'synagogue-schedules' and om.enabled),
          '{}'::jsonb
        ),
        'types', coalesce(
          (select jsonb_agg(jsonb_build_object(
             'id', t.id, 'name', t.name, 'name_hebrew', t.name_hebrew,
             'trigger_condition', t.trigger_condition, 'span', t.span
           ) order by t.sort)
           from syn_schedule_types t where t.org_id = o.id),
          '[]'::jsonb
        ),
        'sections', coalesce(
          (select jsonb_agg(jsonb_build_object(
             'id', s.id, 'schedule_type_id', s.schedule_type_id, 'name', s.name,
             'name_hebrew', s.name_hebrew, 'visibility_condition', s.visibility_condition
           ) order by s.sort)
           from syn_sections s where s.org_id = o.id),
          '[]'::jsonb
        ),
        'lines', coalesce(
          (select jsonb_agg(jsonb_build_object(
             'id', l.id, 'section_id', l.section_id, 'name', l.name,
             'name_hebrew', l.name_hebrew, 'rule', l.rule
           ) order by l.sort)
           from syn_lines l where l.org_id = o.id),
          '[]'::jsonb
        ),
        'overrides', coalesce(
          (select jsonb_agg(jsonb_build_object(
             'section_id', v.section_id, 'text', v.text, 'text_hebrew', v.text_hebrew
           ) order by v.sort)
           from syn_overrides v where v.org_id = o.id and v.week_start = p_week_start),
          '[]'::jsonb
        )
      )
      from orgs o where o.slug = p_org_slug
    )
  end
$$;

grant execute on function public.syn_public_weeks(text) to anon, authenticated;
grant execute on function public.syn_public_week(text, date) to anon, authenticated;
