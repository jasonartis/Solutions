-- Nail-salon view-as edges (user model slice 5 follow-on, docs/15 §8.1 point 9).
--
-- WHY A MIGRATION AT ALL. The TypeScript manifest is not a gate. `authenticated`
-- can reach `view_as_sessions` through PostgREST directly, so the ON pairs are
-- mirrored into IMMUTABLE SQL by `module_view_as_edge()` and the table's
-- BEFORE INSERT guard (`view_as_guard_session`, 20260731010000) refuses any
-- target the mirror does not declare. Flipping a boolean in
-- packages/platform/src/view-as-modules.ts without this migration produces a UI
-- that offers a person view the database then refuses — and the RLS suite's
-- parity test over EVERY ordered pair fails, which is the intended behaviour.
--
-- WHAT THIS ADDS — exactly two pairs:
--     nail-salon  admin   -> worker   TRUE
--     nail-salon  manager -> worker   TRUE
--
-- WHY ONLY `worker`, when the surface review turned five staff pairs on. The
-- mirror encodes MODE 2 ("see what Smith sees") specifically, because mode 2 is
-- the only mode that writes anything: starting one inserts a session row, which
-- is what this guard gates. Mode 1 ("see it as if I held that position") creates
-- nothing, writes nothing and reads only through the caller's own RLS-enforced
-- client, so it has no database gate to add and needs none — a mode-1 tab can
-- never return a row the caller's own policies would not already return.
--
-- The review (docs/15, 2026-08-04) turned mode 1 on for all five staff-to-staff
-- pairs but mode 2 on only for the two into `worker`, because `worker` is the
-- ONLY salon position whose RLS narrows per PERSON
-- (`sal_appointments.worker_id = auth.uid()`, own time-off, own-chair
-- customers). `manager` and `cashier` narrow per LOCATION instead — every row
-- either of them reads is readable by every other holder of the same position at
-- the same location — so "see what Smith sees" has no per-person referent there
-- and mode 2 stays off. Full reasoning + the four customer pairs (all OFF, and
-- deliberately re-confirmed rather than inherited) live in the manifest's notes
-- and docs/15's 2026-08-04 entry.
--
-- NOTHING ELSE CHANGES. `module_position_rank('nail-salon', ...)` already
-- carries the salon vocabulary (admin 3 / manager 2 / cashier 1 / worker 1 /
-- customer -> 0 by fallback) from 20260726010000, and
-- `view_as_guard_session()`, the `view_as_sessions` table, its ACL and its three
-- policies are all module-agnostic. This is a one-function migration.

create or replace function public.module_view_as_edge(module_key text, from_role text, to_role text)
returns boolean
language sql
immutable
as $$
  select coalesce(
    case module_key
      when 'classroom' then case from_role
        when 'professor' then case to_role
          when 'ga' then true       -- docs/15 §8: professor -> GA is confirmed
          when 'student' then true  -- resolved ON at build time, 2026-07-30
          else null end
        else null end
      when 'nail-salon' then case from_role
        -- MODE 2 only (see the header). The five staff pairs whose mode 1 is on
        -- but whose mode 2 is off are deliberately absent here and answer false
        -- through the coalesce, exactly as an undeclared pair does: the database
        -- has no reason to distinguish "off because a person view is meaningless
        -- for this position" from "off because nobody declared it". The manifest
        -- note is where that distinction is recorded, and the parity test is
        -- what keeps the two in step.
        when 'admin' then case to_role
          when 'worker' then true   -- surface review 2026-08-04: worker RLS is per-person
          else null end
        when 'manager' then case to_role
          when 'worker' then true   -- ditto; a manager runs the location the worker works at
          else null end
        else null end
      -- speed-dating keeps every pair off: its staff pairs await that module's
      -- own surface review, and every incoming pair to `participant` is off
      -- permanently (§8.1 point 7's end-user ban expressed as pairs).
      else null
    end,
    false  -- fail closed
  );
$$;

-- ACL restated in full rather than relied on. CREATE OR REPLACE does retain the
-- existing privileges, but docs/03 convention #1 exists because prod's
-- ALTER DEFAULT PRIVILEGES makes "what the ACL actually is" differ from what a
-- local run suggests, and the cost of saying it outright is one line.
revoke all privileges on function public.module_view_as_edge(text, text, text) from public, anon;
grant execute on function public.module_view_as_edge(text, text, text) to authenticated, service_role;
