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

## 8. View-as and audit — **[BUILT 2026-07-31, classroom only]**

*(Declarations exist for all 8 modules; edges are ON for classroom alone. See
the 2026-07-31 decisions entry for what was resolved at build time — including
professor→student, which point 11 below left open, and a correction to the
"personal layer" vocabulary. Everything in §8/§8.1 that describes intent still
describes intent; where the build diverged or sharpened it, that entry says so.)*


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
   **Amended, not reversed — see point 11 (2026-07-30).**
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
11. **Amendment (2026-07-30, founder-driven): rank-differential completeness
    check.** Point 5 stays intact — edges are still declared per module, static,
    immutable at runtime, never org-admin-configurable. Added on top: for every
    module, every ordered position pair (A, B) where `rank(A) > rank(B)` must
    carry an explicit on/off entry in the manifest's edge declaration; an
    undeclared pair is a **build/CI-time error, not a silent default** (a
    TypeScript mapped type keyed by every rank-differential pair is one plausible
    enforcement mechanism, not yet committed to). This resolves a real tension
    `module_position_rank()`'s own design creates: rank is deliberately cheap to
    change ("a one-line migration with no backfill," §11 build sequencing item 1),
    while view-as is deliberately meant to require scrutiny every time (points 2,
    6 above). Without this check, a rank remap that introduces a new
    rank-differential pair — a new position added, or two previously-equal
    positions diverging — could silently open or close view-as reach with nobody
    consciously deciding. With it, that same remap fails the build until every
    newly-implied pair is explicitly resolved; friction lands exactly where a new
    visibility question genuinely exists, nowhere else. Equal-rank pairs (GA and
    student, e.g.) never require an entry at all — no edge, no decision needed,
    matching their existing exclusion for free. Subsumes point 7's per-position
    `viewAs: none` ban as a special case (every incoming pair explicitly off); a
    blanket shorthand flag for that case is reasonable sugar, not a separate
    mechanism. Leaves professor→student an explicitly OPEN, undecided pair as of
    this writing (only implied by the general tab sketch in §8, never confirmed
    the way professor→GA and GA-vs-student were) — this check guarantees it gets
    a real, conscious answer the moment slice 5 is actually built, rather than
    being silently assumed either way. Full reasoning + two rejected alternatives
    (rank-derived *default* edges; a dedicated RLS-bypassing read-path for
    item-level exclusion) in the Decisions log, 2026-07-30.

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
   **[org-level invite-accept BUILT 2026-07-27 — `20260727010000_org_invite_accept.sql`
   — and LIVE ON PROD 2026-07-28 (backup → `migrate:prod` → full read-only prod
   verification via the new `scripts/prod-verify-migration.ts`: 23/23 function bodies
   byte-identical + secdef + pinned search_path, the 3 new rpcs anon-denied on prod,
   active-gating live on the 4 org predicates + all 14 module capability predicates,
   28/28 `org_members` rows backfilled `active` (0 pending, cross-checked against the
   pre-migration backup), and a ROLLED-BACK live prod transaction proving
   pending-invisibility → `org_accept_invite` → active admin);
   entity-level joinPolicy still deferred to a follow-on pass.]** `org_members` gains
   `status ('pending'|'active')` (existing rows backfilled active; future default `pending`,
   fail-closed); `is_org_member` + its three siblings (`shares_org_with`, `org_caller_rank`,
   `is_org_admin`) + **every** module capability predicate that reads `module_roles`
   (`has_module_role`, the two generics, and the coarse/shared readers the scope migrations
   left inline: `module_caller_can_manage_seat`, `module_has_manager_grant`, `cls_can_manage`,
   `cls_is_ga`, `cls_is_class_member`, `sal_can_manage/operate/is_worker`,
   `sd_can_organize/staff_event`) + `syn_can_write` all now require `status='active'` — this
   finally delivers the "a module_roles grant implies (active) org membership" invariant.
   Guard rewrite: authenticated INSERTs forced to `pending` + inviter server-stamped, a
   self-accept carve-out (reachable only via the `org_accept_invite` definer — no self-UPDATE
   policy exists), a self-decline/leave carve-out (member/pending own seat), a consent block on
   admin force-activation; last-admin guard counts active-only. New definers
   `org_accept_invite` (revalidates the inviter) + `org_my_pending_invites` (name-only card);
   `org_members_select_self`/`_delete_self` policies. Dashboard invite cards + accept/decline/
   leave; members-panel pending badge. **Founder decision 2026-07-27: the superadmin (platform
   owner) may CHOOSE per-add — immediately-active vs pending invite — with a saved per-profile
   default (`profiles.settings.superadminDefaultAddActive`); org admins can only ever invite.**
   Two independent adversarial reviews (one caught the coarse-reader leak, fixed); RLS suite
   50/50 + e2e invite→accept.
4. **Defaults on join** — per-module default grants + backfill on enable.
5. **View-as** — tabs + role-surface boundary + audit stamping. UI-heavy; last.
   **[BUILT 2026-07-31 — `20260731010000_view_as_sessions.sql` + the declaration
   layer in `packages/platform/src/view-as{,-modules}.ts` + the generic renderer in
   `apps/web/{lib/view-as.ts,components/view-as/}`.]** Declarations are
   **platform-wide** (all 8 modules — the completeness check is only a check if no
   module can opt out); **edges are ON for classroom only**, because §8.1 point 9
   makes a position's surface classification a per-module security review and
   classroom is the module that had one. Both classroom pairs answered:
   professor→GA ON (already settled in §8) and **professor→student ON**, the pair
   point 11 left open. Nail-salon (9 pairs) and speed-dating (6) are enumerated and
   explicitly OFF with reasons; the other five vocabularies are entirely rank 0 in
   SQL so they imply no pairs at all — and rank-mapping any of them will break the
   build until every newly-implied pair is answered, which is the amendment working.
   No new database read path (§8.1 point 1): one append-only session-log table, its
   guard, and the SQL edge mirror. Two independent Fable reviews; RLS suite 77/77,
   2 e2e, 21/21 live probes as real users.

Each slice independently shippable; module specs get dated decision entries as their
vocabulary gets locked.

## Decisions log

