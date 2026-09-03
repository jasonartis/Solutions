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

## 8. View-as and audit — **[BUILT 2026-07-31; classroom + nail-salon reviewed]**

*(Declarations exist for all 8 modules. Edges are ON for **classroom** (2026-07-31)
and **nail-salon** (2026-08-04, its own surface review); speed-dating's six pairs
are enumerated and still await theirs. See the 2026-07-31 decisions entry for what
was resolved at build time — including professor→student, which point 11 below left
open, and a correction to the "personal layer" vocabulary — and the 2026-08-04 entry
for the distinction the salon review added: mode 1 answers "what can this POSITION
see?", mode 2 answers "what does this PERSON see?", and the second is only
meaningful where RLS narrows per person rather than per scope. Everything in §8/§8.1
that describes intent still describes intent; where a build diverged or sharpened
it, that entry says so.)*


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
   **[PARTIAL — 3 of 6 modules rank-mapped: classroom (2026-07-24, "slice 2b" in the journal),
   speed-dating and nail-salon (both 2026-07-26). The three single-entity modules
   (matchmaking/synagogue-schedules/visual-messaging) are NOT yet mapped — their vocabularies
   are entirely rank 0, so nothing is blocked by this, but this slice is not "done," only
   started. Corrects a doc contradiction found 2026-08-29: CLAUDE.md's "Next / open" list calls
   slice 4 "the only unbuilt slice left," which is true only in the narrow sense that no OTHER
   slice is entirely zero-progress — slice 2 itself is genuinely partial, not finished.]**
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
   module can opt out); **edges are ON only in a module that has had its own §8.1
   point 9 surface review** — at this build, classroom alone; **since 2026-08-04,
   classroom AND nail-salon** (five staff pairs, mode 2 on the two into `worker`;
   see that decisions entry). Both classroom pairs answered:
   professor→GA ON (already settled in §8) and **professor→student ON**, the pair
   point 11 left open. Speed-dating's 6 pairs are enumerated and
   explicitly OFF with reasons, still awaiting its review; the other five vocabularies are entirely rank 0 in
   SQL so they imply no pairs at all — and rank-mapping any of them will break the
   build until every newly-implied pair is answered, which is the amendment working.
   No new database read path (§8.1 point 1): one append-only session-log table, its
   guard, and the SQL edge mirror. Two independent Fable reviews; RLS suite 77/77,
   2 e2e, 21/21 live probes as real users.

Each slice independently shippable; module specs get dated decision entries as their
vocabulary gets locked.

## Decisions log

- **2026-08-10 — a SECOND superadmin's lookup-log visibility should follow the same shape as
  everywhere else on this platform: own lookups plus those of superadmins "lower" than them,**
  not the flat mutual-visibility default the log shipped with. Full argument, and why it is
  recorded but NOT yet implementable (superadmins have no ordering today — nothing to be "lower"
  than), lives in docs/12 item 9. Consistent with the visibility principle immediately below:
  reads flow down a ladder, never up — this is that principle applied to the one place on the
  platform where the ladder itself doesn't exist yet.

