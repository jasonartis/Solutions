-- User model slice 2a — allow MULTIPLE scoped grants per (user, role) in a
-- module (docs/15 §3 "multiple courses = multiple grants"). Platform-wide,
-- purely structural; no behavior changes for existing (all-global) grants.
--
-- WHY: slice 1 added `scope_ref` as a NON-key column, so the composite PK
-- (org_id, user_id, module_key, role) still allowed only ONE scope per
-- (user, role). That blocks the normal case slice 2 needs — a student enrolled
-- in Math 203 AND Bio 49 is two `student` grants at different scopes. Enrollment
-- becomes scoped grants in slice 2b, so this capability is a prerequisite.
--
-- HOW: replace the composite PK with a surrogate `id`, and move the identity
-- invariant to a UNIQUE index over (org, user, module, role, scope_ref) with
-- NULLS NOT DISTINCT (PG15+; this DB is PG17). NULLS NOT DISTINCT is the crux:
--   * scope_ref IS NULL == global. Treating NULLs as EQUAL means at most ONE
--     global grant per (org, user, module, role) survives — byte-identical to
--     today's composite-PK invariant for every existing (all-global) row.
--   * Two DISTINCT non-null scopes (Math 203, Bio 49) are different index keys,
--     so both are legal — the new capability.
-- The default (NULLS DISTINCT) would wrongly permit duplicate global grants, so
-- NULLS NOT DISTINCT is required, not cosmetic.
--
-- SAFETY / additivity:
--   * No FK anywhere references module_roles' old composite PK (grep-verified),
--     so dropping it breaks no relationship.
--   * The two guard triggers (module_roles_guard_hierarchy /
--     _guard_last_director) and all five RLS policies reference COLUMNS, never
--     the PK, so they are unaffected.
--   * Every existing grant is global (scope_ref null) and unique per
--     (user, role) already, so the new unique index accepts all current data
--     unchanged; the guard still sees the same rows.
--   * App/seed/test upsert paths must now name the conflict target explicitly
--     (`on_conflict=org_id,user_id,module_key,role,scope_ref`) since the implicit
--     target was the composite PK — updated in the same change set.

-- 1. Surrogate key. Backfill each existing row with a fresh uuid.
alter table public.module_roles add column id uuid not null default gen_random_uuid();

-- 2. Swap the primary key: drop the composite, promote id.
--    (Composite PK was declared inline in 20260706120000 → auto-named _pkey.)
alter table public.module_roles drop constraint module_roles_pkey;
alter table public.module_roles add constraint module_roles_pkey primary key (id);

-- 3. The identity invariant, now scope-aware. NULLS NOT DISTINCT so global
--    (null scope) stays one-per-(user,role) while scoped grants are distinct.
create unique index module_roles_identity_uniq
  on public.module_roles (org_id, user_id, module_key, role, scope_ref)
  nulls not distinct;
