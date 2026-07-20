# The User Model — positions, scopes, and entities

**Status: DESIGN (agreed direction, NOT built).** Captured 2026-07-20 from a multi-day
design discussion with the founder (see `founder-feedback.md` bullets from 2026-07-17
through 2026-07-20 for the raw thread). This is the target model for how people, roles,
and permissions work across the whole platform. Nothing in this doc describes shipped
behavior unless explicitly marked **[BUILT]**. When we start building, each slice gets
its own dated decision entry here and the relevant module specs get updated.

Minor tweaks are still expected — the founder has a few remaining questions. Treat the
spine as settled and the details as adjustable.

---

## 1. Why

Today every module hand-rolls its own role system: classroom has org-wide
professor/GA/student grants plus a separate per-class roster, visual messaging has
module-wide roles plus per-conversation roles, the salon has manager/cashier/worker/
customer, and none of them share code or concepts. The founder's direction
(2026-07-20): **"we will be generalizing the concepts so make the code use the same
user code across the software and modules as much as you can."**

The unifying observation: every module's role system is the same four-tier ladder
wearing different costumes, and every "special case" (department chair, course
professor, conversation admin, branch manager) is just a **position pinned to a
scope**. One engine, per-module vocabulary.

## 2. The two layers

### 2.1 Org layer — **[BUILT 2026-07-17]**

`superadmin > owner > admin > member`, a strict rank ladder
(migration `20260717010000_org_role_hierarchy.sql`): a caller may create/change/remove
an org seat only if they **strictly outrank** both its current and target role; nobody
touches their own seat; a last-standing guard prevents orphaning the org.

**Org roles are deliberately independent of module authority** (founder decision,
2026-07-20). The org layer deals only with: organization membership, org data
(name, address, contact), and appointing the top of each module's ladder. An org
member can be a module's top authority; an org owner can be a plain student. The org
role never silently confers standing *inside* a module — with one legacy exception to
unwind (§9: today `is_org_admin()` is embedded in every module's `_can_manage`).

### 2.2 Module layer — the four-tier spine (DESIGN)

Every module gets the same generic ladder; each module only renames the slots:

```
Module Director                 (top of the module; appointed by org owner/admin)
  └─ Coordinator                (global or scoped; appointed by Director)
       └─ Entity Lead           (professor / branch manager / organizer / chat lead)
            └─ Entity positions (operational staff + end users; see §5)
```

- **Module Director** — the module's top authority for this org. Appointed by the org
  owner/admin (and superadmin, implicitly), **and reassignable by them at any time,
  including to themselves** (founder-settled 2026-07-20) — the org layer's permanent
  escape hatch: an org can always reclaim its module. May well *be* the org owner or
  an admin, but doesn't have to be. Bootstrap seed: before any coordinators exist,
  the Director creates the first containers / appoints the first coordinators.
  *(Named "Director" specifically to avoid colliding with org Owner.)*
- **Coordinator** — manages a slice of the module: creates entities, appoints entity
  leads. **Global** (whole module) or **scoped** (a subtree — a department chair is a
  Coordinator scoped to one department). Scoped coordinators are appointed by the
  Director or by a coordinator whose scope strictly contains the new seat's scope —
  so coordinator chains nest to any depth (global → STEM → Math) with no new code,
  see §4.
- **Entity Lead** — runs one entity: professor of a course, manager of a salon
  location, organizer of an event, creator/admin of a conversation, maker of the
  schedule. Appoints the entity's staff and end users (subject to the entity's join
  policy, §6).
- **Entity positions** — everyone else, attached to a specific entity (or globally):
  GA, student, cashier, worker, customer, host, participant, viewer.

## 3. Entities and scopes

**An entity is a container inside a module; a scope is a pointer at any node of the
container tree.** Entities may **nest** (founder-confirmed via the college case):

```
Classroom module (root)
 ├─ CS Department          ← a Coordinator scoped here = "CS dept chair"
 │   ├─ CS101 (course)     ← a Lead scoped here = "professor of CS101"
 │   └─ CS302
 └─ Math Department
     └─ Math101
```

Rules:

- **A grant is (user, position, scope).** Scope = a node in the module's entity tree;
  `null`/root = global (the whole module).
- **Coverage = ancestry.** Authority at node X covers X and everything under it. The
  permission check walks *up* from the thing being touched; if it passes through the
  caller's scope node, allowed. (Professor @ CS Dept can grade in CS101; can't touch
  Math101.)
- **One position name × any pin height.** There is no "global professor role" vs
  "course professor role" — there is `professor`, pinned at a class, a course, a
  department, or the root. Multiple courses = multiple grants (or one grant at their
  common parent if the person genuinely covers the whole subtree).
