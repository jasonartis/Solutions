-- Module 2 materials UI (integration review, 2026-07-09): the draft's
-- cls_materials_storage_read only checked org membership, not the
-- visible_from/visible_until window that cls_materials' own RLS enforces —
-- a student could read a not-yet-published or expired file directly from
-- storage if they had the path. Replace it with a definer function that
-- mirrors the table's visibility rule exactly. Also add the write/delete
-- policies staff need (materials are uploaded client-side by the professor,
-- unlike exports which are worker-only).

create function public.cls_material_storage_visible(check_path text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.cls_materials m
    where m.storage_path = check_path
      and (
        public.cls_can_manage(m.org_id)
        or public.cls_is_ga(m.org_id)
        or exists (
             select 1 from public.cls_publications p
             where p.material_id = m.id
               and public.cls_is_class_member(p.class_id)
               and (p.visible_from is null or p.visible_from <= now())
               and (p.visible_until is null or now() < p.visible_until)
           )
      )
  );
$$;

grant execute on function public.cls_material_storage_visible(text) to authenticated;

drop policy if exists cls_materials_storage_read on storage.objects;
create policy cls_materials_storage_read on storage.objects
  for select using (
    bucket_id = 'cls-materials' and public.cls_material_storage_visible(name)
  );

create policy cls_materials_storage_write on storage.objects
  for insert with check (
    bucket_id = 'cls-materials'
    and public.cls_can_manage(((storage.foldername(name))[1])::uuid)
  );

create policy cls_materials_storage_delete on storage.objects
  for delete using (
    bucket_id = 'cls-materials'
    and public.cls_can_manage(((storage.foldername(name))[1])::uuid)
  );
