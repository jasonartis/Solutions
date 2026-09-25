# Cross-module position model — rank-mapping the last three modules, and the seat/role vocabulary collision

**STATUS: GATHERED BRIEF, NOT APPROVED TO BUILD.** Measured and drafted 2026-09-25 by a
session that started as Fable 5.1 and was reseated to Sonnet 5 mid-conversation (confirmed by
Jason in-chat: Fable unavailable this session). Per the standing model-switch protocol, no
migration/RLS/trigger SQL has been written — this doc is the full "gather" half of
gather-then-switch, so the actual build starts productive the moment the session is manually
switched to **Opus** (the CLAUDE.md baseline tier for this class of work; Fable is the
extra-credit tier on top of that and isn't available right now — see
[[fable-via-subagent-and-model-provenance]] in memory). Nothing here has been reviewed
adversarially or tested. Read [docs/19 §"STILL OPEN" item 1](19-seat-authority-audit.md) and
[docs/15 §4, §9, §11](15-user-model.md) first — this doc builds directly on both.

## 0. Scope

Founder-picked 2026-09-25 (broad option): settle what an audience/mentor seat means in speed
dating, **and** rank-map matchmaking, synagogue-schedules and visual-messaging — which today
sit entirely at rank 0 and are what blocks docs/19's `module_roles` census leak from being
fixed.

## 1. MEASURED, with controls

### 1.1 The rank ladder today — confirmed against the live function body

```sql
CREATE OR REPLACE FUNCTION public.module_position_rank(module_key text, role text)
  ...
   select coalesce(
     case module_key
       when 'classroom' then case role
         when 'professor' then 2  when 'ga' then 1  when 'student' then 1  else null end
       when 'nail-salon' then case role
         when 'admin' then 3  when 'manager' then 2  when 'cashier' then 1  when 'worker' then 1  else null end
       when 'speed-dating' then case role
         when 'admin' then 3  when 'organizer' then 2  when 'host' then 1  else null end
       else null
     end,
     public.module_position_rank(role)  -- generic fallback: director=4/coordinator=3/lead=2/position=1, else 0
   );
```

**matchmaking, synagogue-schedules and visual-messaging have no `case module_key` arm at
all**, so every one of their real role strings (`admin`, `matchmaker`, `single`, `maker`,
`member`, `moderator`) falls through to the generic fallback, which only recognizes the
literal words `director`/`coordinator`/`lead`/`position` — none of which any module actually
grants. **Every real grant in these three modules is rank 0**, confirmed against
[docs/rank-admission-map.md](rank-admission-map.md) (machine-generated from this same live
function, so this is not a second, divergent reading).

**Control:** classroom/nail-salon/speed-dating DO have real case arms and their real staff
roles (professor, manager, organizer, admin) resolve to ranks 1–3 — proving the fallback-to-0
for the other three is an *absence* of a case arm, not the function being broken.

### 1.2 `module_roles.role` has no CHECK constraint — re-verified live

```
module_roles_granted_by_fkey | FK granted_by -> auth.users, ON DELETE SET NULL
module_roles_org_id_fkey     | FK org_id -> orgs, ON DELETE CASCADE
module_roles_pkey            | PRIMARY KEY (id)
module_roles_scope_ref_fkey  | FK scope_ref -> module_scope_nodes, ON DELETE CASCADE
module_roles_user_id_fkey    | FK user_id -> auth.users, ON DELETE CASCADE
```

No CHECK on `role`. `module_position_rank` is the only thing that gives the words meaning —
confirming docs/19's claim rather than just repeating it.

### 1.3 Live `module_roles` grants, by module/role/global-vs-scoped (queried 2026-09-25)

```
classroom            ga          global   1      matchmaking   admin       global   1
classroom             professor  global   1      matchmaking   matchmaker  global   1
classroom             student    scoped   2      matchmaking   single      global   4
nail-salon            admin      global   1      speed-dating  organizer   global   1
nail-salon             cashier   global   1      speed-dating  participant global   4
nail-salon             customer  global   1      synagogue-sch maker       global   1
nail-salon             manager   1 global+1 scoped              visual-msg admin    global   1
                                                                 visual-msg member   global   2
```
(`visual-messaging` has 0 live `moderator` grants.)

