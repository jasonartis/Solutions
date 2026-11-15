-- Storage upload paths must name the uploader's real org (founder: "fix it", 2026-11-15).
--
-- Found 2026-11-12 while building platform_storage_usage (journal 2026-11-12):
-- the INSERT policies for two member-written buckets checked only the folder
-- that names the parent row, never folder [1], which by convention is the org:
--
--   cls-submissions   <org_id>/<class_id>/<submission_id>/<file>   checked [3] only
--   vm-images         <org_id>/<conversation_id>/<file>            checked [2] only
--
-- So a student could upload their OWN submission file under ANOTHER org's id.
-- Effects: (a) cls_submissions_storage_read's cls_can_manage(foldername[1]) arm
-- then let that other org's classroom managers read the file (a self-inflicted
-- cross-tenant path); (b) the bytes were charged to that org on /console/overview.
-- vm-images reads by conversation ([2]) only, so there it was (b) alone.
--
-- Fix: each INSERT policy calls one definer helper that keeps the old check AND
-- requires the path's org (and, for submissions, class) to be the parent row's.
-- The helpers include the old permission check on purpose: a bare "does row X
-- live in org Y" function would be an oracle any signed-in user could ask.
--
-- Each id folder must also be written in canonical form (lower-case, hyphenated):
-- the cast would accept `{A1B2...}` or upper case as the same uuid, but
-- platform_storage_usage and the read paths match folders as TEXT, so a
-- non-canonical spelling would drop the file's bytes out of its org's total.
--
-- DELETE policies are deliberately unchanged: pinning them would only make a
-- misfiled object (none exist — the prod verifier counts them) undeletable.
-- There is no UPDATE policy on either bucket, so a file cannot be moved after
-- upload. Staff buckets (cls-materials, cls-exams) already check folder [1];
-- syn-exports is written by the worker only.

create function public.cls_submission_upload_ok(check_org_id uuid, check_class_id uuid, check_submission_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.cls_submission_open(check_submission_id)
    and exists (
      select 1
      from public.cls_submissions s
      where s.id = check_submission_id
        and s.org_id = check_org_id
        and s.class_id = check_class_id
    );
$$;

create function public.vm_image_upload_ok(check_org_id uuid, check_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.vm_can_post(check_conversation_id)
    and exists (
      select 1
      from public.vm_conversations c
      where c.id = check_conversation_id
        and c.org_id = check_org_id
    );
$$;

-- Revoke before grant (docs/03 #27): prod's default privileges grant every new
-- function to anon/authenticated/service_role.
revoke all on function public.cls_submission_upload_ok(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.vm_image_upload_ok(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.cls_submission_upload_ok(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.vm_image_upload_ok(uuid, uuid) to authenticated, service_role;

drop policy cls_submissions_storage_write on storage.objects;
create policy cls_submissions_storage_write on storage.objects
  for insert with check (
    bucket_id = 'cls-submissions'
    and (storage.foldername(name))[1] = ((storage.foldername(name))[1])::uuid::text
    and (storage.foldername(name))[2] = ((storage.foldername(name))[2])::uuid::text
    and (storage.foldername(name))[3] = ((storage.foldername(name))[3])::uuid::text
    and public.cls_submission_upload_ok(
      ((storage.foldername(name))[1])::uuid,
      ((storage.foldername(name))[2])::uuid,
      ((storage.foldername(name))[3])::uuid
    )
  );

drop policy vm_images_write on storage.objects;
create policy vm_images_write on storage.objects
  for insert with check (
    bucket_id = 'vm-images'
    and (storage.foldername(name))[1] = ((storage.foldername(name))[1])::uuid::text
    and (storage.foldername(name))[2] = ((storage.foldername(name))[2])::uuid::text
    and public.vm_image_upload_ok(
      ((storage.foldername(name))[1])::uuid,
      ((storage.foldername(name))[2])::uuid
    )
  );
