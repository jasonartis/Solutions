-- Module 2 exam-grading UI: the cls-exams bucket got a staff/GA READ policy in
-- the classroom migration, but no write/delete — instructor scan uploads would
-- fail. Staff and GAs upload/manage scans (spec: instructor-uploaded, GAs
-- grade); objects live under <org_id>/<class_id>/<exam_id>/...

create policy cls_exams_storage_write on storage.objects
  for insert with check (
    bucket_id = 'cls-exams'
    and (
      public.cls_can_manage(((storage.foldername(name))[1])::uuid)
      or public.cls_is_ga(((storage.foldername(name))[1])::uuid)
    )
  );

create policy cls_exams_storage_delete on storage.objects
  for delete using (
    bucket_id = 'cls-exams'
    and (
      public.cls_can_manage(((storage.foldername(name))[1])::uuid)
      or public.cls_is_ga(((storage.foldername(name))[1])::uuid)
    )
  );