- **2026-07-31 (SLICE 5 — VIEW-AS BUILT, Opus session; the four open items
  resolved):** `20260731010000_view_as_sessions.sql` plus a declaration layer,
  a generic renderer, and a completeness check. The spec deliberately left four
  things to whoever built this; here is what each was decided to be and why.

  **1. Starting scope — declarations platform-wide, edges ON for classroom
  only.** The completeness check is only a check if no module can opt out, so
  all 8 modules declare. But §8.1 point 9 says a position's surface
  classification is "decided in each module's security review", which makes
  turning an edge on a per-module act: **an edge may only be ON in a module that
  has HAD that review.** Classroom got one (§11 sequencing puts it first, §8's
  own tab sketch is classroom, it holds the pair point 11 left open, and it is
  the only module with real SCOPED grants in the seed, so scope intersection is
  actually exercisable). Nail-salon and speed-dating have their pairs
  enumerated and OFF with per-pair reasons, so turning one on later is flipping
  booleans and writing a surface, never inventing a mechanism.

  **2. Per-module role-surface vs personal-layer declarations — and a
  correction to the vocabulary.** Written for classroom (see
  docs/modules/module-2-classroom.md for the table-by-table reasoning). Building
  it surfaced a real problem with a single "personal" label: point 1 defines
  personal as **RLS-unreadable** to higher positions and calls a personal
  marking on a staff-readable table a spec violation — but classroom has no
  `sd_notes` analogue at all, and a professor reads every `cls_*` table inside
  their scope. Calling survey answers "personal" would therefore have been
  precisely the violation point 1 warns about. So the declaration carries **two
  distinct lists**: `personal` (asserted RLS-unreadable, test-enforced) and
  `excluded` (off the surface by product decision over data the viewer reads
  ambiently anyway, also test-enforced — in the opposite direction). Classroom's
  `personal` list is **empty**, and that emptiness is the finding, not an
  oversight. Keeping the two apart is what stops a genuine RLS gap from hiding
  behind an "it's hidden" label.

  **3. Every rank-differential pair, explicitly — including professor→student,
  which is now ANSWERED: ON, both modes.** Rationale in full in the module spec.
  Short version: a student's surface is almost entirely the professor's own duty
  output reflected back, "what does my student actually see?" is the support
  question the Student tab exists for, and nothing widens — every declared table
  is already professor-readable in scope. The sensitive parts are handled by
  narrowing the surface rather than closing the pair: survey answers and review
  comments excluded, `submission_id` omitted from review assignments so the
  reviewer→reviewee direction cannot be walked, grades filtered to
  `is_final AND visible` (the student's own RLS arm), and retention hiding
  reproduced because the professor is exempt from it. **Flagged for founder
  confirmation** — the spec asked for a conscious answer, this is it, and
  reversing it is a one-line change in two places.

  **4. Enforcement — a TypeScript mapped type AND a SQL parity test, because
  the type alone does not deliver the guarantee.** `ViewAsEdges<positions>` is a
  mapped type keyed by every rank-differential pair, so a missing pair is a
  `pnpm typecheck` failure and CI already runs typecheck; an equal-rank or
  upward pair is an excess-property error; `mode2` without `mode1` is not
  representable. Both negative cases were proven to bite, including the
  amendment's own scenario (remapping `student` from 1 to 0 makes `ga → student`
  newly rank-differential and fails the build). **But the mapped type keys on
  the TypeScript rank table while the authoritative rank lives in SQL's
  `module_position_rank()`** — a SQL-only remap, exactly the "one-line
  migration, no backfill" the amendment was written to catch, would sail past
  it. The RLS suite's rank-parity test against the live database is what
  actually closes that, and it should never be treated as optional. No separate
  build script was needed: CI already runs `pnpm typecheck` and the db suite.

  **Architecture: no new database read path, and the migration is small because
  of it.** Everything renders through the CALLER's ordinary RLS-enforced client;
  the surface declaration is a column ALLOW-LIST, so a table nobody declared
  cannot appear and point 9's "anything unclassified defaults to PERSONAL"
  becomes structural rather than a rule to remember. The 2026-07-30 entry's
  rejection of an RLS-bypassing read path is what keeps it that way.
  **One correction to that rejection's premise, found by building it:** it
  argued no planned module has an allowed edge where the viewer's ambient access
  exceeds the intended surface. Turning professor→student on creates exactly
  two such cases (survey answers, review-comment authorship). The *decision*
  still stands — the allow-list excludes them, and a definer would remove RLS as
  the backstop for no gain — but the premise is now falsified, so future
  reasoning should not lean on it.

  **Both gates, for edges too (docs/03 #17).** The first adversarial review
  caught that the manifest's ON/OFF table had **no enforcement at the one thing
  already live**: `authenticated` can insert into `view_as_sessions` straight
  through PostgREST, and the guard only checked rank + scope. A speed-dating
  organizer could therefore have minted a session row naming a participant — a
  pair banned permanently by point 7. Fixed by mirroring the ON pairs into
  IMMUTABLE SQL (`module_view_as_edge()`, same shape as `module_position_rank`)
  and requiring **one single grant** to satisfy rank, scope coverage and the
  declared edge together, so a caller with two grants cannot borrow the rank of
  one and the edge of the other. A parity test asserts SQL and TypeScript agree
  on every ordered pair, OFF ones included. The same review also caught FKs
  written `on delete cascade` (an org admin tidying a course node would have
  silently erased view-as history — now `set null`, matching `vm_moderation_log`)
  and a missing explicit `revoke all` (prod's `ALTER DEFAULT PRIVILEGES` would
  otherwise have handed `authenticated` TRUNCATE on the audit log, and RLS does
  not gate TRUNCATE).

  **Founder correction, 2026-08-02 — professor→student CONFIRMED, and the anonymity
  boundary was in the wrong place.** The pair is confirmed ON. But the first draft excluded
  `cls_review_comments` and dropped `submission_id` from `cls_review_assignments` on the
  reasoning that showing a reviewer's identity would break peer-review anonymity. Founder:
  anonymity runs from other STUDENTS and from the GA — **never from the professor**, who runs
  the process. Both are now on the student surface in full, carrying caveats saying they show
  deliberately MORE than the student sees (the student's own path strips the author via
  `cls_comments_for_my_submission`). The mistake was about WHO the anonymity protects
  against, not about the mechanism, which is worth remembering because it is easy to repeat
  per module. **A follow-up question was raised and answered the same day:**
  `cls_review_comments_select` carries a `cls_is_ga_class` arm while
  `cls_review_assignments_select` has never had one, so a GA reads comment text and
  authorship but no peer marks. Founder: **intended.** "Anonymous from the GA" means
  anonymous in the GRADING sense — the GA sees the substance, not the scores. No change;
  recorded in docs/modules/module-2-classroom.md so nobody "fixes" it later.

  **Adversarial review 2 (Fable) caught a regression created by review 1's own fix, plus
  three classification/coverage defects.** (1) **The append-only trigger and the
  `on delete set null` FKs were incompatible** — Postgres implements `SET NULL` as a real
  UPDATE on the referencing table, so the `before update or delete` guard fired on the FK
  action and aborted the parent DELETE. Once any scope node or user had been named in a
  session it became permanently undeletable, and `org_id`'s cascade did the same for whole
  orgs. The trigger did not make the log outlive what it describes; it made what it
  describes undeletable. Removed: append-only is now grants-only, exactly as
  `vm_moderation_log` has always done it. Reusable lesson in CLAUDE.md's gotchas and
  docs/03 #18. (2) **The live probe meant to validate review 1's FK fix was vacuous** —
  its cleanup delete was silently failing (for the reason above) and `supabase-js` does not
  throw, so "the log survived the delete" passed because the delete never happened. It now
  asserts the delete SUCCEEDS, that the node is really gone, and that the rows survived.
  (3) **A misclassification the two-list model allowed**: classroom's GA surface listed
  `cls_review_assignments` and `cls_survey_answers` as `excluded` when in fact no GA can
  read either. "Excluded" and "the position has no read path" are different claims about
  different readers, so there is now a third list, `unreadableByPosition`, asserted against
  a real position-holder. (4) **The excluded-is-readable test only looped `student`**,
  skipping `ga` — which is precisely where the misclassification sat. It now loops every
  surface of every module. Also fixed: a `scopeColumn: null` role table would have skipped
  scope intersection entirely (§8.1 point 10) and is now a completeness-check error; the
  app-layer pre-check could satisfy edge/rank/scope from three *different* grants where the
  SQL guard requires one; and `scopeCovers` now checks node existence before its identity
  shortcut. Independently of the review, a self-review found **mode 1 was not filtering by
  subject at all** — it rendered every row in scope under a lower position's label instead
  of the caller's own data (§8.1 point 8). Not a widening (the professor reads those rows
  anyway) but the wrong mechanism, and it would have become a real widening in the first
  module whose viewer has narrower ambient reach.

  **The session log IS the session.** Its row id lives in an HttpOnly cookie and
  every impersonated render requires it, so point 6's "every mode-2 session
  start is logged" is structural, not a call the app is trusted to remember.
  Sessions end by EXPIRY, never by an UPDATE, which is what lets the table stay
  genuinely append-only. Authorisation is re-resolved on every render, so
  revoked authority takes effect immediately.

  **Point 7's `viewAs: none` is gone as a separate mechanism**, subsumed by
  point 11 exactly as the amendment predicted: speed-dating's ban is now three
  explicit `participant`-target pairs set OFF with the reason attached.

  **FOUNDER RULE, 2026-08-02 (confirming the build's deliberate departure):
  "Org position does not enable view-as, but module position does."** The
  session guard therefore has **no `is_org_admin` short-circuit**, unlike every
  other module gate on the platform (docs/03 #9), which all begin
  `is_org_admin(org) OR ...`. Org MEMBERSHIP stays a precondition; org RANK —
  owner, admin, superadmin — confers nothing. This is the direction §2.2 and §9
  already set, where that coupling is named as legacy to unwind; a new
  impersonation surface should not add a fresh instance of it. The rule adds
  DELIBERATION, not prevention: the module_roles guard exempts org admins
  (`20260720010000:399`), so an owner may grant themselves the seat freely — it
  simply becomes an explicit, recorded act rather than an ambient power.
  Two consequences worth knowing: the **platform superadmin is included** (no
  module role, no tabs — grant yourself one when testing), and **reading the
  session log stays open to org admins**, since overseeing impersonation inside
  your own org is auditing rather than view-as.

  **Verification:** RLS suite **77/77** (was 57; +20 for this slice), 2 new e2e
  tests as real users through the browser, and **21/21 live probes**
  (`scripts/verify-view-as.mts`) covering the banned-pair refusal, the edge
  mirror's fail-closed default on 9 pairs, mode-2 being unreachable without the
  cookie, the log actually recording, cross-course scope refusal, and the audit
  log surviving deletion of the scope nodes it references. Two independent
  Fable-tier adversarial reviews. Test floor raised to e2e 29 / rls 76.

  **Not done, deliberately:** nail-salon and speed-dating surface reviews (their
  pairs are enumerated and off); notifying view-as targets (point 6 leaves it a
  per-module product decision); the temporal-table audit-history upgrade (§8);
  and any mode-2 write path, which point 2 bans until a dated decision says
  otherwise.

- **2026-07-30 (VIEW-AS DESIGN REVISION — rank-differential completeness check,
  founder-driven, Sonnet session; SPEC ONLY, NOT BUILT):** Founder pushed back on
  §8.1 point 5 ("edges are code, not derived from rank"), asking why hierarchy
  changes couldn't drive view-as automatically. Working through it live surfaced a
  real error in the original defense: GA/student's peer-rank exclusion had been
  cited as proof rank-derivation breaks, but a plain `rank(A) > rank(B)` comparison
  actually reproduces it for free (equal rank ⇒ no edge, no exception needed) —
  checked against every edge discussed (professor→GA, the Director full-depth tab
  sketch) with zero exceptions beyond speed-dating/matchmaking's already-existing
  `viewAs: none` end-user ban. That same exercise surfaced a genuine,
  previously-unnoticed GAP: professor→student was never actually confirmed as a
  declared edge, only implied by §8's general "higher position sees tabs for
  everything below" sketch — the first concrete case of the kind of ambiguity a
  hand-declared-only approach can quietly leave open. Two fixes were explored and
  **rejected** before landing on the one that shipped to spec: (1) rank-derived
  *default* edges (auto-on unless explicitly turned off) — rejected because
  `module_position_rank()` is deliberately cheap to change (a one-line migration,
  no backfill) while view-as is deliberately meant to require scrutiny every time;
  defaulting on would let a routine rank remap silently widen who can read whose
  data, with nobody consciously deciding. (2) A dedicated, RLS-bypassing read-path
  per view-as surface, to make excluding an already-ambiently-visible item (e.g.
  hiding `sd_interest` from an organizer's view of a participant, despite the
  organizer's own policy already covering it) uniformly easy regardless of the
  viewer's separate ambient access — rejected per extract-don't-speculate: no
  currently-planned module actually has an allowed edge where the viewer's ambient
  access exceeds the intended surface (speed-dating's one candidate case is
  already fully closed by the coarse ban), and a SECURITY DEFINER read-path would
  remove RLS as a backstop against a bad surface declaration for no demonstrated
  need. **What shipped to spec instead (§8.1 point 11):** an exhaustiveness
  requirement, not a default — every module-internal position pair with a rank
  gap must carry an explicit on/off entry, or the build/CI fails. Keeps point 5
  intact (edges stay declared, static, immutable at runtime) while guaranteeing a
  rank remap can never silently change view-as reach: a newly-implied pair blocks
  the build until a human resolves it, and the friction only appears exactly when
  a new question genuinely exists. Equal-rank pairs never require an entry,
  matching the existing GA/student exclusion for free. Subsumes the per-position
  `viewAs: none` ban as a special case. Leaves professor→student explicitly open
  — not decided here, but now guaranteed to force a real answer the moment slice 5
  is actually built, rather than being silently assumed either way. **Not built —
  spec-only revision**, for whoever picks up slice 5 (still last in build
  sequencing, §11, still founder-initiated only per the standing rule).
- **2026-07-29 (ACL HARDENING SWEEP — the deferred grant-layer pass, Opus session):**
  `20260728010000_acl_hardening.sql` closes the GRANT layer platform-wide so RLS stops
  being the only gate. Quantified off prod's `pg_catalog` first, which found the scope
  larger than the docs implied: **134 of 139** public functions were anon- AND
  PUBLIC-executable on *both* local and prod (not just slice 3's 20 of 23), and all **67**
  tables granted `anon` the FULL set `arwdDxtm` on prod. End state: `anon` holds nothing in
  `public` but schema `USAGE` + EXECUTE on the two `syn_public_*` functions; the 54 trigger
  functions hold no api-role EXECUTE; `authenticated` keeps EXECUTE on all 81 other
  non-trigger functions and its per-table DML exactly as the creating migrations granted it.
  - **Two findings that changed the job.** (1) `anon` AND `authenticated` held `TRUNCATE`
    on all 67 tables on **both** environments — and **RLS does not gate TRUNCATE**, so this
    was the one item RLS could never have covered (unreachable today only because PostgREST
    emits no TRUNCATE verb; the API surface was the mitigation, not the database).
    (2) Prod also granted `anon` **SELECT** on all 67 tables, a larger surface than the
    INSERT/UPDATE/DELETE the task started from.
  - **Mechanisms established empirically rather than cited** (each one changed the SQL):
    trigger-function EXECUTE is checked at `create trigger` time, not fire time (tested as
    `authenticated`, `service_role`, and — the catastrophic case — `supabase_auth_admin`,
    where **signup still created its profile row with the grant fully revoked**); functions
    named in an RLS policy DO require EXECUTE for the querying role; a table-level
    `revoke all` **also wipes column-level grants**, which would have broken `profiles`
    display-name/settings editing had it not been restored explicitly.
  - **Founder decisions (2026-07-29):** strangers **never write** — there is no sanctioned
    anon write path anywhere, so a public surface is always a read-only definer function
    (static pages like about/contact-by-email need no grant at all); a platform-level
    public-page option is kept as a first-class concept alongside per-module ones;
    `service_role` keeps its grants (it bypasses RLS by design and isn't internet-reachable);
    prod verification must include a real rolled-back `anon` probe, not just a catalog read.
  - **Deliberate deferrals, each to be revisited (founder-approved 2026-07-29):**
    1. **`storage` schema grants** — prod grants `anon` the full set on `storage` tables too.
       All 5 buckets are private and the 13 `storage.objects` policies key on `auth.uid()`,
       and the sweep's `... in schema public` statements do not touch it. Separate job,
       riskier because the Storage service's own role depends on those grants.
    2. **Prod's `ALTER DEFAULT PRIVILEGES`** still re-opens every FUTURE object, so this
       sweep decays without a guard. Deliberately NOT combined with a 200-object privilege
       change. Supabase removes the legacy auto-expose behavior on **2026-10-30** (see the
       `auto_expose_new_tables` note in `supabase/config.toml`), so the durable fix is
       likely a project-config change rather than SQL. **Needs a drift check in the
       meantime** — and note a local-only check structurally cannot catch prod drift.
    3. **~9 internal-only helpers** (`org_role_rank`, `org_caller_rank`, `module_caller_*`,
       both `module_position_rank` overloads, `vm_can_moderate_org`, `vm_layer_locked`) keep
       `authenticated` EXECUTE they don't strictly need — they're called only from inside
       definer functions. Skipped as real behavior-change risk for no security gain.
    4. **3 provably dead functions** (`sal_owns_appointment`, `cls_set_preferred_name`,
       `cls_comments_for_my_submission` — no policy, no trigger, no `.rpc()` caller) were
       locked down rather than dropped; dropping is one-way and needs explicit approval.
       Revisit as cleanup.
    5. **`service_role` retains `TRUNCATE`** on all 67 tables (untouched by design).
       Defensible — it bypasses RLS anyway and lives only in the worker — but worth a look.
  - **Tooling added:** `scripts/acl-audit.ts` (read-only privilege reporter, `--json` for
    before/after diffing — the existing `prod-verify-migration.ts` parses
    `create function` blocks and so verifies *nothing* on an ACL-only migration) and
    `scripts/verify-acl-hardening.ts` (asserts the intended end state, exits non-zero,
    `--probe` runs a live rolled-back `anon` probe). Conventions in docs/03 **#17**;
    never-do entries in docs/12.
  - **Test blind spot closed:** `packages/db/src/rls.test.ts` had a single `signIn()`
    factory and had therefore **never tested the `anon` role** — meaning the table half of
    this change was both a local no-op and unverifiable, the same structural gap behind the
    2026-07-22 incident. Added an `anon` block that asserts both the semantic invariant
    (a stranger obtains/changes nothing) and the mechanism (refused at the privilege layer
    with `42501`, not merely filtered by RLS — so it cannot pass for the wrong reason).

- **2026-07-28 (slice 3 PUSHED TO PROD + prod-verified; a reusable prod-verifier; two
  prod-only ACL findings, Opus session):** `20260727010000_org_invite_accept.sql` is now
  **LIVE ON PROD** (commit `29c572d`). Backup first (`backups/2026-07-28T17-30-20/` —
  schema ~339KB + data ~1.7MB, exit 0); `scripts/prod-migrate.ts --dry-run` confirmed
  exactly ONE pending migration; `pnpm migrate:prod` applied it. (The CLI's non-fatal
  `failed to cache migrations catalog: ... pgdelta-target-ca.crt ENOENT` is its own
  pg-delta catalog-CACHE step tripping on a local cert path — the migration applied and is
  recorded in `supabase_migrations.schema_migrations`.)
  - **New tooling, generalizing the 2026-07-22 lesson into a repeatable check:**
    `scripts/prod-verify-migration.ts` — a generic **read-only** verifier. Given a
    migration path it parses every `create [or replace] function public.*` and its
    dollar-quoted body out of the SQL, then compares each against PROD's `pg_proc`: body
    **md5** (byte-identical?), `prosecdef`, pinned `search_path`, and the REAL `EXECUTE`
    ACL (resolving PUBLIC + per-role grants, flagging `anon`); it also asserts the version
    row exists in `supabase_migrations`. Reason: function EXECUTE grants **diverge local
    vs prod** and the local RLS suite structurally cannot catch it (docs/03 convention #1).
    `VERIFY_DB_URL` dry-runs it against local first. `scripts/prod-migrate.ts` now forwards
    extra args to `supabase db push` so `--dry-run` works.
  - **Verification results (all green).** 23/23 function definitions byte-identical to
    prod's `pg_proc.prosrc`, every one SECURITY DEFINER with `search_path=public`. The
    three NEW rpcs (`org_accept_invite`, `org_my_pending_invites`, `org_member_profiles`)
    show `postgres=X | service_role=X | authenticated=X` on prod — **no PUBLIC, no anon**
    (anon EXECUTE false), so the migration's explicit `revoke ... from public, anon,
    authenticated` + `grant ... to authenticated` **did** defuse the divergence trap on
    prod. (Prod's `ALTER DEFAULT PRIVILEGES` additionally granted `service_role` EXECUTE
    where local didn't — harmless; service_role is the trusted worker role and bypasses
    RLS anyway.) Active-gating live: `is_org_member`, `shares_org_with`, `org_caller_rank`,
    `is_org_admin` all carry `status = 'active'`, and all **14** module capability
    predicates route through `is_org_member`/`is_org_admin`; the only function reading
    `org_members` WITHOUT a status filter is `org_member_profiles` — intentional
    (admin-scoped, it must show pending invitees). Schema on prod as designed
    (`status` NOT NULL default `'pending'` + CHECK, `invited_by`, `invited_at` NOT NULL
    default now(), `accepted_at`, `org_members_status_idx`, `profiles.settings jsonb` NOT
    NULL default `'{}'`), both new policies present and scoped to `user_id = auth.uid()`,
    RLS still enabled. **Backfill confirmed:** 28 `org_members` rows, ALL `active`, 0
    pending, `invited_at` on every row — cross-checked against the pre-migration backup
    (its `org_members` INSERT block has exactly 28 rows and only the 4 pre-slice columns),
    so nothing was added, lost, or left silently pending. Column-level ACL: `profiles.settings`
    is `authenticated=w` only and `authenticated` cannot update `is_superadmin`/`email`
    (table-level `ardDxtm`, no `w`) — the column-scoped UPDATE restriction holds on prod;
    no self-promotion path. **Live behavioral test, run inside a ROLLED-BACK prod
    transaction** (28 rows / 0 non-active verified before and after): a synthetic pending
    ADMIN invite gave `is_org_member=false`, `is_org_admin=false`, `org_caller_rank=0`,
    `shares_org_with(inviter)=false`, org row not SELECTable, `org_my_pending_invites()`
    = exactly the caller's own invite, `org_member_profiles()` = 0 rows to a non-admin,
    and `anon` refused on all three rpcs; after `org_accept_invite()`: member + admin,
    `org_caller_rank=2` (= `org_role_rank('admin')`), seat active with `accepted_at`
    stamped.
  - **Prod-only finding 1 — the deferred `revoke PUBLIC` sweep is now QUANTIFIED.** The
    ~20 **replaced** functions kept their PRE-EXISTING prod ACL, which includes PUBLIC and
    anon EXECUTE (`=X/postgres | anon=X/postgres | ...`) — `create or replace` preserves
    ACLs, so slice 3 neither caused nor worsened this. Harmless today (they all key on
    `auth.uid()`, null for anon), but it puts a number on the 2026-07-20 item: **20 of the
    23** functions in this single migration are PUBLIC/anon-executable on prod.
  - **Prod-only finding 2 — NEW deferred hardening item: `anon` holds TABLE-LEVEL write
    grants on prod.** Prod grants `anon` INSERT/UPDATE/DELETE on **all 67** public tables
    (local does not), so **RLS is the only gate between an anonymous request and every
    table.** Assessed and currently **SAFE**: 0 public tables have RLS disabled;
    `syn_zmanim_cache` is RLS-on with zero policies (deny-all); of the **197** policies
    whose roles include public/anon, every write policy resolves to `auth.uid()` or a
    capability predicate — spot-checked `cls_submission_open`, `sal_owns_customer`,
    `sd_owns_participant`, `vm_is_conv_admin`, `module_has_manager_grant`. **Action
    recorded as deferred hardening:** revoke anon's table-level write grants on public
    tables (defense in depth), to run alongside the platform-wide `revoke PUBLIC on definer
    fns` sweep — both verified against PROD, per docs/03 convention #1.
  - **Still open in §11:** entity-level joinPolicy (slice 3 remainder), slice 4
    (defaults-on-join), slice 5 (view-as) — founder-initiated only.
- **2026-07-27 (slice 3 — ORG-LEVEL INVITE-ACCEPT BUILT, Opus session):**
  `20260727010000_org_invite_accept.sql`. Being added to an org no longer makes you a live
  member — every add by a signed-in user creates a **pending** invite; the invitee sees a
  greyed-out dashboard card and becomes a member only when THEY accept (`org_accept_invite`,
  which revalidates the inviter is still authorized). `org_members.status ('pending'|'active')`;
  existing rows backfilled active, future default `pending` (fail-closed). The whole platform's
  read/write reach flows through `is_org_member` + siblings, so all of `shares_org_with`,
  `org_caller_rank`, `is_org_admin` were gated to active too.
  **Adversarial review earned its keep:** the first draft only gated the generic module
  predicates, but slice-2b had redefined ~10 coarse/shared functions to read `module_roles`
  DIRECTLY (so scoped staff reach consoles) — including the ones backing classroom Storage
  (student PII), course creation, and the shared `module_roles` write path. A pending-or-non-
  member holding a grant could reach all of those. All ten gated on active membership (plus the
  inline `syn_can_write`), which is what finally delivers the long-deferred "a module_roles
  grant implies (active) org membership" invariant, platform-wide, at the point of use.
  Guard: authenticated INSERT forced pending + inviter stamped; self-accept carve-out (safe
  because no self-UPDATE RLS policy exists — reachable only via the definer); self-decline/leave
  carve-out (member/pending own seat; active owner/admin still can't self-remove); consent block
  on admin force-activation; last-admin guard counts active-only. **Superadmin choice (founder,
  2026-07-27): the platform owner may add immediately-active OR pending, per-add, with a saved
  per-profile default — "the superadmin should control everything." Org admins can only invite.**
  App: dashboard invite cards + accept/decline/leave, members-panel pending badge, console
  add-active toggle + default control. Seed flips all seeded members to active (invite-accept is
  exercised by tests, not the seed). Two independent adversarial reviews (guard-logic = clean;
  leak-hunt = found+fixed the coarse-reader gap); 50/50 RLS suite (incl. pending-invisibility,
  consent, decline/leave, capability-gate, superadmin-choice) + e2e invite→accept. **Deferred:
  entity-level joinPolicy (invite-only/request-approval/open per class/location/event) — a
  follow-on pass; org-level request-to-join is a network feature (gated by `orgs.kind`), not a
  client-org one.**
- **2026-07-26 (slice 2 — speed-dating scope-awareness BUILT, Opus session):**
  `20260726030000_speed_dating_scoped_authority.sql` — the THIRD real multi-entity module
  scoped (events), and the first to fully exercise the extracted generics from the start.
  `sd_events` gains `scope_node_id` (each event a flat ROOT node, trigger-minted, backfilled);
  every other operational `sd_` table carries `event_id`. `module_position_rank` gains
  speed-dating vocab (admin=3 / organizer=2 / host=1 / participant→0). New precise
  `sd_can_organize_event(org, event_id)` / `sd_can_staff_event_of(org, event_id)` delegate to
  `module_caller_covers_rank/role`; coarse `sd_can_organize`/`sd_can_staff_event` redefined off
  `module_roles` for console entry; `sd_can_manage` unchanged; `module_can_manage('speed-dating')`
  set global-only. Rewrote the 7 `_write_organize` policies (6 event-scoped + `sd_events`
  3-way split), 7 selects, 2 `_update_staff`, the 3 pin triggers, and — privacy-critical — the
  **mutual-match reveal** `sd_reveal_matches`, now gated on `sd_can_organize_event(ev_org,
  event_id)` (org derived from the event row) so only an organizer of THAT event can reveal
  its matches. Existing grants stay global (no forced migration; speed-dating has no
  membership-inflation vector — participant access keys off `sd_participants` rows, not grant
  coverage). `sd_blocks`/`sd_bans` stay org-wide (root, no event_id). No storage buckets → no
  storage gap.
  - **Process (founder's subagent guidance, full docs/03 #12 rhythm): agent-drafted →
    self-reviewed → 2-reviewer adversarial fan-out, both SHIP.** Draft delegated (context
    conservation) then read line-by-line by me; tenancy+privacy reviewer confirmed coverage
    direction, complete policy rewrite, and the reveal/interest privacy arms preserved
    verbatim; escalation reviewer confirmed organizer self-escalation impossible, flat-tree
    branch-B bounded, gate excludes host/participant, cross-event blocked (re-point defense),
    and the reveal is a genuine per-event tightening.
  - **N1/L1 CLOSED:** both reviewers flagged that the coarse `sd_events` INSERT gate would let
    a future scoped organizer create orphan events it can't manage — aligned with nail-salon's
    deliberate hardening (org-admin OR GLOBAL admin/organizer via `has_module_role`).
  - **N2/L2 documented, not changed (pre-existing, non-exploitable):** the `_event` wrappers
    trust the caller-supplied `org` arg (every real call site passes a self-consistent
    (org,event) pair from the same row; returns only a boolean, never an access token —
    shared by classroom/salon); and the new definer fns carry the implicit PUBLIC-execute grant
    (fail-closed for anon). Both belong to the already-deferred platform-wide
    `revoke ... from public` sweep, not this slice.
  - Verified: RLS (+ event-scoped tests as real users), e2e, typecheck+build clean.
- **2026-07-26 (scope-authority EXTRACTION — the engine is now shared code, Opus session):**
  Founder asked whether all modules run on the same user-hierarchy code so a change
  propagates everywhere. Mostly yes (one guard, one rank fn, one grant table, one scope
  model) — but each scoped module had hand-rolled its own `<prefix>_can_manage_<entity>`
  body. Two modules = the "extract on second need" trigger, so `20260726020000_module_scope_authority_extraction.sql`
  factors the per-row authority logic into two generic primitives —
  `module_caller_covers_rank(org, module, node, min_rank)` and
  `module_caller_covers_role(org, module, node, role)` — and collapses all six classroom+
  salon functions (`cls_can_manage_class/_course`, `cls_is_ga_class/_course`,
  `sal_can_manage_location`, `sal_can_operate_location`) to one-line wrappers that resolve
  entity → node and delegate. Signatures unchanged ⇒ **zero policy/trigger churn**. Now a
  change to how scope authority works touches ONE place for all modules; a new module writes
  one-liners. **Behavior-preserving**, confirmed by RLS 33/33 unchanged + e2e 34/34.
  **Equivalence review (subagent): SHIP-WITH-CHANGES** — caught one real divergence: for a
  NONEXISTENT entity id, the original JOIN returned false-for-non-admins, but the delegated
  form returned true for a non-admin GLOBAL-grant holder (`module_scope_covers(null,null)=true`).
  Inert (RLS always passes a real FK; FK blocks bogus inserts) but it broke the "fail-closed"
  claim, so fixed exactly with a `check_node is not null` guard on each generic's grant arm
  (missing entity → `is_org_admin` only, matching the original). Coarse entry gates
  (`<prefix>_can_manage(org)`) left per-module — a smaller future tidy. Convention recorded
  in docs/03 #16. Committed + prod-pushed.
- **2026-07-26 (slice 2 — nail-salon scope-awareness BUILT, Opus session):**
  `20260726010000_nail_salon_scoped_authority.sql` applies the classroom exemplar to
  the salon's org → **location** tree — the second module scoped, and the pattern is
  now proven reusable. `sal_locations` gains `scope_node_id` (each location a ROOT
  node — the salon tree is flat); every other `sal_` table already carries
  `location_id`, so its node resolves via `sal_locations`. `module_position_rank`
  gains the salon vocabulary (admin=3 Coordinator / manager=2 Lead / cashier=1 /
  worker=1 / customer→0). New precise `sal_can_manage_location`/`sal_can_operate_location`
  gate every per-row policy + both lifecycle triggers (`sal_pin_appointment`,
  `sal_guard_bill`); coarse `sal_can_manage`/`_operate`/`sal_is_worker` redefined off
  `module_roles` for console entry only; `module_can_manage('nail-salon')` tightened
  to admin-or-global-manager (export controls are module-wide). **Simpler than
  classroom:** uniform `location_id`, no storage buckets (no storage gap), and NO
  forced grant migration — existing grants stay GLOBAL (= org-wide, unchanged; the
  salon has no `cls_is_class_member`-style membership-inflation vector, since
  customer/worker access keys off `sal_customers.user_id`/`worker_id`, not grant
  coverage). Backfill just mints location nodes.
  - **2-reviewer adversarial fan-out (run in parallel per founder's subagent guidance):
    both SHIP.** Reviewer A (tenancy/policy): no cross-tenant/cross-location hole;
    coverage direction correct, all 12 write + operate/select policies + both triggers
    moved to location-precise with own-row arms preserved, node SET-NULL fails closed,
    definer node-trigger atomic/not cross-org. Reviewer B (escalation): manager
    self-escalation impossible (only downward in-scope cashier/worker); the FLAT tree
    makes scoped-admin self-replication + peer-admin tampering structurally impossible
    (branch B only reaches global-admin→location-admin bounded delegation); gate
    excludes cashier/worker/customer; cross-module writes double-keyed; re-point
    defense holds; last-Director inert.
  - **One reviewer note CLOSED (deliberate divergence from classroom):** both flagged
    that the coarse INSERT gate let a location-scoped manager create empty,
    unmanageable locations. Unlike classroom (course creation stays coarse), salon
    `sal_locations` INSERT is gated on org-admin OR a GLOBAL admin/manager
    (`has_module_role`) — creating a STORE is a business-level act and salon has an
    explicit admin tier, so a location-scoped manager cannot spawn locations. F8
    (generic-tier role strings inherit generic ranks) is pre-existing + org-admin-only,
    informational.
  - **Verified:** RLS (+ scoped-authority tests as real users), e2e, typecheck+build
    clean. **FOLLOW-ON (not built):** a "manager assigns staff to a location" UI (the
    salon analogue of classroom enrollment) + multi-location surfacing in the console
    (today both consoles hard-select one location). The authority layer is scope-correct
    now; scoped assignment is a UI slice.
- **2026-07-24 (slice 2b BUILT — classroom scope-awareness, Opus session):**
  `20260724010000_classroom_scoped_authority.sql` ships the design recorded below.
  Classroom authority is now scope-aware: `cls_courses`/`cls_classes` carry a
  `scope_node_id` (course node = root, class node = child; minted by BEFORE-INSERT
  definer triggers, backfilled); new PRECISE functions `cls_can_manage_class/_course`
  + `cls_is_ga_class/_course` gate every per-row DB policy via `module_scope_covers`
  (global grant covers all → global professors unchanged); `module_position_rank`
  is per-module (classroom professor=2/ga=1/student=1); the write gate dropped to
  Lead so a professor enrolls within their scope; `cls_is_class_member` reads
  scoped grants (enrollment authority has ONE source); existing global professor/GA
  grants stay global, student rosters migrated to scoped grants. Enrollment
  (`enrollClassMember`) now writes the scoped grant + the name/badge roster row
  together. **Full docs/03 #12 rhythm with a 2-reviewer adversarial fan-out:**
  - **Reviewer A (tenancy/policy): SHIP-WITH-CHANGES** — no cross-tenant hole; 5
    findings fixed: **F1 (must)** `cls_courses`/`cls_classes` INSERT `WITH CHECK`
    self-referenced its own table (docs/03 #15) → falls back to `is_org_admin`, so a
    non-admin professor couldn't create courses/classes (masked in demo by
    owner-professors); split INSERT (coarse / parent-course) from UPDATE/DELETE
    (node-precise) + regression test. **F2** a global `student` grant would read as a
    member of every class → `cls_is_class_member` now requires `scope_ref is not null`.
    **F3** coarse `cls_can_manage`/`cls_is_ga` are consumed beyond storage (export
    controls, survey aggregates) → `module_can_manage`(classroom) tightened to
    admin-or-global-professor; `cls_survey_results` made class-precise; header
    corrected. **F4** no roster-only staff (verified). **F5** node triggers now own
    `scope_node_id` (client value ignored).
  - **Reviewer B (escalation): SHIP** — gate lowering grants the 6 other modules
    nothing (their roles rank 0); professors can't self-escalate or mint co-professors
    (branch B is dead for classroom, rank never 3); 2-arg repoint correct; no
    last-Director regression. Two low notes: **N3** a global professor could
    hand-craft an API call widening a student's scope to global — NEUTRALIZED by F2
    (a global student grant now confers nothing); optional guard-level rejection of
    null-scope classroom position grants DEFERRED. **N4** the email→profile lookup
    (`shares_org_with`) could enroll a non-member of this org — CLOSED by an
    org-membership assertion in `enrollClassMember`; the general "a module_roles grant
    implies org membership" invariant is a platform-wide follow-on.
  - Verified: RLS 30/30 (+5 scoped-authority tests as real users), e2e 34/34,
    typecheck + build clean. **Committed local; prod push bundled with 2a.**
  - **Storage stays ORG-scoped** (cls-submissions/materials/exams bucket paths key on
    org_id, not class) — a documented known limitation; per-class storage scoping is a
    follow-on.
- **2026-07-24 (slice 2 STARTED — 2a: module_roles surrogate PK, Opus session):** Founder
  initiated slice 2 (per-module vocabulary), starting with classroom, and it's being built
  in two verified stages. **Stage 2a** (`20260723010000_module_roles_scoped_pk.sql`) is the
  platform-wide prerequisite: replace `module_roles`' composite PK
  `(org_id,user_id,module_key,role)` with a surrogate `id`, moving the identity invariant to
  a `UNIQUE ... NULLS NOT DISTINCT` index on `(org,user,module,role,scope_ref)`. This lets a
  user hold MULTIPLE scoped grants of the same role (student@Math203 AND student@Bio49 — the
  normal case once enrollment becomes scoped grants in 2b), while NULLS NOT DISTINCT keeps at
  most ONE global grant per (user,role) — byte-identical to the old composite-PK invariant for
  every existing (all-global) row. Purely structural/additive: no FK references the old PK,
  the two guard triggers + five RLS policies key on columns (unaffected), and all existing data
  is accepted unchanged. Upsert call sites (app `org-members.ts`, seed, tests) now name the
  conflict target explicitly (`onConflict: org_id,user_id,module_key,role,scope_ref`) since the
  implicit target was the composite PK; re-seed idempotency re-verified. RLS 25/25 (+1 test:
  multiple scoped grants legal, duplicate global rejected, upsert idempotent), guard + all 7
  modules unchanged. **Stage 2b** (classroom scope-awareness + enrollment-as-scoped-grants)
  builds on this next. Design settled with the founder this session:
  - **Rank mapping (classroom):** Director 4 / Coordinator 3 / professor=Lead 2 / GA 1 /
    student 1. GA and student are PEERS (rank 1) — neither manages the other; the professor
    manages both. Founder's explicit call (a GA is not "above" a student). Rank stays
    per-module and COMPUTED (not stored on grants), so re-mapping later is a one-line migration
    with no backfill — the deliberately-flexible part of the model.
  - **"More-involved GA" needs no hierarchy change** — it's a data-surface/workflow knob:
    set the GA's grade weight to 100% in the existing gradebook combination (GA grade becomes
    the grade), plus an auto-visibility toggle. A GA with actual authority over students
    (roster) is the separate "co-instructor" case = a Coordinator-granted Lead, not a professor
    action (a Lead can't mint another Lead).
  - **Enrollment unifies into scoped grants (Option A, founder-chosen):** "student in class X"
    becomes a `student` grant scoped to X's node — one source of truth for enrollment AND
    authority, retiring the split between `module_roles` and the decorative `cls_class_members`
    roster (the two-systems bug from the testing round, items 29–30). Requires 2a's multi-grant
    capability (a student takes several classes).
  - **Global professors stay working:** 2b rewrites `cls_can_manage`/`cls_is_ga` to be
    scope-aware, treating a GLOBAL grant (scope null) as covering the whole module — so
    today's global professors are untouched; scoping is opt-in per grant. classroom has ~no
    real prod users (Pozna runs synagogue-schedules only), so 2b's enforcement change is
    demo-blast-radius.
  - **2b implementation shape (worked out 2026-07-24, ready to build):**
    - **Nodes:** `scope_node_id` added to `cls_courses` + `cls_classes` ONLY (not all 16
      tables) — every scoped `cls_*` row already carries `class_id`/`course_id` via the
      existing scope-sync triggers, so the new authority functions resolve the node from
      that. New `cls_can_manage_class(org, class_id)` / `cls_can_manage_course(org, course_id)`
      / `cls_is_ga_class(org, class_id)` do `is_org_admin(org) OR EXISTS(classroom grant,
      module_position_rank('classroom',role) ≥ 2 [prof/lead+] AND module_scope_covers(scope,
      node))`. Global grant (null scope) covers everything (module_scope_covers(null,·)=true)
      → global professors unchanged. Course node is ancestor of its class nodes, so a
      course-scoped professor covers all its classes. Node creation for NEW courses/classes
      via BEFORE-INSERT definer triggers; backfill for existing rows.
    - **N2 RESOLVED — lower the manager-grant gate to Lead.** `module_has_manager_grant`
      (the coarse RLS write gate) drops from rank ≥ 3 (Coordinator) to rank ≥ 2 (Lead) so a
      professor can enroll students/GAs in their OWN scope. The guard trigger still does the
      fine-grained enforcement (a Lead's branch-A only covers seats it strictly outranks
      within its scope; branch B stays Coordinator-only, so a professor still can't mint
      another professor — co-instructor remains a Coordinator action). Platform-wide but
      inert for the 6 other modules (all their roles are rank 0). Resolves docs/15 N2.
    - **`cls_class_members` DEMOTED to a name-only store.** Enrollment authority becomes the
      scoped grant; `cls_is_class_member(class_id)` is rewritten to read `module_roles`
      (any classroom grant covering the class node) instead of the roster table. The roster
      table survives only for `preferred_first/last_name` + the badge, so the two-systems
      disagreement (items 29–30) is gone: authority has ONE source. `enrollClassMember`
      writes a scoped grant (and optionally the name row); existing roster rows backfill into
      scoped student/ga/professor grants.
- **2026-07-22 (DECIDED — branch B restricted to the Coordinator tier, Opus session):**
  Resolves the open question the 2026-07-20 Fable re-review left for the founder
  (below). **Branch B of the two-branch guard (same-position + strict-scope
  containment) is now gated to the Coordinator tier only** — `module_position_rank(seat_role) = 3`
  added to branch B in `module_caller_can_manage_seat` (still-unpushed
  `20260720010000`). Keyed on the rank NUMBER, not the literal `'coordinator'`,
  so it automatically covers whatever real per-module role slice 2 maps to that
  tier. **Reasoning:** a Director (rank 4) already dominates any Coordinator via
  branch A (strict rank + scope coverage), so gating branch B on rank 3 costs
  Director no real capability — it only removes Director SELF-REPLICATION (a
  non-admin Director independently minting more Directors at sub-scopes, the
  exact gap the re-review surfaced). Per §2.2 a Director is meant to be
  org-appointed (the org owner/admin escape hatch), not spawned by another
  Director. Coordinator→Coordinator sub-scope chains (STEM→Math) — the pattern
  the model explicitly wants — are unaffected. Lead/position tiers (ranks 2/1)
  are unmapped in slice 1 so this changes nothing there today; slice 2 decides
  per-module whether those tiers ever want branch-B self-nesting. Regression
  tests added to `packages/db/src/rls.test.ts` (a non-admin director is REJECTED
  minting a director via branch B, still SUCCEEDS appointing a coordinator via
  branch A); the existing coordinator→coordinator branch-B test is unchanged.
  Full docs/03 #12 rhythm re-run (RLS 24/24, 4/4 live, typecheck+build+e2e clean).
  **PUSHED to prod this session** (backup first → `migrate:prod`) — the whole
  of slice 1 (`20260720010000` + this refinement) is now live on prod.
- **2026-07-22 (prod-only ACL gap found in post-migrate verification → fix-forward
  `20260722010000`):** Verifying slice 1 on prod (not just local) surfaced that the
  2026-07-20 Fable "revoke PUBLIC" fix on the two ancestry oracles
  (`module_scope_covers`/`module_scope_strictly_contains`) **did not actually close
  the gap on prod.** Prod's `ALTER DEFAULT PRIVILEGES FOR ROLE postgres` grants
  `EXECUTE` **directly** to `anon`/`authenticated` on new functions; `revoke ... from
  public` doesn't touch a direct grant, so both oracles stayed anon-executable on prod
  (proacl `{postgres, anon, authenticated, service_role}`), while local — lacking that
  default — showed them correctly closed. The local RLS suite structurally cannot catch
  this (it runs against local defaults). Fixed with an explicit `revoke ... from public,
  anon, authenticated`; applied local + prod; re-verified live (prod proacl now
  `{postgres, service_role}`, `has_function_privilege('anon'/'authenticated', …)` =
  false; guard suite still 24/24 since the sole caller is the definer running as
  postgres). Low practical severity (a boolean ancestry oracle over node UUIDs only org
  members can read) but exactly the defense-in-depth closure the earlier fix intended.
  **Two conventions added to docs/03 #1 from this:** (a) state the FULL intended ACL on
  functions explicitly — never rely on a default for a security boundary; (b) verify
  security-sensitive ACLs against PROD, not only local. The still-open platform-wide
  "revoke PUBLIC on definer functions" pass (2026-07-20) must therefore revoke from
  `public, anon, authenticated` and be verified against prod.
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
    escape hatch can always reassign/revoke) but real — flagged to the founder
    and now CLOSED by the 2026-07-22 decision (branch B gated to Coordinator
    tier; see the top of this log).
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
  - **Open question surfaced here — DECIDED 2026-07-22 (see the top of this
    log).** The review flagged that branch B was rank-agnostic, so a plain
    non-admin `director`-holder could mint sub-scoped directors with no further
    admin involvement. Founder call: **restrict branch B to the Coordinator
    tier (rank 3).** Director keeps every branch-A capability (it already
    dominates Coordinator via rank + coverage); only Director self-replication
    is removed, matching §2.2's "Director is org-appointed, not
    Director-spawned". The STEM→Math coordinator-chain pattern the model wants
    is untouched.
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
