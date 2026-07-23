-- Fix-forward for a PROD-ONLY gap in 20260720010000 (found during post-migrate
-- verification, 2026-07-22).
--
-- 20260720010000 tried to make the two ancestry-oracle functions
-- (module_scope_covers / module_scope_strictly_contains) unreachable by
-- unauthenticated / ordinary callers with:
--     revoke execute ... from public;
--     grant  execute ... to service_role;
-- That reasoning assumed the ONLY source of anon/authenticated EXECUTE was the
-- CREATE-time default grant to PUBLIC. That is true on the LOCAL stack — after
-- the migration, both functions have ACL {postgres, service_role} and neither
-- anon nor authenticated can execute them.
--
-- It is NOT true on the hosted (prod) stack. Supabase configures
--     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
--       GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
-- so every function CREATEd by the migration role (postgres) is born with
-- DIRECT execute grants to anon and authenticated — not via PUBLIC. `revoke ...
-- from public` does not touch a direct grant, so on prod both oracles remained
-- executable by anon and authenticated (verified live: proacl =
-- {postgres, anon, authenticated, service_role}). The local RLS suite cannot
-- surface this because local's default privileges differ from prod's.
--
-- Practical severity is low (these functions reveal only a boolean ancestry
-- fact about two node UUIDs, and module_scope_nodes UUIDs are only readable by
-- org members, who can already read the materialized paths directly) — but it
-- is exactly the defense-in-depth closure 20260720010000 intended, so close it
-- properly by revoking from the roles that actually hold the grant.
--
-- Safe: both functions are called ONLY internally by
-- module_caller_can_manage_seat (SECURITY DEFINER, owned by postgres, which
-- retains execute), never directly via .rpc() (grep-verified), so removing
-- anon/authenticated breaks no call path. Confirmed by local already running
-- this way with the full guard suite green.
--
-- LESSON for the deferred platform-wide "revoke PUBLIC on definer functions"
-- pass (docs/15, 2026-07-20): on prod the grant to reckon with is a DIRECT
-- anon/authenticated grant from ALTER DEFAULT PRIVILEGES, not the PUBLIC
-- default — that pass must `revoke ... from public, anon, authenticated`, and
-- must be verified against PROD (or a mirror of its default privileges), never
-- only local.

revoke execute on function public.module_scope_covers(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.module_scope_strictly_contains(uuid, uuid) from public, anon, authenticated;

-- Re-assert the intended grant (idempotent; the sole non-owner caller path is
-- the definer function running as postgres, but service_role is kept explicit
-- for symmetry with 20260720010000).
grant execute on function public.module_scope_covers(uuid, uuid) to service_role;
grant execute on function public.module_scope_strictly_contains(uuid, uuid) to service_role;