- **2026-08-09 (FOUNDER PRINCIPLE, stated plainly for the first time — recorded here because
  this document is where anyone designing visibility will look, and it had only ever been
  written down as an aside in a feature spec).** Reacting to a proposal that would have let a
  salon customer see when the salon admin last signed in, the founder's words:

  > **"There should never be any visibility to someone lower of someone higher!"**

  Treat this as the default for any NEW visibility surface: reads flow DOWN a ladder and
  sideways at best, never up. It is the same instinct behind the appointment rule (§4) and
  behind the lookup log's "only the superadmin" read, now stated as a general value rather than
  re-derived per feature.
  **THE HONEST COMPLICATION, which is why this entry exists rather than a one-liner: the
  platform already breaks it in one place, deliberately.** `profiles_select_shared_org`
  (`20260708020000`) is FLAT — share any org, read the whole profile row, no rank arm at all.
  Proven live 2026-08-09: charlie, a rank-0 salon customer, reads all 8 profiles he shares an
  org with, including frank the rank-3 admin. That was a considered decision (a professor's
  roster was rendering raw UUIDs) and it covers only static identity — name, email — which a
  customer who books with frank already knows.
  So the principle governs **behavioural** data, and identity lookup is the standing exception.
  Two consequences already live:
  - **RLS filters ROWS, NEVER COLUMNS**, and column privileges are per-ROLE not per-row. So any
    column added to `profiles` inherits that flat visibility and there is no way to make it
    private. This is why engagement monitoring's `last_sign_in_at` went onto a superadmin-only
    table instead of the `profiles` mirror its own spec called for (docs/17 §5).
  - **Whether to narrow `profiles_select_shared_org` itself is OPEN** and on CLAUDE.md's list.
    It touches every roster in every module, so it needs its own migration and review.
    **Re-raised 2026-08-10, still unresolved ("not sure / discuss further"):** offered the concrete
    tension above (a classroom student needs the professor's name — that's benign; a salon
    customer reading the admin's personal email is closer to the actual concern) plus a lean
    toward leaving it as-is, since narrowing name/email would break the classroom case to fix the
    salon one and the principle is already honored going forward for BEHAVIOURAL data (which is
    the actual live risk). Founder wants to think about it more rather than decide either way —
    not a decision, recorded so the tradeoff doesn't need re-deriving next time it comes up.
  **And the shape this principle takes when it is finally implemented as a rank arm is NOT the
  obvious one** — see the 2026-08-07/08 entry below and docs/17 §7.1: `module_position_rank`
  returns 0 for anyone unmapped and never null, so "I outrank the subject" silently lets every
  rank-1 holder read everyone who is off the ladder entirely. *Unranked is not rank 0.* An arm
  enforcing this principle must require both parties to be on the ladder and fail closed
  otherwise.
- **2026-08-09 (THE RANK ADMISSION MAP — the rank/tier-wrapper verification gap, CLOSED. No
  migration: one test plus one generated doc. Opus session; adversarial review run on the
  test itself, since a checker that lies is the exact failure mode it exists to prevent.)**
  docs/13 had recorded, and CLAUDE.md's Next list had carried, that nothing verified whether
  a rank remap changed what a `rank >= N` wrapper ADMITS. It is now
  `packages/db/src/rank-admission.test.ts` + [rank-admission-map.md](rank-admission-map.md).
  Four things worth carrying forward:

  1. **THE "FOUR RULES" WERE EIGHT FUNCTIONS, and the delta was where the danger was.** The
     documented four are right as mechanism FAMILIES and wrong as an inventory of code. The
     tier-threshold family alone is five functions holding four independently hardcoded `2`s,
     so a fix aimed at the generic `module_caller_covers_rank` would have left
     `cls_can_manage`, `sal_can_manage`, `sd_can_organize` and `module_has_manager_grant`
     uncovered while looking complete. Two entire rules were missing from the summary:
     `module_roles_guard_last_director` (the only reader of rank **4**, and it fails OPEN —
     demote `director` below 4 and the last-Director protection silently stops firing) and
     the `= 3` peer-appointment arm inside `module_caller_can_manage_seat`, an EQUALITY, which
     no threshold-shaped check would have found. Generalised into docs/03: *a count of
     mechanisms is not a count of code.*
  2. **THE CHECK DISCOVERS ITS OWN SUBJECT, AND HARD-FAILS ON WHAT IT CANNOT READ.** The rank
     readers are read out of `pg_proc.prosrc` rather than listed, so a ninth rule fails the
     build the day it lands. A comparison whose shape the parser cannot classify, or a
     threshold whose value it cannot resolve to a literal at every call site, is a FAILURE and
     never a skip — because a checker that skips the unfamiliar goes green while covering less
     and less. This is the vacuity rule with a slow fuse, and it is now a docs/03 rule in its
     own right. It earned its keep on the FIRST run: it refused
     `losing := rank(...) < 4 or ...`, a real threshold inside a boolean assignment that the
     draft had mistaken for a rank bound to a variable.
  3. **THE PROOF IS THE MOTIVATING EXAMPLE, RUN FOR REAL.** `cashier` was remapped 1 → 2 in
     the live database, the test failed, and the diff named `sal_earnings_ledger` on the
     `sal_can_manage_location` row. The original definition was then restored and verified
     byte-identical to its migration source by md5 of `prosrc`, not merely by re-reading the
     ranks. A test that would not have caught the case it was written for is not the test.
  4. **THE ADVERSARIAL REVIEW WAS RUN ON THE CHECK ITSELF, AND IT PAID.** No migration shipped,
     so docs/03 #12's rhythm did not strictly apply — but a checker that lies is precisely the
     failure this file exists to prevent, so it got the review anyway. **Four findings were
     silent-widening holes, i.e. the check would have stayed green while covering less:**
     (a) discovery was CASE-SENSITIVE over `prosrc`, which stores the body verbatim, so a
     gate written `MODULE_POSITION_RANK(...)` or with a quoted identifier was invisible —
     fixed, plus a control requiring Postgres and the JS regex to AGREE on how many bodies
     mention the ladder, which turns any future lexical blind spot into a failure;
     (b) only `pg_proc` was searched, so a rank test in a policy, CHECK, default, view, index
     predicate or another schema would never be seen — none exist, and that absence is now
     ASSERTED with its own catalog-size control rather than left incidental;
     (c) **the rule set was discovered but the VOCABULARY was declared** — the sharpest
     finding, because the file's own argument condemned it. Adding `when 'supervisor' then 3`
     to the ladder would have given every module a new rank-3 name satisfying the peer arm and
     every `>= 2` gate, with no map row and no failure. The vocabulary is now parsed out of the
     ladder's own body, per module block;
     (d) `not (rank >= 2)` parsed as `rank >= 2`, so the map would have published the exact
     COMPLEMENT of who a gate admits — now a hard failure, and carefully distinguished from
     `not exists (… rank >= 4 …)`, which is live today and correctly read as `>= 4`.
     Also fixed: SQL comments were parsed as code (a commented-out gate became a live map
     entry, and a gate name in a comment invented a threshold on someone else's gate); the
     closure froze each function on its first pass; and **three claims in the file's own
     header were false** — by this repo's standard that is a defect, not a typo.
  5. **AND THE MAP RECORDS WHAT IT DOES *NOT* WATCH.** It tracks only what RANK opens.
     `sal_can_operate_location` also admits by the role NAME `cashier`; `module_caller_covers_rank`
     short-circuits on `is_org_admin`. Those are deliberately out of scope — they do not move
     when the ladder moves — and the generated file says so in its own header, so a **nobody**
     cell can never be misread as "nobody can get in". Same discipline as the badge rule: the
     artifact states its own limits, because the next reader will trust it.

- **2026-08-07/08 (THE SUPERADMIN LOOKUP LOG — built, adversarially reviewed at three lenses,
  findings applied, shipped. Migration `20260807010000`. Opus session; reviews requested as
  Fable, model UNVERIFIED per the standing provenance caveat.)** The follow-on the
  2026-08-06 build deliberately shipped without. Both Owner Console tools now record every
  lookup to a new superadmin-only table. Five decisions worth keeping:

  1. **THE APPOINTMENT RULE, APPLIED HONESTLY, ADMITS NOBODY — AND THAT IS THE ANSWER, NOT A
     GAP.** Decision 5 below specced visibility as "strict rank + scope coverage". Applied to
     this table's actual rows it yields exactly the founder's own words ("only the superadmin
     can see them"), because every actor is a platform superadmin and **a superadmin is not at
     the top of any module ladder — they are OUTSIDE every ladder.**
  2. **"UNRANKED" AND "RANK 0" ARE NOT THE SAME THING, and conflating them would have INVERTED
     the hierarchy this table exists to enforce.** This is the reusable finding.
     `module_position_rank(module_key, role)` returns **0 for any unmapped pair and never
     null** — its inner CASE falls through `coalesce` to the generic tier table, whose `else`
     is 0. So the natural-looking policy arm `rank(reader) > rank(actor)` computes a
     superadmin actor's rank as 0, and **every rank-1 holder on the platform — a salon
     cashier, a classroom GA, a speed-dating host — then strictly outranks the platform
     operator and reads their entire cross-tenant lookup history.** Silently, error-free, and
     passing any test that only asserts the policy exists. Rank 0 is the bottom of a ladder;
     unranked is not on it. **The absence of a rank arm is therefore the security-critical
     decision in that migration, and it is stated as such rather than left to be inferred.**
     A live RLS test now proves it from both ends of a real ladder (salon worker rank 1 AND
     salon admin rank 3, both inside the org the row names).
  3. **AN IDENTITY-KEYED READ ARM SURVIVES DEMOTION — so it was deleted, not fixed.** The
     draft had a second policy, `actor_user_id = auth.uid()`, serving the founder's stated
     self-read use case. The review found that `actor_user_id` is stamped once and never
     changes while `profiles.is_superadmin` is a separate mutable column with nothing tying
     them together: **strip someone's superadmin flag and they keep reading every row they
     ever wrote, across every tenant, forever** — and demotion is precisely the
     suspected-misuse scenario the log exists for. The proposed fix (`and is_superadmin()`)
     is correct and *also makes the policy dead*, since it becomes a strict subset of the
     superadmin arm. So the arm is gone entirely and the self-read case is served by the
     superadmin arm it was always a subset of. **Generalisable: an audit-log read arm keyed on
     WHO YOU WERE outlives the authority it was granted for; key it on who you ARE.**
  4. **A CHECK CONSTRAINT CAN RE-CREATE THE `ON DELETE SET NULL` TRAP THAT KILLED THE
     APPEND-ONLY TRIGGER.** The review proposed a shape constraint including
     `subject_user_id is not null` for data-browser rows — obviously true, since that tool
     always targets one person. **It is a trap.** `subject_user_id` is `on delete set null`,
     and a CHECK is re-evaluated on every UPDATE *including the real UPDATE Postgres performs
     to satisfy an FK action* — so it would have made **every person ever browsed permanently
     undeletable**, breaking account erasure exactly as the rejected before-update trigger
     would have. The clause was dropped and the rest kept. **The 2026-07-31 lesson generalises
     past triggers: any constraint forbidding the null an FK action is about to write turns
     "the log outlives what it describes" into "what it describes cannot die."** A test now
     deletes a scope node named by a live log row and asserts BOTH halves — the delete
     succeeds, and the row survives with a nulled reference.
  5. **`is_superadmin()` IS NOT THE APPOINTMENT RULE, and saying so is the honest part.** The
     review's sharpest spec-fit finding: the oversight arm performs no rank comparison and no
     scope test, because **there is no rank domain among superadmins to compare over** —
     `is_superadmin` is a flat boolean, not a ladder. Presenting a blanket "any superadmin
     reads every row" as the output of "strict rank + scope coverage" would be dressing an
     unspecced choice in the spec's language. It is now stated as what it is: a deliberate v1
     default, exactly right while there is ONE superadmin, and **carrying an open founder
     question the moment there are two** — should superadmin B read 100% of superadmin A's
     lookups, unscoped, forever? (The alternative, each reads only their own, would make the
     log pure self-audit and give no oversight at all — so this is the better default, but it
     IS a default.) On the Next list, and a second reason "a second superadmin" is already a
     named expiry condition in docs/12 item 9.

  **WHAT THE BUILD FALSIFIED IN ITS OWN CODEBASE — four claims, all corrected in place rather
  than deleted, because each one's REASONING is what got overturned:** `console-view-as.ts`'s
  "this surface writes nothing" (the sentence that explained why docs/03 #18's rule did not
  bite — the rule still doesn't bite, but now for a different, stated reason: nothing reads
  the row back as a capability, unlike `view_as_sessions` where a row IS one); the data
  browser page's "reading is the unstamped side of the platform, and this page writes nothing
  at all" (true of the platform generally, and exactly the wrong inference for the most
  revealing read on it); the `view_as_sessions` data-browser note's "the Owner Console's
  superadmin view-as is unlogged by founder decision, so it leaves no row to find"; and the
  **on-screen `not logged` badge**, plus the e2e assertion that had been holding it true. That
  last pair is the one worth remembering: **a badge is a claim made to the operator, so a test
  that keeps passing after the claim goes false is worse than no test at all.**

  **THE DATA BROWSER'S OWN COVERAGE TEST CAUGHT THE NEW TABLE AUTOMATICALLY**, which is the
  machine-enforced half working exactly as designed — `data-browser-coverage.test.ts` reads
  `pg_catalog` and failed the build until the log's two person columns were declared. It is
  now surfaced as "Owner Console lookups naming them", **included rather than omitted on
  purpose**: this tool's promise is to enumerate everything held about a person, and "we
  looked at you, on these dates" is genuinely part of that answer — it is what a
  subject-access request would have to disclose. Omitting it for tidiness would make the
  completeness claim false, which is the one failure that tool cannot afford.

  **VERIFICATION.** typecheck 9/9; `pnpm build` clean; db suite **108/108 (RLS 104/104)**, up
  from 97/97 — **11 new tests**, floor raised to 104; e2e **49**, including two round-trip
  tests that drive the real console over real HTTP and then assert the lookup surfaces in the
  data browser (verifying the write, the read, and the declaration in one path). Live rows
  confirmed in the database with the intended shape asymmetry: data-browser rows carry a
  subject and no module/position/scope, view-as rows always carry both module and position.

- **2026-08-06/07 (THE OWNER CONSOLE VIEW-AS — the superadmin surface that bypasses every
  declared edge, built, adversarially reviewed, and shipped with the review's findings
  applied. Opus session; review requested as Fable, model UNVERIFIED — see the provenance
  note below.)** `/console/view-as`, superadmin-only, deliberately absent from the in-module
  tab strips so those stay strictly by-the-rules. Six decisions worth keeping:

  1. **THE THREE FOUNDER-SPECIFIED MODES ARE ONE AXIS, NOT THREE CODE PATHS.** The mode picks
     the PERSON axis only — me / one named holder / nobody — and SCOPE is an independent
     picker available in every mode. That is the 2026-08-04 entry's "position + optional
     person + optional scope" taken literally, and it is what makes mode 3 the answer to the
     need the nail-salon review identified and refused to fake: viewing ONE NAMED holder's
     LOCATION-narrowed back office, which mode 1 cannot give (it renders the caller's own
     scope) and mode 2 cannot give (a location-narrowed position has no per-person column).
  2. **WHAT IT BYPASSES IS FOUR THINGS, NOT THREE** — and the count is stated in the code
     because an exhaustive-sounding list that is not exhaustive is worse than no list. The
     declared EDGE; the strict-rank and scope-coverage conditions; §8.1 point 10's
     caller-scope INTERSECTION; and — found by the review, not by the build —
     `org_modules.enabled`, the routing gate `requireOrgModule` 404s on. It bypasses NEITHER
     RLS NOR the surface declaration, and it does not bypass mode 2's per-person requirement
     either, because that is a property of the SURFACE rather than of the edge.
  3. **A DISABLED MODULE RENDERS, AND IS BADGED** (founder, 2026-08-06). Suppressing it would
     lose the deprecation-time value that made the data browser's identical choice right —
     the moment you most need to know what a manager could see is when deciding what to
     export before deleting, and disabling is documented as step ONE of that sequence.
     Rendering it unbadged would be a false claim, since a holder can open none of those
     tabs. The premise that makes this free is machine-checked now: **zero RLS policies
     anywhere reference `org_modules`** (a `pg_policies` test), so enablement changes
     ROUTING and never REACH.
  4. **NAMING A GATE IS NOT PASSING ONE.** `RenderAuthority`'s superadmin arm was the bare
     literal `{ kind: 'platform-superadmin' }`. The mandatory `kind` closed the ACCIDENTAL
     bypass — no defaulting boolean can hand a caller edge-bypassing authority by omission —
     but any future action or script could type that literal and call `renderSurface()`
     having checked nothing. It now carries a `SuperadminGate`: a `declare const unique
     symbol` brand with NO runtime value anywhere, so the type cannot be written as an object
     literal at all and the single `as` cast inside `requireSuperadmin()` is its only source.
     A compile-time control, not a runtime one — `as never` still defeats it, and it is not
     trying to stop that. It stops the plausible accident: a new call site copying the
     literal without noticing the check was what the literal stood for.
  5. **THIS BUILD SHIPS UNLOGGED; THE LOG GETS BUILT AS A FOLLOW-ON** (founder, 2026-08-06,
     settling the tension CLAUDE.md had flagged as needing a dated decision rather than an
     assumption). §8.1 point 6 makes the mode-2 session log a security requirement from v1,
     and this surface is strictly MORE powerful than the logged one — so inheriting
     "unlogged" from the data browser without argument was exactly the assumption to refuse.
     What dissolved the objection was the founder's counter-proposal: **hierarchy-governed
     log visibility**. The load-bearing objection had been the AUDIENCE (logging into
     `view_as_sessions` publishes superadmin activity into every tenant's audit view); a
     separate, superadmin-read-only table changes the audience and the objection goes with
     it. The on-screen badge says "not logged" and is accurate for what shipped; the log is
     purely additive. **Spec for the follow-on:** a NEW table, not `view_as_sessions` —
     decisively because it is a DIFFERENT EVENT (it covers BOTH console tools, and the data
     browser has no session, target_role, scope_ref or expiry), and because a
     `view_as_sessions` row IS a capability, so mixing non-capability rows in makes safety
     depend on a downstream re-check instead of on the row not existing. Shape roughly
     `(actor_user_id, tool, org_id, module_key?, subject_user_id?, position?, scope_ref?,
     created_at)`. Written by BOTH Owner Console tools — logging only the narrower one while
     the `select *` data browser stays silent is the incoherent option. Visibility by the
     **APPOINTMENT rule** (strict rank + scope coverage), NOT view-as's per-pair declaration:
     a log row is metadata with no surface and no third-party secret, so per-pair entries
     would be ceremony with no decision behind them, while "if you can remove someone, you
     can review what they did" is one rule that derives for every module and brings scope
     narrowing along for free. Append-only by GRANTS, never a trigger (`on delete set null`
     fires BEFORE UPDATE triggers — docs/03 #18), and name `service_role` in the revoke.
     **The trap:** a log row names TWO people; hierarchy answers who may read by ACTOR
     (oversight), and reading by TARGET is §8.1 point 6's notify-the-target question, still
     open. One table, two features; a single policy must not try to be both.
  6. **THE PRINCIPLE THE FOUNDER STATED, which outlives this feature:** hierarchy-governed
     visibility should apply to EVERY activity log on the platform. That implies a second,
     independent question — should `view_as_sessions`' own whole-org admin read be narrowed
     the same way? Same principle, own migration, own review. This is docs/13's parked
     question, now with a principle attached.

  **THE ADVERSARIAL REVIEW (2026-08-06), and what applying it changed.** Four parallel
  subagents, one per claim cluster. *Provenance caveat, recorded because it matters more than
  the finding count: requested as Fable, model UNVERIFIED — the subagent transcripts are 0
  bytes on disk and the harness's injected "you are model X" string is demonstrably
  unreliable. Treat as "Fable-requested, unverified".* **No ship-blocker inside the diff**;
  claims 1, 4 and 7 survived, 2 and 3 broke, 5 survives but narrower than it read. What the
  apply beat actually produced:

  - **Finding 1 was a LIVE DEFECT OUTSIDE THE DIFF, in classroom code shipped 2026-07-31, and
    it is the most reusable thing here.** The student surface declared `cls_review_comments`
    a role table with `subjectColumn: null`, directly under a comment saying the rows are
    ABOUT the student as reviewee. That is the contradiction: a subject column names a person
    ON THE ROW, and a comment names its AUTHOR — the reviewee is one hop away through
    `submission_id`. With no hop the entry fell back to "not per-person", so **every
    student's tab rendered the whole class's peer-review comments, badged like a class-wide
    announcement**. Severity, pinned down: a FALSE CLAIM, not a leak. The live student UI is
    correct (it goes through `cls_comments_for_my_submission()`, whose return type has no
    author column at all), only the view-as surface read the raw table, and a professor
    already reads every comment in their course — so no data crossed a boundary. What broke
    was the tab's claim to show what the STUDENT sees, which is the "a false claim the next
    reader trusts" category. **Fix: an embed under `cls_submissions` keyed on `student_id`,
    mirroring the definer's join condition for condition — not `excluded`, because the
    student genuinely is meant to see their own** (the 2026-08-02 split: the COMMENTS on
    their own work, never the peer GRADES). Retention comes along free, since a submission
    the student can no longer see takes its comments with it.
  - **Finding 5 was true and narrower than it read.** `personFilter` is a pure function of
    `subjectColumn !== null`, so it says nothing about SCOPE. Salon `manager` and `cashier`
    are location-narrowed and declare `subjectColumn: null` on every table — so every section
    of theirs is "not per-person" and **no section could ever be badged**, while mode 3 with
    scope "all" quietly combined every location. The page copy "affected sections say so" was
    false 100% of the time for exactly the two positions mode 3 was built for. Fixed with a
    second axis (`scopeFilter`), worded as a fact about the RENDER rather than an inference
    about holders — an org-wide grant genuinely does see every location, so "more than one
    holder sees" would be the opposite lie. **The fix shipped with its own instance of the
    same bug, caught by the e2e test written for it:** the badge first keyed on the scope
    resolver returning a null id list, but the whole-module bypass skips the node FILTER
    while still RETURNING every id, so the two cases are indistinguishable from the result.
    The page rendered both salon locations and badged nothing. `resolveScope` now tracks
    `wholeTree` directly. Reusable form in docs/03: an honesty signal needs a test that
    RENDERS it, because being visible to a human is its entire purpose.
  - **Findings 2, 3 and 4 became the mechanisms above** (the gate token, the source scan, the
    disabled-module badge). Finding 3 is worth restating as a rule: the existing
    `.rpc()`/service-role source scan hardcoded three data-browser paths and **never saw the
    new files**, and `scripts/*.mts` are not run by CI — so the invariant that makes the
    whole UI gate sound rested on manual tracing. It is now in `rls.test.ts` too.
  - **Finding 7 corrected a mechanism claim in this build's own header.** "A superadmin row
    in `view_as_sessions` fails closed ONLY because `sessionStillAuthorised()` re-checks" is
    an overstatement: the `view_as_guard_session()` BEFORE INSERT trigger rejects it outright,
    first at `is_org_member(new.org_id)` (which the superadmin fails, because `is_org_member`
    deliberately does NOT short-circuit on `is_superadmin` the way `is_org_admin` does) and
    again at the `exists` over `module_roles`. Both conclusions were true; the stated
    mechanism was the wrong one. Corrected in place so the follow-on's migration header does
    not inherit it.
  - ~~**Finding 6 is RECORDED, NOT CLOSED, and is on the Next list.**~~ **CLOSED 2026-08-28.**
    `blinded` — the "your own RLS may have emptied this" detector — was computed ONCE for the
    module's `scopeEntity` table and never per role table. A future migration dropping an
    `is_org_admin` arm on an ordinary role table yielded a silent, error-free, UNBADGED empty
    section. The migration in this very build (`20260806010000`) is proof the category already
    bit once; it was caught only because it hit the scope-entity table, whose symptom is loud —
    every scoped section empties at once.
    **THE FIX, and why it is the only one available.** An empty read and a policy-denied read
    are INDISTINGUISHABLE over PostgREST — both are zero rows with a null error — so nothing
    about the narrowed read can separate them, and the keystone forbids the renderer a second
    authority to compare against. The only signal left is to ask the SAME RLS-enforced client
    the same question with every declared narrowing dropped: *can you read any row of this table
    anywhere in this org?* That is `tableReachable()` in `apps/web/lib/view-as.ts`, and it sets
    `RenderedSection.emptyReason` to `narrowed` (the declared scope/person/filter/retention
    narrowing explains the emptiness — a real finding about the position) or `unverified` (it
    does not, and the page must not claim it does). Keystone-safe by construction: same client,
    inside `org_id`, one already-allow-listed column, the row discarded — only a boolean leaves
    the function, so it cannot widen a surface because it cannot put a row on one.
    **WHAT THE MEASUREMENT CHANGED — the copy, and it is worth knowing before touching it.**
    Measured against the seeded DB before writing the wording: the superadmin reads ≥1 row of
    **all 28** declared surface tables across **every** org × module the Owner Console offers,
    so the badge is unreachable from that console today and does not fire spuriously. The only
    in-module holder who trips it is **grace**, the seed's one location-scoped salon manager,
    on five tables — because Uptown legitimately has no appointments, customers or bills. So the
    common trigger is a NARROW GRANT, not a bug, and the copy names all three readings (nobody
    has anything here / your grant covers none of it / you cannot read it at all) instead of
    crying failure. Over-cautious by design, exactly as `blinded` itself already is.
    **TESTED ON BOTH SIDES, and the asymmetry is deliberate.** The e2e suite asserts the badge
    does NOT over-fire — narrowing the Owner Console to Uptown empties several sections and each
    must still render the plain wording — because a badge that fired on every empty section
    would be the warning nobody reads (docs/12 item 10 names that failure). The positive side
    could not be asserted there: no console-reachable combination produces it, and the one
    holder who does is grace, whom the e2e suite must never sign in as (its phase-3 engagement
    test depends on her having never signed in). So the PREMISE is proven in the db suite
    instead, inside the block that already signs her in and already cleans up her login rows,
    with a non-emptiness control so it cannot pass on an empty table. **The positive block's
    own RENDERING is therefore not covered by a test** — recorded plainly rather than implied,
    since finding 5's lesson is that an honesty signal needs a test that renders it.

  **THE MIGRATION, and the general lesson in it.** `20260806010000_sal_locations_superadmin_read.sql`
  restores the superadmin's SELECT on `sal_locations`, lost when `20260726010000` split a
  `for all` policy per-command: **a `for all` policy's USING also covers SELECT, so splitting
  one per-command silently drops an inherited read arm.** `sal_locations` was the ONLY table
  in the whole schema where `service_role` saw rows and the superadmin saw ZERO WITH NO ERROR
  — which renders every scoped salon section blank and reads as a finding about the position.
  Two tests now stand behind it, and the second is the one that matters: the superadmin can
  read every declared surface table *and* the scope entity **actually returns rows**. An
  error-free assertion alone would have passed throughout the outage.

  **VERIFICATION.** typecheck 9/9; `pnpm build` clean; db suite **97/97 (RLS 93/93)**; e2e
  **47 tests**, floor raised to 47/93; **35/35 console probes and 22/22 data-browser probes,
  zero skips** (`scripts/verify-console-view-as.mts`, new). The probe script earned its keep
  on its first run by failing twice — once on a wrong table name, and once on a genuine
  misreading worth recording: **the salon SERVICE CATALOG is `is_org_member(org_id)`,
  org-wide on purpose (a customer must read services to book one), while the back-office
  tables are `sal_can_operate_location`.** So the console's scope filter on the catalog
  section is NARROWER than RLS — which is allowed, since a surface declaration may only
  narrow — and comparing catalog row counts between two managers proves nothing about scope.

- **2026-08-05 (NAIL-SALON REVIEW FOLLOW-UPS — four founder decisions, all taken on the
  review's own findings rather than new work. The review itself SHIPPED the same day: commit
  `89fae0a` with migration `20260804010000`, applied to prod and prod-verified 33/33.)**

  1. **`ExcludedFromSurface.columns` and `PersonalLayer.columns` DELETED.** Both were dead on
     arrival: the overlap check refuses one table in both `role` and an off-surface list, so a
     column-level exclusion on a table that IS rendered was unrepresentable, and every such
     decision the salon review made had to be a `caveat` anyway. A dead optional field only
     invites someone to set it and assume it does something. **The mechanism for columns is the
     role surface's `columns` ALLOW-LIST plus a caveat naming what was left off and why** — and
     the consequence to state plainly is that `excluded: []` means "no whole table is withheld",
     not "nothing is withheld".
  2. **The CI test-count ratchet now measures test counts.** Its RLS half was
     `grep -c "it("` — unanchored, so it also matched every `.limit(` line; the day it was found
     the real count was 90 and the ratchet read 105. Fixed to `grep -cE "^[[:space:]]+it\("`
     with the floor set to the EXACT count. Recorded in docs/12 because a loose ratchet is worse
     than none: deleting real tests could be masked by unrelated churn, and a refactor removing
     `.limit()` calls could fail CI having deleted nothing.
  3. **The salon seed gained a paid visit, the bookkeeping rows, and a salon ADMIN.** The
     review's one open verification gap was that the **Manager tab had never been rendered in a
     browser** — a manager holds no edge into their own position, so only an `admin` can open it,
     and there was no salon admin to sign in as. Frank (a plain org MEMBER, so his reads go
     through the module ladder rather than short-circuiting on `is_org_admin()`) now holds it,
     and an e2e renders the tab and asserts a real earnings row in it. **The admin had to be
     someone other than alice**: granting her both `manager` and `admin` would have made her
     Manager tab appear and silently inverted the e2e assertion that it does not. The visit is
     dated YESTERDAY so the day board — which queries today only — is untouched, and the bill is
     inserted `open` then updated to `paid` because `sal_feed_earnings` is an AFTER UPDATE
     trigger keyed on the transition; inserting it as `paid` would have left the ledger empty,
     which is the section the seed exists to fill.
  4. **E2E timeouts are now environment-dependent, and CI is deliberately left STRICTER.** Three
     clean-seed full runs each lost exactly one test, a different one every time — which is what
     proves the cause environmental (the local dev server compiling routes mid-test) rather than
     a set of test bugs, and why per-test patches were whack-a-mole. Local gets
     `expect.timeout: 15s` and `timeout: 45s`; **CI keeps the 5s expect default**, because CI
     serves a PREBUILT app where a slow assertion means something is genuinely slow. That split
     is what stops the fix from becoming a blanket "wait longer everywhere" that hides a real
     regression. Two sub-shapes needed the two different remedies: an ASSERTION timing out after
     a navigation (covered by `expect.timeout`) versus the `.click()` ACTION itself stalling to
     the test timeout (covered by a scoped `test.slow()`, which raises the TEST budget only).

- **2026-08-04 (NAIL-SALON VIEW-AS SURFACE REVIEW — module 5's own §8.1 point 9
  review; Opus session, adversarial review at Opus tier because this is a copy of
  an audited pattern, not a new mechanism):** All nine of nail-salon's
  rank-differential pairs answered, surfaces written for the three positions that
  gained an edge, one one-function migration (`20260804010000`). Rules → docs/03
  **#18** (amended); the record → the journal.

  **THE FINDING, and it generalises past this module: mode 1 and mode 2 answer
  different questions, and only one of them needs a person.** Mode 1 ("as if I held
  that position") answers *what can this POSITION see?* — including the answers that
  are absences. Mode 2 ("what does Smith see") answers *what does this PERSON see?*
  and is only meaningful where RLS narrows **per person**. In nail-salon it narrows
  **per location** for manager and cashier (`sal_can_manage_location` /
  `sal_can_operate_location` ask only "does your grant cover this location", so every
  row one cashier reads is readable by every other cashier at that location) and
  **per person** only for worker (`sal_appointments.worker_id = auth.uid()`, own
  time-off, only the customers they are booked with). Hence:

  | pair | mode 1 | mode 2 |
  |---|---|---|
  | admin → manager | ON | off — no per-person column |
  | admin → cashier | ON | off — no per-person column |
  | admin → worker | ON | **ON** |
  | manager → cashier | ON | off — no per-person column |
  | manager → worker | ON | **ON** |
  | admin/manager/cashier/worker → customer | off | off |

  The mode-2 refusals are not squeamishness. The only sal_ columns naming a manager
  or cashier are authorship stamps (`created_by`, `paid_by` — the latter stamped by
  a trigger as *whoever rang it up*), and filtering on one would **under-show** the
  tab, hiding rows the target genuinely reads; rendering unfiltered instead is honest
  but is not mode 2, which point 3 defines as rows ABOUT the target.
  `viewAsCompleteness()` independently refuses mode 2 on a surface with no
  per-person table, which is the code saying the same thing. **What an admin
  actually wants there — one named manager's LOCATION-scoped console — is the third
  Owner-Console mode the founder specified on 2026-08-03 ("this position's surface
  with no person filter"), and it belongs there rather than mislabelled as a person
  view.** That is now a concrete requirement for that build, not a nice-to-have.

  **The four customer pairs stay OFF and were re-decided, not inherited.** The
  product reason still holds (a customer's history is received as themselves, not
  duty output; operators already read every operational row). The review added three
  mechanical reasons: (1) **identity-key mismatch** — a mode-2 target is a
  (person, position, scope) GRANT triple, but customer read access keys on
  `sal_customers.user_id` via `sal_owns_customer`/`sal_owns_bill` and never on the
  `module_roles` customer grant, so the picker would list the wrong population and a
  grant-holder with no customer row would render empty; (2) **walk-ins are the
  majority** and hold no grant at all (2026-08-03 data-browser finding), so this
  could never be the general answer; (3) for **worker → customer** specifically the
  surface would be strictly poorer than an operator's, since a worker cannot read
  `sal_bills` or `sal_bill_items` at all. The tool that answers "what do we hold
  about this customer" is the data browser (docs/03 #19) — a different question by
  design.

  **What the surfaces made visible (each checked against the policy SQL, never
  inferred from staff rank — the mistake made twice before):** a **cashier cannot
  read one revenue row** (`sal_earnings_ledger_select_manage` is the module's only
  manage-tier read, with no operate arm) while writing expenses freely — the
  module's clearest asymmetric read (not its only one — a worker reading every
  colleague's org-wide schedule while blind to their own earnings is a second); a **worker cannot read the earnings rows
  that carry their own `worker_id`**, nor bills, bill items, promotions, expenses or
  the shopping list; and a worker **can** read every colleague's profile and weekly
  schedule (`sal_worker_profiles_select_member` is org-wide), so the worker tab's
  narrowing to their own profile is OURS and is labelled as such rather than passed
  off as a policy.

  **No new mechanism was needed, and the one place it nearly was is recorded.**
  `subjectColumn` names a column holding a user id, so a table reaching its person
  through a child row cannot be subject-filtered. Two salon tables are like that and
  both were answered honestly rather than by extending the type: `sal_worker_time_off`
  is embedded under the profile it belongs to (the hop is already made, so the rows
  are right in both modes), and `sal_customers` is `excluded` from the worker surface
  with the customer's name rendered through the appointment's embed — exactly how the
  worker's own console renders it. Rendering a standalone customer list would have
  been **falsely permissive**, the one failure mode a mode-2 tab must not have. If a
  future surface genuinely needs a hop-filtered section, the shape to copy is the
  data browser's `PersonVia.then`, and it is a platform change with its own review.

  **Two things fixed while here, both small and both honesty fixes.** (1) The
  **third off-surface list was never rendered** — `unreadableByPosition` was
  declared and test-enforced from slice 5 but invisible on screen, which on the
  cashier tab would have hidden the single most useful sentence on it. All three
  lists now render with distinct badges and a line explaining that they are three
  claims about three different readers. (2) `formatCell` collapses an embedded
  object to its `title`/`name` key, so a multi-column embed silently drops columns
  from the screen while still being declared; the salon embeds use PostgREST column
  aliasing (`name:full_name`) so the declaration lists exactly what renders.

  **Verification:** typecheck 9/9; RLS suite **90/90** (was 82, +8 salon-specific,
  including the keystone asserted as a real non-org-admin MANAGER, since alice owns
  demo-salon and every read of hers would otherwise short-circuit through
  `is_org_admin` and prove nothing about the position, and stated as "wherever a table HAS
  rows the manager reads them", with alice as the control — an error-is-null check would
  have passed on every table RLS emptied); **36/36 live probes** with
  **zero skips** (was 21/21 at slice 5 — +15 assertions: seven more edge-mirror cases, a
  six-check two-store scope-intersection probe, and a two-check unauthenticated fetch); 2 new
  e2e tests, green in each of THREE clean-seed full runs — every one of which also lost ONE
  UNRELATED test to the local dev-server navigation flake, a different test each time and each
  passing in isolation. That moving target is what proved it environmental rather than a set of
  test bugs, and it is what the 2026-08-05 follow-up fixed at the harness level.
  **ALL SIX tables behind the seven "cannot read" claims HAD zero rows on a clean seed** (the
  seventh claim is `sal_earnings_ledger` a second time, on the other surface), so fixtures were
  built for every one — without them each assertion would have passed on an empty universe
  (docs/03's vacuity rule). The seed gained those rows on 2026-08-05; the fixtures stay, so the
  assertions never depend on the seed keeping them.

  **What the review did NOT close, recorded rather than implied:** the twelve-table
  accounting is HAND-checked — `viewAsCompleteness()` only refuses a table appearing in two
  lists, never enumerates the module's real tables, and never inspects `embed`, so a future
  `sal_tips` migration would leave all three surfaces silently incomplete with CI green. The
  fix that exists in the repo already is the data browser's `pg_catalog` coverage test
  (docs/03 #19); switching on the analogue is platform-wide work, because classroom's
  surfaces do not classify every `cls_` table. **Of the three gaps this entry recorded, only
  that one is still open** — the other two were closed the next day (see the 2026-08-05 entry):
  `ExcludedFromSurface.columns` was unusable and has been DELETED (the overlap check forbids one
  table in both `role` and `excluded`, so every column-level exclusion is a caveat, and
  `excluded: []` means "no whole table is withheld", not "nothing is withheld"); and the
  **Manager tab had never been rendered in a browser** for want of a seeded salon admin — it was
  verified at the data layer here, all 11 sections, as a temporarily self-granted admin, and is
  now rendered by a real e2e as the seeded admin.

- **2026-08-03 (PER-PERSON DATA BROWSER BUILT — the first half of docs/13's Owner
  Console pair; Opus session, two Fable adversarial reviews):** `/console/data-browser`,
  superadmin-only, answering *"what do I hold about this person?"* — every row the
  VIEWER may read that names the subject. Rules → docs/03 **#19**.

  **ZERO MIGRATIONS, and that is the design, not a shortcut.** Three things could have
  forced SQL and all were already open: `is_org_admin()` short-circuits on
  `is_superadmin()` so a superadmin's own client reaches every org; `profiles_select_own`
  carries an `is_superadmin()` arm so the person picker works; `module_roles_select_member`
  likewise. So the feature is presentation over the caller's own RLS client — the same
  keystone as slice 5, and the reason a god-mode surface needed no new read path.

  **The security argument, stated so it can be attacked later.** Every query the page
  issues is one the caller could already issue against PostgREST as themselves.
  Therefore bypassing `requireSuperadmin()` grants nothing, and the gate does not need
  to be a security boundary. This does NOT contradict docs/03 #18's "the app layer is
  not a gate" — that rule was about view-as, where starting a session was a real
  PostgREST-reachable WRITE. **The invariant it rests on: no `.rpc()` and no
  service-role client on this path, ever.** One definer call and the app gate silently
  becomes the only thing between a user and data RLS would have refused. Source-scanned
  by `scripts/verify-data-browser.mts` probe [6]. Both reviewers attacked this claim
  directly — `.or()` injection from the URL param, existence leaks through the
  two-step `via` resolution, cross-org bleed through an unfiltered child lookup — and
  neither could break it.

  **The honesty problem this feature has and view-as does not.** Its failure mode is
  UNDER-reporting, and an incomplete answer looks exactly like a complete one. Hence
  three decisions: `select *` rather than an allow-list (founder, 2026-08-03 — the tool
  exists to be complete, and RLS is row-level anyway, so a UI allow-list would be
  comfort not protection); a catalog-driven completeness check that fails CI on any
  undeclared person column; and a `neverReadable` list so `sd_notes` is reported as
  *"rows nobody may read"* rather than rendering as *"nothing here"*.

  **What the two reviews found — the useful part.** No ship-blocker on the security
  claim. One ship-blocker on the honesty claim: **`sal_bills` has no customer column at
  all**, so the path to a paying customer is two hops
  (`bills.appointment_id -> appointments.customer_id -> customers.user_id`) and the
  single-hop `via` could not express it — a real customer WITH an account saw their
  appointments and zero bills. Fixed with `PersonVia.then`, live-probed. Distinct from
  the documented walk-in gap, which is about people with no account at all. Also fixed:
  module selection filtered on `enabled = true`, so **disabling a module hid its entire
  history at exactly the moment someone opened this tool to decide what to export before
  deprecating it** (docs/03's own deprecation flow starts with disabling); a `via`
  lookup that swallowed its error, turning "we could not check" into a silent "no rows"
  for precisely the via-only tables that hold the sensitive data; an uncapped
  intermediate hop; and a confidently wrong note claiming `mm_can_manage` reads
  `mm_answers` when that table has no admin arm at all (the gate is a matchmaker
  ASSIGNMENT). That last one is the second instance of the mistake docs/15's 2026-08-02
  entry records — **a note asserting who can read something is a factual claim and must
  be checked against the policy, not reasoned from rank.**

  **`neverReadable` moved into the CI suite, not just the probe script.** Review 1's
  sharpest structural point: `scripts/*.mts` are not run by CI, so the only automated
  check on a claim the UI states as fact was that the entry was well-FORMED. A migration
  adding `or is_superadmin()` to `sd_notes_all_own` would have left everything green.
  `rls.test.ts` now builds a real note as its author and asserts staff and the
  superadmin both get nothing — and a declared table with no fixture recipe FAILS rather
  than being skipped, so the next entry cannot ship unprovable.

  **Self-caught while building, worth recording because both are repeatable traps:**
  the catalog query must use `pg_catalog`, not `information_schema` —
  `constraint_column_usage` does not expose constraints targeting the `auth` schema, so
  the information_schema form returns ZERO rows and the check passes vacuously (it did,
  on the first run). And the coverage check's own second tier initially excluded
  self-referential FKs as noise, which immediately hid
  `sd_participants.mentee_participant_id`, a genuine person link.

  **Verification:** typecheck 9/9, db suite **82/82** (77 → +4 coverage, +1
  neverReadable), **22/22 live probes** with zero skips
  (`scripts/verify-data-browser.mts`), 2 new e2e as real users, full clean-seed e2e
  suite green. **Not done, deliberately:** the Owner Console view-as half (next,
  founder-sequenced); walk-in salon customers; scope-narrowing org-admin reads of the
  session log (parked in docs/13).

  **Unrelated fix that rode along:** the matchmaking e2e test had been failing ~40% of
  the time on a fresh seed and 100% on a dirty one. Confirmed pre-existing by stashing
  all new work and reproducing on clean `master`. Diagnosed rather than patched blind:
  the database state captured immediately after a failure was IDENTICAL TO THE SEED, so
  the withdraw had always succeeded and the failure was the server-action re-render not
  landing inside the 5s `expect` default. Fixed with `test.slow()` plus a 20s timeout on
  that one assertion; 5/5 fresh-seed runs green after. Note `test.slow()` alone would
  NOT have been enough — it raises the TEST timeout, not the `expect` timeout, which is
  what was actually expiring.

- **2026-08-02 (TERMINOLOGY — say "view-as", not "impersonation"; founder):** Mode 2
  is **READ-ONLY** (§8.1 point 2) and always has been: the viewer sees the target's
  surface, cannot write anything, cannot act on their behalf, and no row anywhere
  can carry an identity column naming someone other than the true actor. Founder,
  2026-08-02: "they are viewing, not impersonating" — the word overstates the
  capability and should stop being used for it. §8/§8.1's original wording is left
  as written (it is the spec's history), but all slice-5 CODE and comments were
  reworded, `mayImpersonatePosition()` is now `mayViewAsPerson()`, and future
  entries should follow. Where a distinction is needed, say **mode 1** ("as if I
  held that position") and **mode 2** ("view as a named person"), both read-only.

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