### 1.4 THREE MODULES, THREE DIFFERENT SPLITS between "module-wide role" and "entity seat" — two of them reuse the SAME WORDS for both meanings

This generalizes docs/19's speed-dating finding into the actual pattern across the platform,
and finds it is worse in one case than docs/19 knew.

**classroom — the fold is ALREADY SHIPPED (2026-07-24), and is the template.**
`cls_class_members.role` ∈ {`student`, `professor`} live. Per the code comment at
`modules/classroom/ui/manage/actions.ts:33-39`: *"Enrollment is now a SCOPED `module_roles`
grant... The `cls_class_members` row is kept in sync purely as a name/badge store (it no
longer drives authority)."* `enrollClassMember` writes **both** rows in one action: a scoped
`module_roles` grant (`scope_ref` = the class's scope node) *and* the roster row. The roster
can never disagree with authority because it never decides it. **This is exactly the "fold"
docs/15 §4 describes as the intended destination for the docs/19 security class** — already
built, reviewed, and live for one module.

**speed-dating — no fold, and the vocabularies don't even share live data.**
`sd_participants.seat_type` ∈ {`participant`, `audience`, `mentor`} (live CHECK constraint).
**Zero** `module_roles` counterpart. `registerForEvent`
(`modules/speed-dating/ui/actions.ts:124-131`) inserts **only** `sd_participants` — never
touches `module_roles`. The four live `speed-dating`/`participant` `module_roles` rows come
**exclusively** from `packages/db/src/seed.ts`'s direct service-role inserts
(`packages/db/src/seed.ts:973-979`); grepping every non-seed, non-test caller of
`upsertModuleRoles` for `module_key: 'speed-dating'` returns nothing. **So today the
`module_roles` rows that exist for speed-dating are demo decoration, disconnected from the
real registration flow** — a finding docs/19 did not make. This sharpens, not just repeats,
docs/19's item: it isn't only that `seat_type` has no module-role equivalent — the module-role
column that *shares its name* isn't wired to the real write path either.

**visual-messaging — the same disconnection, plus a genuine word collision.**
`vm_conversation_members.role` has a live CHECK constraint allowing **four** values —
`participant`, `viewer`, `moderator`, `admin` — though only the first three have ever been
used (0 live `moderator` rows in the roster table). **`moderator` is *also* a live
module-level `module_roles.role`** (org-wide, gates `vm_can_moderate_org`, and per docs/20 "a
delegated moderator sees everything and it is disclosed"). Confirmed live: `vm_can_moderate`
(per-conversation) and `vm_can_moderate_org` (module-wide) are two separate functions. So the
literal string `moderator` means an unrelated thing depending on which table it's read from —
a worse version of speed-dating's problem, because there the words at least differ
(`seat_type` vs `role`); here the *word itself* collides. `addMember`
(`modules/visual-messaging/ui/actions.ts:191-196`) shows the identical disconnection pattern:
inserts only `vm_conversation_members`, never `module_roles`.

### 1.5 `module_scope_nodes` usage confirms the single-global-entity classification

`classroom`=4, `nail-salon`=2, `speed-dating`=14, **`matchmaking`/`synagogue-schedules`/
`visual-messaging`=0**. Consistent with docs/15 §3.1's founder decision that the latter three
are single-global-entity modules — not merely unmapped, genuinely entity-less today.

### 1.6 The census leak, confirmed at the exact live policy text

```
module_roles_select_member         SELECT  USING (is_org_member(org_id) OR is_superadmin())
module_roles_write_org_admin       ALL     USING/CHECK is_org_admin(org_id)   -- governs SELECT too
module_has_manager_grant(org_id, module_key) =
  is_org_member(org_id) AND EXISTS (... module_position_rank(module_key, role) >= 2 ...)
```

**Correctness point found while grounding docs/19's proposed fix, not previously recorded:**
`module_has_manager_grant` does **not** OR in `is_org_admin`. Every live `_can_manage`-style
function (`mm_can_manage`, `syn_can_write`, `vm_can_manage`) reads
`is_org_admin(...) OR has_module_role(...)` directly — **org admins hold module authority
without ever getting a `module_roles` row** (docs/15 §9's "legacy to unwind" note, confirmed
live). A naive fix that replaces the SELECT/write-FOR-ALL policies with bare
`module_has_manager_grant(...)` would silently strip an org admin's ability to see or manage
the `module_roles` table itself, even though they'd keep domain authority through the
separate `_can_manage` path. **Any fix must read
`is_org_admin(org_id) OR module_has_manager_grant(org_id, module_key)`, not
`module_has_manager_grant` alone.**

### 1.7 Who reads `module_roles` directly today (breakage check for the census-leak fix)

`modules/matchmaking/ui/manage/page.tsx` is the one load-bearing case: it lists `module_roles`
rows for the manage console. Once matchmaking's `admin` reaches rank ≥ 2 (proposed §2), that
caller passes `module_has_manager_grant` and the page keeps working under a narrowed policy.
The other readers (`classroom/ui/manage/actions.ts`, `apps/web/lib/{platform,org-members,
view-as,console-view-as,help-visibility}.ts`, the members/console/stub pages) either already
gate on staff status or read only the caller's own rows.

## 2. PROPOSED — rank-mapping, existing vocabulary only

Same shape as how classroom/nail-salon/speed-dating were mapped: real, already-used role
**names** get a case arm; no new grant mechanism, no new words invented.

| module | role | proposed rank | reasoning |
|---|---|---|---|
| matchmaking | `admin` | **3** | matches nail-salon/speed-dating's `admin` = 3 |
| matchmaking | `matchmaker` | **1 — DECIDED §4.2** | assignee, not a manager |
| matchmaking | `single` | 0 (unchanged) | end user |
| synagogue-schedules | `maker` | **1 — DECIDED §4.3** | org-admin grants makers, no self-administration |
| synagogue-schedules | `viewer` | 0 (unchanged) | implicit, never granted |
| visual-messaging | `admin` | **3** | matches nail-salon/speed-dating's `admin` = 3 |
| visual-messaging | `moderator` (module-level) | **3** | peer tier to admin — org-wide disclosed oversight, docs/20 |
| visual-messaging | `member` | 0 (unchanged) | end user |

**Consequence flagged, not solved here:** rank-mapping any of these three modules **will FAIL
THE BUILD** until every newly-implied view-as pair is explicitly answered (the 2026-07-30
amendment) — matching the treatment nail-salon and speed-dating already went through. That
review is in-scope for the eventual Opus-tier slice, not a separate ask.

## 3. PROPOSED — fold the two disconnected entity rosters into scoped `module_roles` grants

Mirrors the classroom pattern exactly (§1.4): the seat *is* the grant, scoped to the entity's
scope node, and the roster row becomes a synced name/badge store — same division of labor
`enrollClassMember` already uses. Concretely:

- **speed-dating:** `registerForEvent` / the organizer's seat-mint action write **both**
  `sd_participants` (`seat_type` = the chosen value) **and** a scoped `module_roles` grant
  (`role` = the same value, `scope_ref` = the event's scope node). `sd_owns_participant` /
  `sd_in_event` / `sd_paired_with` (docs/19's remediation list) then conjoin **scope-aware
  role coverage**, not a literal `sd_is_participant` check — which is what makes this correct
  for `audience` and `mentor` too, see §4.1.
- **visual-messaging:** `addMember` writes both `vm_conversation_members` and a scoped
  `module_roles` grant at the conversation's scope node (conversations don't have scope
  nodes today — `module_scope_nodes` showed 0 for visual-messaging — so this also means
  minting one scope node per conversation, the same mechanical step classroom already does
  per class).

This is the part of the slice that actually closes docs/19's persistence-after-revocation
hole for these two modules, the same way it is already closed for classroom — not new
mechanism, replication of a shipped, reviewed one.

## 4. Founder decisions, 2026-09-25 — DECIDED, NOT YET BUILT

Answered the same session this brief was written, in-chat, framed as the scenarios below.
Recorded here so they survive the chat being abandoned. **None of these four decisions has
been built** — no migration, no CHECK-constraint change, no RLS. They wait on the Opus switch
like everything else in this doc.

1. **§4.1 — seat = grant, confirmed.** Answer: *"Confirm that this matches how the other
   modules do it, like classroom."* **Confirmed, verified live (§1.4 above), not merely
   asserted:** `enrollClassMember` (`modules/classroom/ui/manage/actions.ts:91-97`) inserts a
   scoped `module_roles` row (`role`, `scope_ref` = the class's scope node) **and** the
   `cls_class_members` roster row in the same action, with the code comment stating the
   roster "no longer drives authority" — the grant is the sole source, the roster is a synced
   name/badge store. The proposed speed-dating/visual-messaging fold (§3) is the identical
   shape: mint both rows together, roster becomes decorative. No divergence to flag.
2. **§4.2 — matchmaking `matchmaker` = rank 1.** Assignee only; does not administer other
   matchmakers; after the census-leak fix (§4.5), reads only her own `module_roles` row.
3. **§4.3 — synagogue-schedules `maker` = rank 1.** Org-admin grants makers; a maker cannot
   self-administer other makers. Matches extract-don't-speculate — one maker exists platform-wide.
4. **§4.4 — visual-messaging's per-conversation `moderator` — RENAME, not just document.**
   Founder: *"Call her a Chat Moderator or a Conversation Moderator."* **Picked
   `conversation_moderator`** (not `chat_moderator`): the module's own vocabulary already says
   "conversation" everywhere (`vm_conversations`, `vm_conversation_members`, the
   `conversationId` route param, docs/15 §9's "conversation admin (per-conv role, built)") and
   never says "chat" anywhere in the schema or code — matching the existing noun keeps one
   vocabulary instead of introducing a second. **Still a migration** (the CHECK constraint's
   allowed value changes from `moderator` to `conversation_moderator`) — low-risk since 0 live
   rows use the old value, but it is schema, so it waits on the Opus switch like the rest of
   this brief. Display label in any future UI: "Conversation Moderator."

## 4b. BUILT 2026-09-25 — the rank-mapping half (`20260925030000`)

**IN THE REPO, NOT ON PRODUCTION.** `migrate:prod` has NOT run. Per the 2026-09-11
correction, nothing here is "SHIPPED" until it has, and until a prod verification passes.

**What landed.** One migration, `20260925030000_rank_map_three_modules.sql`: a single
`create or replace` of `module_position_rank(module_key, role)` adding three `case` arms —
matchmaking (`admin` 3, `matchmaker` 1), synagogue-schedules (`maker` 1), visual-messaging
(`admin` 3, `moderator` 1). Everything else falls through to 0 exactly as before. No table,
column, policy or trigger. Plus the seven view-as pair declarations and six new RLS tests.

**One rank was decided here, not by the founder: visual-messaging `moderator` = 1, not the
3 this doc originally proposed in §2.** Its authority is `vm_can_moderate_org()`, a role-NAME
check that never reads rank, so 3 would have handed a content-moderation role
grants-administration it has never needed. At 1 it stays out of `module_has_manager_grant`
while the admin (3) can still appoint and remove it. It also matches the convention every
already-mapped module follows — operational staff 1, end users 0.

**The measured effect, complete.** Exactly one widening: `module_has_manager_grant` becomes
true for the matchmaking and visual-messaging `admin` roles, so they can administer grants in
their own module without being an org admin — which is what unblocks §4.5. Nothing else
gained anything, and **nothing was narrowed**: every comparison that could have revoked
something was uniformly false beforehand (`0 > 0`), so no rank moved down.

**Verification.** Parse- and behaviour-checked in a rolled-back transaction with controls
before applying. `docs/rank-admission-map.md` regenerated — its diff shows `maker` and
`moderator` correctly ABSENT from `module_has_manager_grant`, which is the founder's decision
and the least-privilege choice visible in machine-generated output rather than prose.
Typecheck 9/9; 257/257 across the six in-scope db suites. The amendment's teeth were proven by
deleting a pair entry and observing `TS2741`, and the new tests' teeth by reverting the
function body and observing 3 of 5 fail.

**WHAT THE TWO ADVERSARIAL REVIEWS CAUGHT — all three findings were real and all are fixed:**

1. **A FIFTH rank consumer the migration header missed: `view_as_guard_session`.** It is
   generic (module_key comes from the inserted row), bound and enabled, and it is the ONLY
   authority gate on `view_as_sessions` (the insert policy checks just
   `actor_user_id = auth.uid() AND is_org_member`). Its rank arm flipped false→true for all
   seven new pairs. **Outcome unchanged** — the edge arm still denies all seven — **but the
   depth changed: two independent conjuncts became one**, and that one denies by the ABSENCE
   of a case arm via `coalesce(..., false)`. So adding an edge arm in future is now
   sufficient on its own to open a session for these modules. Documented in the header, and
   **pinned by a new regression test whose tripwire was proven** by temporarily adding the
   hazardous arm and watching the test fail by name. *Why it was missed: the four-item list
   was read off the rank map's PER-MODULE sections, and a generic gate appears in that file's
   first table instead. Read both tables.*
2. **A false claim in a view-as note:** "a matchmaker's whole reach is
   `mm_matchmaker_assignments`." Refuted against the live policy —
   `mm_questions_select_participant` is `(mm_is_single OR mm_is_matchmaker) AND (status =
   'approved' OR submitted_by = auth.uid())`, with no assignment term. Her reach is SPLIT;
   the note now says so.
3. **A false implication in another:** that a vm moderator sees conversations the admin does
   not, "exactly the kind of absence mode 1 exists to show." The opposite is true —
   `vm_can_moderate_org` is `vm_can_manage(org) OR has_module_role(...,'moderator')`, and
   `vm_can_manage` is a disjunct of it, so **the admin's reach is a strict superset and the
   `moderator` grant confers nothing an admin lacks.** Corrected, with the finding kept
   because it is genuinely surprising.

A fourth item was flagged as vague rather than false (a count cannot prove "never granted"),
and that note now states exactly what was measured: a point-in-time local count, with its
control.

## 5. Scenarios as originally framed (kept for the reasoning, now answered above)

### 5.1 Speed dating's audience/mentor — what grant justifies the seat?

**Scenario, seat = grant (recommended).** Organizer Alice marks Charlie `mentor` for the
March event. This mints an `sd_participants` row (`seat_type='mentor'`) **and**, in the same
action, a scoped `module_roles` grant (`role='mentor'`, `scope_ref` = the March event's node).
If Alice later removes Charlie from the org, **both go inert together** — exactly the
protection classroom's professor/GA/student grants already have. No separate "which role
justifies it" question, because the seat *is* the grant; audience/mentor sit at rank 0, same
as participant, each a distinct data surface per docs/15 §5's own principle (peers in rank,
disjoint surfaces — this is the same relationship GA/student already have under a professor).
This closes the hole docs/19 flagged with no new mechanism.

**Scenario, seat requires an existing role (rejected, recorded so it isn't re-proposed).**
Mentor/audience could instead require the holder to already carry some other speed-dating
role (organizer/host/participant) as a prerequisite. No code today treats mentor as "an
upgraded participant," and it would block the real case of an outside mentor — e.g. a guest
speaker who was never registered as a participant at all. Not recommended.

**Scenario, leave it as-is (status quo, named so the cost is visible).** An organizer can
mint an audience/mentor seat for literally any uuid today, and it never expires with org
membership — that is docs/19's still-live gap. Keeping this is a real option but it is the
one this whole slice exists to close.

### 5.2 Matchmaking's `matchmaker` — assignee or manager?

Proposed rank 1 (below the `>= 2` manager-grant threshold). **Consequence for Mel**, the
seeded matchmaker: she can still see everyone assigned to her via
`mm_matchmaker_assignments`/`mm_matchmaker_can_see` (unaffected either way), but at rank 1 she
**cannot** grant or revoke other matchmakers' seats, and — once the census-leak fix lands
(§5.5) — she does **not** get broad `module_roles` read access to the whole dating pool through
`module_has_manager_grant`, only her own row. That is almost certainly correct: her console
reads assignments, not raw `module_roles`, so she doesn't need the broader grant, and keeping
her at rank 1 is the more privacy-preserving choice — the entire point of this slice. Rank 2
(manager-tier) is the alternative if matchmakers are meant to administer each other; nothing
measured today suggests that's wanted.

### 5.3 Synagogue-schedules' `maker` — operational or manager-tier?

**Scenario A, rank 1.** Only Alice holds `maker` today, added by an org admin. At rank 1 she
cannot grant/revoke other makers herself — only an org admin can. Matches extract-don't-
speculate: nothing today needs self-service maker-granting, and there's exactly one maker on
the whole platform.

**Scenario B, rank 2 (docs/15 §9's original vocabulary table placed `maker` under "Entity
Lead," i.e. this tier).** Alice could add a second maker herself without going through an org
admin. Since synagogue-schedules is single-global-entity, `maker` effectively plays both the
"coordinator" and "entity lead" role at once — there's design precedent for this being 2, but
no live need for it yet.

Recommend A on extract-don't-speculate grounds, flagged as a real choice rather than decided
unilaterally.

### 5.4 Visual-messaging's `moderator` collision — rename, or just document it?

**SUPERSEDED — see §4 item 4. Founder picked rename, not document-only**, and named
`conversation_moderator`. Original scenario kept for the reasoning: given 0 live rows use the
per-conversation `moderator` value, the lowest-risk move would have been to leave the CHECK
constraint as-is and add an explicit comment at both definitions stating the two `moderator`s
are unrelated grants at different scopes. The founder judged the permanent fix worth a
low-risk migration now rather than deferring it — reasonable, since nothing is live to migrate
around.

### 5.5 The census leak fix itself

Proposed: narrow `module_roles_select_member` to
`user_id = auth.uid() OR is_org_admin(org_id) OR module_has_manager_grant(org_id, module_key)
OR is_superadmin()`, and narrow `module_roles_write_org_admin`'s FOR ALL the same way (docs/19
already names this shape; §1.6 above is the correction that keeps `is_org_admin` in the OR).

**Scenario.** Today, ordinary `demo-match` member Dana can query `module_roles` directly and
enumerate the whole dating pool — who else holds `single`. Under the fix: Dana's read narrows
to her own row; admin Alice keeps full read via `is_org_admin`; matchmaker Mel, at the
proposed rank 1, does **not** get broad read (see §5.2) — she sees her own row only, same as
Dana. That is the intended outcome, not a side effect to correct.

## 6. What this brief does NOT decide

- The exact migration shape for the two folds (§3) and the `conversation_moderator` rename
  (§4 item 4) — scope-node creation for conversations, trigger wiring, the RLS policy diffs,
  the CHECK-constraint edit themselves.
- The view-as pair review that rank-mapping these three modules will force open (§2).
- `cls_set_preferred_name`'s remaining half and docs/19 §5's `sd_in_event` status filter
  (unrelated to this slice, still open).

**Status of the three remaining pieces, after the 2026-09-25 Opus session:**

| piece | state |
|---|---|
| Rank-mapping the three modules (§2) | **BUILT, in the repo — §4b.** Not on prod. |
| The `module_roles` census-leak fix (§4.5) | **UNBLOCKED, NOT BUILT.** See below. |
| The roster fold (§3) + `conversation_moderator` rename (§4 item 4) | **NOT BUILT.** Its own slice. |

**The census-leak fix is no longer blocked, but it is not a one-line policy narrowing either,
and the reason is worth recording before someone tries.** Narrowing
`module_roles_select_member` to self-plus-managers breaks the view-as target picker, which
reads `module_roles` through the caller's ordinary RLS client
(`apps/web/lib/view-as.ts:151-156`) to enumerate holders of a position. A rank-1 caller with a
live mode-1 edge needs that read and would fail `module_has_manager_grant` (>= 2) — and
speed-dating's `host` (rank 1) has exactly such an edge into `participant`, ON since the
2026-09-20 founder decision. **The SQL edge mirror cannot rescue it either: it carries mode 2
only**, so a mode-1-only edge is invisible to the database. So the fix needs a deliberate read
path for that picker (an edge-aware definer is the obvious candidate), not just a narrower
policy. Also note §1.6's correction: whatever replaces it must keep `is_org_admin` in the OR,
or org admins who hold no module grant lose the table entirely.

**Next step:** the census-leak slice, at Opus tier, with the picker read path designed first.
