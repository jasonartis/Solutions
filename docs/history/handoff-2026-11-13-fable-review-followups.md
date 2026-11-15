# Handoff — follow-ups from the 2026-11-12 Fable re-review (for Sonnet/Opus chats)

Founder 2026-11-13: "If it's not Fable work then document them to be picked up when another chat
picks up the other models' work." Evidence for every item: [fable-review-2026-11-12.md](fable-review-2026-11-12.md).
One chat per numbered block; paste the prompt as written. Nothing here needs Fable.

## Opus — migrations (each its own chat; `pnpm backup:prod` + dry run + the founder's explicit go-ahead before `migrate:prod`; per-migration prod verifier with before/after)

### O1 — `module_roles`: the grantee must be an active org member (MEDIUM, review #8)
> Read CLAUDE.md, docs/03, docs/history/fable-review-2026-11-12.md §8 and docs/24's 2026-11-12 note. Build ONE
> migration adding a conjunct to `module_roles_guard_hierarchy` step (3): a grant may be written only for a
> `user_id` with an ACTIVE `org_members` row in `new.org_id`; raise `'That person is not an active member of this
> organization'` otherwise. First check `packages/db/src/seed.ts` and every definer that inserts `module_roles`
> (`pending_invite_apply`, `org_accept_invite`, speed-dating seat grants) for inserts that happen BEFORE the seat
> is active — keep the superadmin/service bypass only where that ordering needs it, and say why in the header.
> RLS tests: the reproduced case (vm admin who is not org admin, grantee not a member → refused; the same grantee
> once active → allowed; control: org admin granting a member still works) for all six modules. Add the probe to
> `scripts/prod-verify-module-roles-census.mts`. Claim a migration version with the other sessions first.

### O2 — `activity_rollup`: bound distinct actions per person (MEDIUM, review #6)
> Read docs/17's 2026-11-12 note and docs/history/fable-review-2026-11-12.md §6. ONE migration: in
> `activity_event_guard`, refuse an INSERT whose `action` is not already present in `activity_rollup` for
> (`new.user_id`, `new.org_id`, `new.module_key`) once that rollup holds ≥ 64 distinct actions (the largest real
> vocabulary is 13). Keep founder decision 1 (no vocabulary table). RLS test: 64 distinct actions succeed, the 65th
> new one is refused, a REPEAT of an existing one still succeeds (control). Add an N+1 rolled-back probe to
> `scripts/prod-verify-activity-events.mts` (today it only asserts the regex exists).

### O3 — password change must ask for the current password (open since 2026-11-04)
> `apps/web/app/(app)/account/password-form.tsx` changes the password without the current one. Turn on
> Supabase's "secure password change" (reauthentication) in the project auth settings, add the reauth step to the
> form, e2e it. No migration. Read docs/21 §7.12.1 first so the recovery notice stays identical.

## Sonnet — docs, comments, verifiers, tests (can be ONE chat; no migration)

### S1 — stale "no `.rpc()` on this path" claims (reviews #2, #3)
> Three comments say no code on the console/data-browser path may ever call `.rpc()`, but `requireSuperadmin()`
> and `superadmin_user_emails` do (both self-gating). Restate as an allow-list rule in
> `apps/web/lib/data-browser.ts:4-6`, `packages/platform/src/data-browser.ts:26-30`, `docs/03-adding-a-module.md:548`,
> `apps/web/lib/console-view-as.ts:51-52`, `apps/web/lib/superadmin-log.ts:25`; widen the scan in
> `scripts/verify-console-view-as.mts:330` to include `lib/platform.ts` and `lib/data-browser.ts`.

### S2 — `superadmin-log.ts:91-92` says view-as mode is derivable; the migration header (`20260807010000:159-168`) proves it is not — fix the comment.

### S3 — negative e2e: a non-superadmin gets 404 on `/console/view-as` and `/console/data-browser` (review #3). Sign in as a seeded org admin, assert the 404 page, with a control that the superadmin gets 200.

### S4 — `scripts/prod-verify-superadmin-log.mts`: add a rolled-back behaviour block (forged-actor INSERT as a superadmin → actor overwritten; non-superadmin SELECT → 0 with a control), copying the shape in `prod-verify-feedback.mts`.

### S5 — docs/25: add two residual sentences — §11 the silent per-address cap is a threshold signal ("≥ 20 other inviters hold this address"); §12 the cap is also a TIMING signal (a stored row after an unstored one ≈ the address's invitations were all consumed). docs/22: `find_module_peer` allows unlimited, unlogged guesses against co-members.

### S6 — data browser: a person who has left `org_members` cannot be looked up at all (review #2). Record it in docs/03 #19 next to the walk-in salon gap, as a founder decision pending (subject picker from `profiles`/`auth.users` via the existing superadmin definer vs leave as is).

### S7 — docs/03 rule from review #9: a definer that blanks `request.jwt.claims` inherits the guard's "no JWT = service path" trust; say so and name `pending_invite_apply` as the one that may.

### S8 — Real view-as hardening (docs/13 "FABLE REVIEW" items 2, 3, 7, 8) — ONLY after session `solutions-platform-90` has committed its work; coordinate via `ListAgents`/`SendMessage`.

## Already started, no usage needed — the security review evidence pack
`scripts/security-evidence-run.sh` was launched 2026-11-13 and writes to
`D:\Jason_prompts\sessions\security-evidence-2026-11-13\`. The plan that consumes it, and the insurance brief:
[docs/30-security-review.md](../30-security-review.md) §4 says which model does which step.