- **You create children only inside a scope you hold.** Director/global coordinator
  creates departments; a department coordinator creates courses in their department;
  a course lead creates classes in their course. "Entity creation" is not a separate
  power — it's the same scope math.
- **Scopes are inherently module-local.** A scope node belongs to one module's tree,
  so a grant pinned to "CS Dept" cannot leak into visual messaging — there is no VM
  node under it. This answers the founder's "does dept-chair admin power leak into
  other modules?" — no, by construction.
- **Global scope + Lead position ⇒ you can mint your own entity** (founder insight,
  2026-07-20): a globally-scoped chat lead can start a new conversation and lead it; a
  globally-scoped maker could create a new schedule. This one rule absorbs
  "user-created content" across modules.

### 3.1 The single-global-entity pattern (founder decision, 2026-07-20)

Not every module has natural sub-entities. Decision: **modules without a natural
entity get one implicit app-global entity that nobody can create or delete**, and
everything lives under it. This keeps the model uniform and leaves the door open to
real sub-entities later with no conceptual migration.

- Natural entities: classroom → class (future: department → course → class);
  nail-salon → location; speed-dating → event; visual-messaging → conversation
  (created on demand — VM needs no fake global entity, its entities already exist).
- Single global entity: matchmaking, synagogue-schedules (future possibility noted:
  per-schedule-type entities like "Sabbath schedule", but "anyone who wants to see the
  schedule wants to see them all" — so global for now).

## 4. Enforcement — the same engine we already shipped

The module ladder is enforced by **the org-hierarchy engine reused recursively with a
scope dimension added**. The org guard (`org_members_guard_hierarchy`, **[BUILT]**)
already proves the rank half of the pattern. The full module-layer rule (refined
2026-07-20 after the founder's STEM→Math/CS question exposed a gap in the
rank-only version):

> A caller may create/change/remove a seat if they **strictly outrank** the seat's
> current and target position (with the seat's scope inside the caller's own scope),
> **OR** the seat is the caller's **same position with a scope strictly inside the
> caller's scope**. Nobody changes their own seat. A last-standing guard keeps the
> top tier from being orphaned.

The same-position/strict-containment branch is what lets coordinator chains nest:
without it, a STEM coordinator (equal rank to every other coordinator) could never
appoint the Math coordinator below them. Worked examples, all from one rule:

- *Global coordinator appoints STEM + non-STEM coordinators* — same position, their
  scopes strictly inside global. ✓
- *STEM coordinator appoints Math/CS coordinators* — same position, strictly inside
  STEM. ✓
- *STEM and non-STEM delete each other?* No — same rank, sibling scopes (neither
  strictly contains the other).
- *Non-STEM coordinator deletes the CS coordinator?* No — CS lies inside STEM's
  subtree, not non-STEM's; scope containment fails even though the seat is "lower."
- *Two GLOBAL coordinators remove each other?* No — same position, same scope
  (global is not *strictly* inside global): peers. Only the Director removes a
  global coordinator — the same answer the org ladder gives for two equal admins.
- *Can a global coordinator remove themselves by accident?* No — own-seat changes
  are blocked, same as org roles today.

**Nothing is hardcoded per pair** (founder question, 2026-07-20): the guard is one
generic function — find the caller's best grant whose scope covers the seat's scope,
compare rank numbers, tie-break on strict scope containment. Each module supplies
only a small rank table (director=4, coordinator=3, lead=2, entity positions=1).
Adding STEM/Math/CS or any new hierarchy level = inserting tree nodes and grant
rows; the guard is never touched.

*Storage:* one grants table for the platform (extending today's `module_roles`):
add a **`scope_ref`** column (null = global), a **`granted_by`** column (see §7),
and the generic rank lookup, then port the `guard_hierarchy` trigger. Per-module
roster tables (`cls_class_members`, `vm_conversation_members`) are today's ad-hoc
versions of "entity-scoped grants" and eventually fold into the same shape.

### 4.1 Hardening commitments (independent Fable red-team, 2026-07-20)

An adversarial design review before any build. These are **binding spec amendments**
— slice 1 is not "done" unless every slice-1 item below is implemented and tested.

**Slice 1 (grants table + guard) MUST implement:**

1. **Old AND new scope on UPDATE (critical).** The guard checks the caller's
   coverage of BOTH `old.scope_ref` and `new.scope_ref` (and both old/new position),
   on both branches. Otherwise a Math coordinator re-points a `professor @ Math101`
   seat to global and mints module-wide authority — the same re-point bug class the
   org guard review caught on 2026-07-16.
2. **Scope-node tenancy validation (critical).** "Scopes are module-local" must be
   *enforced*, not asserted: the guard verifies the scope node exists and its
   `org_id` + `module_key` equal the grant's, and every coverage walk is confined to
   that one (org, module) tree. Without this, `scope_ref` is a cross-tenant pointer.
3. **FK behavior: never `set null`.** `scope_ref` is `on delete cascade` (grant dies
   with its node) or `restrict` — `set null` would silently promote every scoped
   seat to GLOBAL when its node is deleted. Node ids are never reused; coverage
   joins on id-ancestry, not path-string equality.
4. **Null semantics defined totally.** Global-vs-node comparisons use
   `IS DISTINCT FROM` / an explicit total predicate: null strictly-contains every
   node; no node contains null; null vs null = peers. A naive `<>` re-point pin
   passes NULL (not TRUE) whenever either side is null and misses global↔node
   re-points.
5. **Rank mapping is immutable config**, hardcoded like `org_role_rank()` — never a
   tenant-writable table (else `student=5` inverts the ladder).
6. **RLS write policies specified alongside the trigger** (the org layer has BOTH):
   a permissive "may attempt" policy whose WITH CHECK pins `org_id` to the caller's
   orgs, with the trigger tightening to the rank/containment rule — defense in
   depth, same division of labor as `org_members_write_org_admin`.
7. **Path integrity contract.** The tree's materialized path is trigger-computed
   (client values ignored/pinned — the VM layer-tree lesson), and coverage is a
   prefix match on an indexed path (`text_pattern_ops`), not per-row recursion.
8. **Node re-parenting is a guarded, audited operation**: the mover must hold
   covering scope over BOTH the old and new parent; subtree path rewrite is atomic
   and trigger-owned. Moving a node rewrites every permission answer beneath it —
   it's a privileged act, not a plain UPDATE.
9. **Last-Director-standing covers every losing shape** — delete, demote,
   `user_id` re-point, scope change — counted per (org, module). And it must NOT
   block the org layer's legitimate escape hatch (§2.2 reassignment): Director
   replacement is an atomic swap the guard recognizes.

**Later slices (binding when their slice builds):**

- *Slice 2:* a user may not hold two grants whose scopes overlap in one module where
  one position sits below another they hold (a Lead minting themselves `student` in
  their own class unions two "disjoint" surfaces — roster, peer-review pool,
  capacity); creating a child node grants NO automatic seat above the one that
  authorized the creation.
- *Slice 3 (invite-accept):* `org_members.status` (`pending|active`);
  `is_org_member()` = `status='active'` — a pending invitee sees only their own
  invite row + the org NAME, never org data, and is invisible to every
  membership-gated definer (`sd_side_registered_count`, `sal_worker_has_time_off`,
  `mm_shared_answers`). The hierarchy guard runs against the INVITER at
  invite-creation; accept only flips status (never sets/raises role) and verifies
  `auth.uid()` = the invited user; accept revalidates the invite is still live
  (inviter not since removed/demoted); cancel/resend are guard-governed writes.
- *Slice 4:* `granted_by` is server-stamped and pinned against UPDATE (a forged
  `'system'` marker would hide a self-granted seat in the §7 review queue).
- *Slice 5 (view-as):* see §8 — reads are a distinct privileged definer surface
  (RLS keys on the CALLER's uid, so "see what Smith sees" cannot reuse it), and the
  surface declaration needs column/row-predicate granularity, not table labels
  (reviewer anonymity in `cls_reviews`, `sd_notes` vs `sd_reports`, matchmaking's
  per-row share flag are the test cases).
- *Accepted race (documented):* the guard reads committed state, like the shipped
  org guard — two concurrent demotes of two Directors can race to zero; mitigate
  with a serializing lock on the last-standing count if it ever matters in
  practice.

## 5. Positions under the Lead: operational staff vs end users

Founder-settled (2026-07-20), refining an earlier draft: **GA and student sit at the
same rank under the professor — GA is NOT "above" the student.** The professor may
grade privately without the GA seeing, may only partially use a GA's grade, etc. Same
for host vs participant under an organizer.

The general principle this produced (the most important correction in the design):

> **The management ladder and the visibility ("view-as") graph are two different
> graphs.** Rank answers "who appoints/removes whom." It does NOT imply "who sees
> what." Each position is its own distinct **data surface** (GA: rubrics + items
> assigned to grade; student: their own work + published materials). Positions can be
> peers in rank while having disjoint surfaces, and multiple end-user positions can
> interact *through* the entity lead without seeing each other's views.

So under a Lead there are typically **operational staff** (GA, cashier, worker, host,
moderator) and **end users** (student, customer, participant, viewer) — but this is a
labeling convenience, not a rank claim. The hierarchy stays flat under the Lead
unless a module explicitly declares otherwise. Because both graphs are data-driven,
reordering a module's ladder later (e.g. deciding hosts DO outrank participants) is a
config change, not a rewrite — explicitly a founder goal.

## 6. How positions are acquired (three paths + join policy)

Founder-specified (2026-07-20). A position can be obtained by:

1. **Placement** — a coordinator (or lead, within their entity) assigns it directly.
2. **Invite + accept** — a lead invites; the invitee sees it pending and accepts.
3. **Request + approval** — a would-be participant asks; lead or coordinator approves.

To make paths 2–3 universal, **every entity carries a join policy**:
`invite-only | request-approval | open`. This generalizes the mechanism already
shipped in VM conversations (`settings.joinPolicy`, **[BUILT 2026-07-10]**) to every
entity in every module.

Related standing decision (2026-07-17, not yet built): **org membership itself moves
to invite-accept for all adds** — being added to an org shows as a pending, greyed-out
invite on the dashboard until accepted. (Touches `is_org_member()` = tenancy core ⇒
Opus + full security rhythm when built.)

**Invite-accept hardening (Fable tenancy review, 2026-07-20 — binding for that
slice, on top of the §4.1 slice-3 items):**

- Pending is invisible to **all three** membership predicates — `is_org_member()`,
  `shares_org_with()` (the profiles-read policy!), and `org_caller_rank()` — with an
  RLS test proving a pending invitee reads *nothing* in the org. A naive
  status-column-on-org_members implementation leaks through all three on day zero.
- The dashboard invite card needs the org's **name** pre-acceptance, which
  `orgs_select_member` correctly refuses — that read gets its own narrow definer
  path (name only), never a widened policy.
- **Self-leave carve-out**: the shipped hierarchy guard's "nobody touches their own
  seat" currently makes leaving an org impossible without an admin. Amend: a plain
  `member` may DELETE (never modify) their own seat. An invite you can accept but
  never undo isn't opt-in. This edits a freshly audited trigger ⇒ full #12 rhythm.

## 7. Defaults on joining a module (founder-specified, 2026-07-20)

When someone becomes an org member (or the module is enabled for an existing org),
each module grants a default position so nobody lands in a void:

| Module | Default position on join |
|---|---|
| Classroom | `student` scoped to a **Welcome class** that teaches the module |
| Nail salon | global `customer` (sees locations; own history starts empty) |
| Speed dating | `participant` scoped to a **finished sample event** ("sign up for the next one") |
| Visual messaging | global `member` — can create chats, sees chats they're invited to |
| Matchmaking | **none** — single vs matchmaker is a real-world fact the system can't infer; explicit placement only |
| Synagogue schedules | global `viewer` |

Implementation notes:

- Defaults must fire on **member-join** AND be **backfilled on module-enable** for
  existing members (founder-confirmed).
- **Never-human-touched highlighting** (founder addition, 2026-07-20): every grant
  row records `granted_by`; system-granted defaults carry a system marker and render
  **highlighted in coordinator views** until a human confirms or adjusts the seat
  (which stamps a real `granted_by` and clears the highlight). Doubles as the
  "auto-enrolled, nobody has reviewed them yet" queue — and the column is needed for
  audit anyway, so the feature is nearly free.

## 8. View-as and audit

Any higher position can see and act in the capacities below it, via per-position tabs
(founder UX sketch, 2026-07-20): e.g. a classroom module Director sees tabs
`Director | Coordinator | Professor | GA | Student`; under each tab they either act **as
themselves in that capacity** or pick a specific person below them from a dropdown.
Lower-position duties live once, in that position's view — not re-implemented per
higher tier.

Two distinct modes with different security weight:

1. **"See it as if I held that position"** — the caller's own authority, filtered
   down. No impersonation; safe by construction.
2. **"See what Smith sees"** — impersonation. Bounded by the **role-surface rule**:
   you see the *position's* data surface (the class, the gradebook), never the
   person's **personal layer** (private notes, DMs, their own drafts). And view-as
   edges are **declared per module**, not derived from rank — professor→GA exists;
   GA→student does NOT (peers, disjoint surfaces; see §5).

**How we know what a higher-up should see** (founder question, 2026-07-20): each
module **declares each position's data surface** in the same place it declares its
tier vocabulary, marking which parts are personal-layer. The deciding rule of thumb:
what someone produces **performing the role's duty** (grades entered, bills
processed, rosters, schedules) is role surface — visible to view-as; what they enter
**as themselves** (private notes, DMs, drafts, matchmaking answers) is personal —
never shown upward. A GA's rubric annotations: role surface. The same GA's private
note to self: personal.

**Audit:** v1 = a last-updated-by (`UMember`) column on written rows, stamping the
real actor when acting-as ("admin X acting as Smith"). Known limitation, flagged to
the founder: a single column is overwritten by the next edit (no history) and covers
**writes only**. History upgrade path (founder suggestion: temporal tables — in
Postgres, a trigger-fed append-only history table achieves the same): adds full
who-did-what-when without changing the model.

### 8.1 Hardening commitments (independent Fable red-team, 2026-07-20)

Adversarial design review of view-as, pre-build. **Binding amendments** — slice 5 is
not buildable without these; several change claims made above.

1. **The keystone: view-as never widens RLS — it only narrows presentation.** A
   view-as tab may render only rows the caller's own policies already return. Any
   gap between a declared edge and the caller's RLS reach is a defect in the
   ladder's RLS design, never something view-as bridges. Corollary with teeth:
   **"personal layer" means RLS-unreadable to higher positions** (aggregate/boolean
   definer functions where staff need derived signals — the `mm_shared_answers` /
   `sal_worker_has_time_off` pattern), never merely UI-hidden. A personal-layer
   marking on a table with a permissive staff read policy is a spec violation.
   (Docs/03's own hard rule: UI hiding is convenience, not security.)
2. **Mode 2 ("see what Smith sees") is READ-ONLY — v1 and until a dated decision
   says otherwise.** Identity-pinned insert policies already block honest
   impersonated writes; any write path would be a forgery through staff policies
   (e.g. a fabricated submission with `student_id = Smith`, or a professor-entered
   `source='ga'` grade the real GA can never see or correct), and two-sided
   mechanics make forged writes harm THIRD parties (acting-as-Smith expressing
   interest in Jones can trigger the mutual-match reveal of Jones's one-sided
   secret). No write path may ever insert a row whose identity column names someone
   other than the true actor; "on behalf of" rows carry a separate `on_behalf_of`
   column, never a forged user_id.
3. **Mode 2 v1 is defined as**: the position's page shape, filled with rows ABOUT
   the target that the caller already reads under their own policies — explicitly
   NOT a re-execution of the target's queries (every own-row policy and definer
   keys on `auth.uid()` and would return the CALLER's rows, i.e. a false view).
   Anything needing a `target_user`-parameterized definer function is out of v1 and
   gets its own per-function security review.
4. **A view-as target is a (person, position, scope) grant triple, never a
   person** — the picker lists grants; the rendered surface is that grant's alone
   (Smith-as-GA must not leak Smith's student-hat surface elsewhere). **Edges do
   not compose**: every permitted pair is its own declared edge; chaining through
   an intermediary's edges is banned.
5. **View-as edges are CODE** — declared in the module manifest beside the tier
   vocabulary, immutable at runtime. Per-org tuning may only DISABLE manifest
   edges, never add them (an org-admin-writable edge list in `org_modules.settings`
   would let an org admin mint impersonation the module designers banned).
6. **Every mode-2 session start is logged append-only** (actor, target grant,
   timestamp) **from v1** — reads are the unstamped side, and the session log is a
   security requirement, not the later audit upgrade. Whether targets are notified
   is a per-module product decision; the log's existence is not.
7. **Per-module impersonation ban flag** (`viewAs: none` in the manifest), set from
   day one for **matchmaking and speed-dating end-user positions** — a single's
   match list is derived from intimate data and names third parties; speed-dating
   interest marks are one-sided secrets whose RLS deliberately makes rejection
   indistinguishable from indecision. Mode 1 stays available everywhere.
8. **Mode 1 creates nothing**: it renders the position's page shape with the
   caller's own (possibly empty) data — never auto-creates roster/participant rows
   (synthetic enrollment would contaminate real pools, e.g. the peer-review
   assignment engine). Joining for real is an ordinary, explicit join.
9. **The surface classification is explicit, per table and where needed per state**
   (pre- vs post-deadline submission), decided in each module's security review;
   anything unclassified or matching both halves of the duty-output/entered-as-self
   heuristic **defaults to PERSONAL**. The heuristic above is guidance, not a
   decider — its own flagship cases break it (matchmaking answers are the position's
   entire duty yet personal; a student submission is both authored-by-self and the
   duty's output). Reviewer anonymity (`cls_reviews`), `sd_notes` vs `sd_reports`,
   and matchmaking's per-row share flag are the canonical test cases: the
   declaration needs column/row-predicate granularity, and view-as must honor
   per-row consent/anonymity flags.
10. **Slice-5 dependency, recorded in §11**: view-as presumes each rank has scoped
    RLS read reach over its covered subtree (slice 2's job — after §9's
    `is_org_admin` decoupling, blanket staff policies disappear and without scoped
    replacements every tab would silently become a widening mechanism). And a
    view-as rendering is always the target's surface **intersected with the
    caller's scope** ("what Smith sees, within what I govern" — a CS chair viewing
    professor Smith never sees Smith's Math101 side), labeled as partial in the UI.

## 9. Per-module mapping (the vocabulary table)

Generic tier → concrete names. Roles marked ⊕ exist today as flat `module_roles`
grants; the rest are design targets.

| Generic | Classroom | Nail salon | Speed dating | Visual messaging | Matchmaking | Synagogue | Sample |
|---|---|---|---|---|---|---|---|
| **Entity tree** | dept → course → class (today: class only) | location | event | conversation (on demand) | single global | single global | project |
| **Director/Coordinator** | (new) — dept chair = scoped coordinator | `admin` ⊕ | `admin` ⊕ | `admin` ⊕ + module `moderator` ⊕ | `admin` ⊕ | (new) | `manager` ⊕ |
| **Entity Lead** | `professor` ⊕ (today org-wide; target: scoped) | `manager` ⊕ | `organizer` ⊕ | conversation admin (per-conv role, built) | matchmaker-admin duties | `maker` ⊕ | — |
| **Operational staff** | `ga` ⊕ | `cashier` ⊕, `worker` ⊕ | `host` ⊕ | conv moderator (per-conv, built) | `matchmaker` ⊕ | — | — |
| **End users** | `student` ⊕ | `customer` ⊕ | `participant` ⊕ | conv participant/viewer (built) | `single` ⊕ | `viewer` (implicit today) | `member` ⊕ |
| **Default on join** | student @ Welcome class | global customer | participant @ sample event | global member | none | global viewer | — |

Today's two disconnected mechanisms — org-wide `module_roles` grants and per-entity
roster tables (`cls_class_members`, `vm_conversation_members`) — are both special
cases of (user, position, scope): the former is "scope = global," the latter
"scope = one entity." The target model merges them.

**Legacy to unwind when building:** every module's `_can_manage` currently embeds
`is_org_admin()`, so org owners/admins hold implicit top authority in every module.
Under this model that coupling is removed — the org layer *appoints* the module
Director instead of *being* module staff automatically. Founder-settled 2026-07-20:
enabling a module seeds the org owner as its first module Director, **and org
owners/admins can reassign the Director seat at any time, including to themselves**
— so the org never loses control of its module even after delegating it.

## 10. What this model deliberately does NOT cover

- **Cross-org module switching** (Bob flipping VM between OrgA and OrgB from inside
  the module) — a navigation/UI feature on a different axis; queued separately.
- **Public Square** — a shared opt-in org for network-shaped modules. The model
  *absorbs* it with no special casing (an org where VM's default grant is global
  member), but the Public Square itself is its own product decision.

Both now have a dedicated Fable-tier tenancy review with findings and an approved
implementation shape for the switcher: **[docs/16-network-features-review.md](16-network-features-review.md)**
(2026-07-20 — headline finding: the `profiles_select_shared_org` policy makes any
platform-wide org an email directory and must be scoped before any network org
exists).
- **Cross-module identity** (shared profiles between matchmaking / speed dating /
  redt-it) — standing founder lean is separate pools per module.

## 11. Build sequencing (when we build — not now)

All of this is RLS/trigger territory ⇒ **Opus + full docs/03 #12 rhythm**, sliced:

1. **Grants table generalization** — `scope_ref` on `module_roles` (null = global),
   generic position ranks, port the hierarchy guard. Additive; flat grants keep
   working as global-scoped grants. **[BUILT 2026-07-20 — `20260720010000_module_grants_scope.sql`]**
   New `module_scope_nodes` per-module entity tree (trigger-computed materialized
   path, re-parenting deferred to slice 2 & blocked); `module_roles` gains
   `scope_ref` (FK `on delete cascade`, never `set null`) + `granted_by`; immutable
   `module_position_rank()` (director=4/coordinator=3/lead=2/position=1; every
   shipped role string stays unmapped→rank 0→invisible); the ported
   `module_roles_guard_hierarchy` (two-branch rule, old+new scope on UPDATE,
   unconditional scope-node tenancy validation, total null predicates) +
   `module_roles_guard_last_director` (org escape hatch exempt); additive
   `module_roles_{insert,update,delete}_module_manager` RLS policies;
   `has_module_role()` hardened to `scope_ref is null` so scoped grants never leak
   global authority through legacy scope-blind policies. All 9 §4.1 slice-1 items
   implemented; independent adversarial review = SHIP AS-IS; 28/28 live assertions
   as real users; RLS suite 23/23.
2. **Per-module ladders** — each module declares its tier vocabulary + manage edges;
   classroom first (professor grants GA/student — the already-agreed next piece).
3. **Join policies + invite-accept** — entity-level joinPolicy everywhere; org-level
   invite-accept (touches `is_org_member()` — the most sensitive slice).
4. **Defaults on join** — per-module default grants + backfill on enable.
5. **View-as** — tabs + role-surface boundary + audit stamping. UI-heavy; last.

Each slice independently shippable; module specs get dated decision entries as their
vocabulary gets locked.

## Decisions log

- **2026-07-20 (slice 1 BUILT — module grants generalization, Opus session):**
  `20260720010000_module_grants_scope.sql` ships §11 slice 1 (see the [BUILT]
  note there for the object inventory). Design calls made during the build,
  recorded so slice 2 doesn't re-litigate them:
  - **Composite PK kept unchanged** (`org_id,user_id,module_key,role`); `scope_ref`
    is a NON-key column. Consequence: a user holds at most ONE scope per
    (module, role) for now. This kept the slice purely additive (upsert paths,
    seed, all 7 modules untouched). Multiple scoped grants per (user, role) —
    §3's "multiple courses = multiple grants" — is a slice-2 change (surrogate PK
    + `onConflict` handling), not needed to exercise or harden the guard (the
    STEM/Math/CS cases all use distinct users).
  - **Additive property is load-bearing and verified**, not asserted: the generic
    rank table maps ONLY the four generic tier names; every shipped role string
    (professor/ga/cashier/single/maker/…) stays unmapped → rank 0 → invisible to
    the ladder and to `module_has_manager_grant`, so no existing user gains any
    capability. The guard bypasses exactly today's writers (service role /
    superadmin / org owner-admin), so no existing write path changes. Reviewer
    confirmed by grepping the codebase: no shipped role collides with the tier
    vocabulary.
  - **`is_org_admin` bypass retained** in the module guard (org owner/admin sits
    above every module ladder — the §2.2 escape hatch and today's behavior). This
    IS the legacy coupling §9 will unwind in a later slice; kept deliberately so
    slice 1 stays additive.
  - **Scope-node tenancy validation is UNCONDITIONAL** (before the bypass) — the
    one check even the service role / a superadmin cannot skip, because a
    cross-tenant `scope_ref` pointer is a data-integrity breach, not a permission
    question.
  - **Last-Director guard is latent in slice 1** (no director grants exist yet,
    and the rank rules already forbid a non-admin removing a director) but built
    correct and covering every losing shape for slice 2.
  - **Node management (create/edit) is org-admin-only this slice.** Scope-guarded
    node creation by a scoped coordinator ("create children only inside a scope
    you hold", §3) and node re-parenting (§4.1 item 8) are BOTH deferred to
    slice 2; re-parenting/re-keying is actively blocked by the path trigger.
  - **Slice-2 carry-forward from the review (independent adversarial, SHIP AS-IS):**
    (N1) branch B is currently rank-agnostic — once real roles are mapped, decide
    per module whether a lead/position may appoint the same position at a
    sub-scope, or restrict branch B to management tiers. (N2) the coarse RLS gate
    `module_has_manager_grant` (rank ≥ coordinator) will UNDER-permit Entity Leads
    (rank 2) who §2.2 says appoint their own entity's staff/end-users — fail-safe
    (restrictive) for now, but slice 2 must lower/adjust the gate.
    **Correction (2026-07-20, second review below): N1 is NOT unreachable in
    slice 1** as first recorded — nothing in the SQL prevents an org owner/admin
    from creating a global `director` grant for an ordinary member RIGHT NOW
    (the app's `upsertModuleRole` already supports it), and once one exists,
    that plain member — not an admin — can independently mint further
    director-position grants at sub-scopes via branch B with zero further admin
    involvement, per §2.2's model where Director is meant to be
    admin-appointed only. Bounded (stays inside one org+module; the admin
    escape hatch can always reassign/revoke) but real and open — see the next
    log entry.
- **2026-07-20 (slice 1 re-reviewed on Fable, pre-push — two fixes applied, one open question):**
  A dedicated Fable-tier adversarial pass on the checked-in-but-unpushed
  migration (the earlier build-time review ran on a cheaper model; this is
  the first time the SQL itself got the top-tier review the novel-mechanism
  rule calls for). Verdict: SHIP WITH CHANGES. Two findings verified and
  fixed directly in `20260720010000` (safe, mechanical, no design change):
  - **org_id/module_key immutability was admin-exempt.** The UPDATE pin
    against reassigning a grant to a different org/module only fired inside
    the non-admin branch — an admin of TWO orgs could move a grant's org_id
    between them (not a privilege escalation, since they already control
    both; but a real gap against the migration's own stated intent). Moved
    the pin to run unconditionally, before the admin bypass. No legitimate
    op needs this: the app's upsert can't touch PK columns, and the §2.2
    Director-reassignment escape hatch only ever changes `user_id`.
  - **`module_scope_covers`/`module_scope_strictly_contains` were reachable by
    a fully UNAUTHENTICATED caller.** These take two bare node ids with no
    identity check baked in — unlike every other definer function in this
    codebase (which keys on `auth.uid()`, NULL for `anon`, and so fails
    closed) — and PostgreSQL grants EXECUTE to PUBLIC on every function by
    default at CREATE time, so the original `grant ... to authenticated,
    service_role` line never actually restricted anything (PUBLIC already
    covered `anon`). Fixed with an explicit `revoke ... from public`. **This
    default-PUBLIC-grant behavior is true of every security-definer function
    ever shipped on this platform** — verified via `has_function_privilege`
    against `pg_proc`, `anon` has EXECUTE on all of them. Not an emergency
    (nearly all of them fail closed on `auth.uid() is null`) but a real gap
    between the `grant ... to authenticated` lines' apparent intent and what
    Postgres actually enforces — **flagged, not fixed platform-wide**; a
    dedicated pass revoking PUBLIC explicitly wherever a function doesn't
    already fail closed on identity is a separate, founder-scoped piece of
    work, not bundled into this slice.
  - **Open question, NOT decided by this review (founder's call before
    slice 2):** should branch B require the caller to hold at least
    lead-or-above rank, rather than being rank-agnostic? As found above,
    it currently lets a plain `director`-holder mint sub-scoped directors
    with no further admin involvement — which may be intended flexibility
    (mirrors the STEM→Math coordinator-chain pattern the model explicitly
    wants) or may need restricting once real module vocabularies make
    "Director" mean something more singular per module. Recorded here
    rather than decided unilaterally.
  - Re-verified after both fixes: 21 + 8 = 29 live assertions as real users
    (full guard re-check + both fixes specifically), RLS 23/23, typecheck +
    build clean (cached — no app code touched, only the migration SQL).
- **2026-07-20 (round 3 — three independent Fable red-teams, pre-build):** With
  Fable access expiring, every novel security design got its adversarial review
  BEFORE implementation: (1) the §4 guard/scope model → §4.1 binding hardening
  commitments (headline: old+new scope on UPDATE — the re-point bug class this
  codebase already met once; scope-node tenancy validation; never `set null`;
  null-totality; immutable rank config; RLS-policies-plus-trigger division;
  path-integrity contract; guarded node-moves; last-Director losing-set with the
  org-escape-hatch carve-out). (2) View-as → §8.1 (keystone: view-as never widens
  RLS + personal-layer means RLS-unreadable; mode 2 read-only v1; edges are code;
  grant-triple targets, no chaining; append-only session log from v1; matchmaking +
  speed-dating end-user impersonation banned; mode 1 creates nothing; explicit
  surface classification, default-personal). (3) Network features (Public Square /
  cross-org switching / Redt-It) → [docs/16](16-network-features-review.md)
  (headline: `profiles_select_shared_org` email-directory leak; pending≠member
  across all three predicates; member self-leave carve-out; trust-class principle
  proposed; switcher approved as Sonnet-buildable). Key claims verified against
  live policies before folding. **§4.1/§8.1 are binding spec; docs/16 items are
  founder decisions still open.**
- **2026-07-20 (round 2, same session)** — Founder follow-up questions settled:
  module top tier renamed **Director**; org owners/admins can reassign the Director
  seat anytime, including to themselves; guard rule refined with the
  **same-position/strict-scope-containment** branch (enables STEM→Math coordinator
  chains; peers with sibling or equal scopes can't touch each other; two global
  coordinators are peers — only the Director removes them); nothing hardcoded
  per-pair — one generic guard + per-module rank table; `granted_by` on every grant
  with **never-human-touched highlighting** for system-granted defaults; role-surface
  vs personal-layer declared per module (duty-output = visible, entered-as-self =
  private); temporal/history table accepted as the audit upgrade path.
- **2026-07-20** — Founder + Claude (Fable session): captured the full model above.
  Key founder calls: org roles independent of module authority; four-tier module
  spine (Director → Coordinator → Lead → positions); GA/student are rank-peers with
  distinct data surfaces (manage-ladder ≠ view-as graph); single-global-entity
  pattern for matchmaking/synagogue; per-entity join policy (invite/request/open);
  per-module defaults on join (matchmaking deliberately none); view-as via
  per-position tabs with the role-surface boundary; UMember write-audit as v1.
- **2026-07-17** — Founder: org invite-accept "for all" authorized (not built).
  Org role rank ladder built and shipped (`20260717010000`).
