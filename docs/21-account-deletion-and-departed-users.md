# Account deletion and departed users — what survives a person leaving

**Status: PLAN, updated 2026-09-11. NOT BUILT. READ §7 FIRST — the founder's SILHOUETTE
model supersedes §3's mechanism and most of §4's classification. Older text: the
per-column classification in §4 is proposed and needs sign-off.**

Found while fixing the seat-authority class (docs/19). Not urgent — **there is no
account-deletion feature today**, so none of this is live. It becomes urgent the
first time anyone honours the deletion promise `/privacy` already makes.

---

## 1. The problem, measured

**42 foreign keys point at `auth.users` with `ON DELETE CASCADE`** (verified live,
`pg_constraint.confdeltype = 'c'`). Deleting one user therefore erases, among
other things:

- **Peer-review comments they wrote on OTHER students' work**
  (`cls_review_comments.author_id`) — the other student loses their feedback.
- **Their abuse reports** (`vm_flags.reporter_user_id`) and **safety notes they
  wrote about other people** (`sd_notes.author_user_id`).
- **Their drawings AND every reply anyone drew underneath them** —
  `vm_layers.author_id` cascades, and `vm_layers.parent_layer_id` cascades too,
  so the deletion propagates down the whole subtree. Delete a conversation's
  creator and the ROOT layer goes, taking the entire thread; the surviving
  `vm_conversations` row then has zero layers and the page's `if (!root)
  notFound()` gives **the other party a bare 404 on their own conversation**.
- Grades, submissions and exam papers.

**The shape worth naming: the records that exist to protect people are the ones
that vanish.** An abuse report, a safety note, and a peer review are all *about*
someone other than the author.

There is no product deletion flow at all — `deleteUser` appears only in
`packages/db/src/rls.test.ts`. So today this runs as a manual
`auth.admin.deleteUser` call, and nothing warns the operator.

---

## 2. FOUNDER DECISION (2026-09-10)

> **Keep everything that affects other users. Keep the person as a record too,
> marked as departed.**

Founder's words: *"I think we need to hold onto all data impacting other users -
right? And maybe even keep track of the user but have them marked as departed?"*

**This matches what every comparable platform does**, which is worth recording so
it is not re-litigated:

| Platform | On account deletion |
|---|---|
| Reddit | posts and comments remain; author becomes `[deleted]` |
| GitHub | commits remain, reattributed to the `ghost` account |
| Slack / Discord | messages remain; the name renders as a deactivated user |
| WhatsApp | anything already delivered stays on the recipient's device |

The common rule: **content stops being purely yours once it is part of someone
else's record.** Erasing a peer review does not restore the author's privacy; it
damages the recipient's history. The legal posture agrees — the right to erasure
is balanced against others' rights, and anonymisation is the accepted way to
honour both.

---

## 3. The mechanism

Three parts, none individually hard:

1. **`ON DELETE SET NULL` instead of CASCADE**, per column, for everything in
   §4's KEEP list. Each such column must first be made **nullable** — most are
   `NOT NULL` today (`vm_layers.author_id` is, verified).
2. **A "departed" rendering** wherever a name is shown. Today the fallback chain
   in visual messaging is `display_name || email || 'Someone'`
   (`modules/visual-messaging/ui/conversations/[conversationId]/page.tsx:163`),
   so a detached author silently reads as **"Someone"** — indistinguishable from
   a user who simply has no display name. That is an honesty failure of exactly
   the kind the module spec already forbids elsewhere. It needs a distinct label.
3. **A real deletion path**, so the operator is not running raw admin calls. Out
   of scope for the first pass, but the SET NULL work is worthless without
   *someone* triggering it correctly.

### The trap to avoid

**Do not do this as a sweep.** Some cascades are correct and removing them would
be worse than leaving them. The per-column judgement in §4 is the work.

---

## 4. PROPOSED CLASSIFICATION — needs founder sign-off

### KEEP (change to SET NULL, make nullable, render as departed)

| Column | Why |
|---|---|
| `vm_layers.author_id` | **Already founder-decided.** Others replied underneath; the subtree cascade makes this the worst one. |
| `cls_review_comments.author_id` | Feedback on another student's work — theirs, not the author's. |
| `vm_flags.reporter_user_id` | An abuse report is a record of an incident. |
| `sd_notes.author_user_id` | A safety note written *about someone else*. |
| `cls_submissions.student_id` | Graded work; peer reviews and grades reference it. Also: deleting the row **orphans the file in storage**, which no FK reaches. |
| `cls_grades.student_id` | Part of the class's academic record. |
| `cls_exam_papers.student_id` | Same. |
| `cls_review_assignments.reviewer_id` | The record that a review was assigned and by whom. |
| `smp_items.author_id` | Sample module; low stakes, included for consistency. |

### CASCADE IS CORRECT (leave alone)

| Column | Why |
|---|---|
| `mm_pair_scores.user_a` / `user_b` | Derived and recomputable; meaningless without both people. |
| `mm_answers.user_id` | Their own intimate questionnaire. Deleting is the *right* privacy answer. |
| `mm_interests.*` | An expression of interest is personal and one-sided. |
| `login_events`, `login_rollup`, `activity_events`, `activity_rollup` | Analytics **about** the departing person. Deleting is both correct and GDPR-friendly. |
| `org_members`, `module_roles`, and every seat/roster row | Membership, not content. Their removal is the *point* of deletion. |
| `sd_blocks.*`, `sd_bans.banned_user_id` | Moot once either party is gone. |
| `profiles.user_id` | The identity row itself. |

### NEEDS A DECISION — genuinely ambiguous

| Column | The question |
|---|---|
| `sd_notes.about_user_id` | A safety note *about* the departing person. Keeping it preserves an incident record about someone who no longer exists; deleting it erases the only account of what happened. **Which wins?** |
| `sd_participants.user_id` | Cascading removes the participant row, which cascades their **pairings** — and a pairing is shared with the other person, whose own match record then loses its counterparty. |
| `mm_matchmaker_assignments.*` | The record that a matchmaker was assigned. Audit value vs. noise. |

---

## 5. FORESEEABLE ISSUES

1. **`NOT NULL` removal is a real schema change on live tables**, not a policy
   swap. Each needs its column made nullable and its FK dropped/recreated —
   forward-only, but heavier than docs/19's one-line conjuncts.
2. **Every policy and definer that compares the column to `auth.uid()` must be
   re-read.** `author_id = auth.uid()` simply stops matching when the value is
   NULL, which is the correct outcome (nobody owns an orphaned row) — but it
   must be *confirmed* per policy, not assumed.
3. **The data browser declares several of these as person columns**
   (`packages/platform/src/data-browser-modules.ts`). A nullable person column
   may change what its TIER 1 catalog check expects.
4. **Storage objects have no FK.** Deleting `cls_submissions` orphans the real
   file in the `cls-submissions` bucket. If those rows now survive, the files
   survive with them — which is the intent, but it means retention of a departed
   person's *files*, which the privacy copy must not contradict.
5. **A FOURTH owed privacy line.** docs/12 item 6 already tracks three. "What we
   keep after you delete your account, and why" is a new claim and a
   user-visible one. It should land with this work, not after it.
6. **`ON DELETE SET NULL` fires BEFORE UPDATE triggers** (a documented platform
   gotcha — Postgres implements the FK action as a real UPDATE). Any table with
   a pin trigger or an append-only guard must be checked, or the parent DELETE
   will abort. `vm_layers` has `vm_layers_before_write`; that interaction must be
   tested, not assumed.

---

## 6. SEQUENCING

Do **not** start this before docs/19's follow-ups settle — it touches the same
module tables. Suggested order:

1. `vm_layers.author_id` alone, as the worked example (founder already decided
   it, and it is the worst case because of the subtree cascade).
2. The rest of the KEEP list, once §4 is signed off.
3. The deletion flow itself, and the privacy line, together.

Opus tier, full docs/03 #12 rhythm — schema change + FK actions + trigger
interaction.

---

# 7. FOUNDER DECISIONS, 2026-09-11 — the SILHOUETTE model supersedes §3 and §4

The founder replaced the mechanism in §3 and most of the classification in §4 with
a cleaner organising rule. **Where this section and §3/§4 disagree, this section
wins;** §4's table survives only as the worked mapping in §7.3.

## 7.1 The rule

> **Deletion detaches the person but leaves a silhouette. The silhouette keeps
> anything a HUMAN did that touched someone else. Anything an AUTOMATED process
> derived is deleted.**

Founder's words: *"if an automated process created a match then delete it but if a
human did a pairing or any other human action impacting their profile (like
writing a layer on top of theirs) then we keep that attached to their detached
profile silhouette."*

**This is a better line than §4's "affects others / derived" split**, because it is
decidable without a judgement call: *did a person do this, or did code infer it?*
It also resolves two of §4's three "needs a decision" rows outright (§7.3).

Named consequences the founder specified:

- Keep **content other users relied on** — e.g. a `vm_layers` row somebody
  replied underneath.
- Keep **safety notes about them OR from them** (both directions).
- Keep **assignments made by humans**.
- **Automated matches are deleted** — but where a live counterparty can currently
  see one, it does not vanish silently: it shows a **temporary "this person left"
  state for the length of the grace period**, then disappears.

## 7.2 TWO STATES, NOT ONE — grace period (founder: "Grace period sounds right")

Every comparable platform separates a reversible state from an irreversible one,
and most real cases are the reversible one:

| | Reversible | Irreversible |
|---|---|---|
| Facebook / Instagram | 30 days, full restore | permanent |
| Google | ~20 days, full restore | permanent |
| Slack | deactivate — history intact | a separate operation |
| Reddit / GitHub | — | permanent; content orphaned to `[deleted]` / `ghost` |

**Nobody reconnects an identity after true deletion** — the link is destroyed by
design, and restoring it would break the promise deletion made. Someone returning
later is a new person; their old content stays with the silhouette.

So the platform needs **departed (reversible, identity intact, grace period
running)** and **deleted (irreversible, silhouette only)**.

## 7.3 What the rule decides, applied to §4's open rows

| §4 row | Human or automated? | Verdict |
|---|---|---|
| `sd_notes.about_user_id` | a human wrote a safety note | **KEEP** — founder said both directions. §4's open question is CLOSED. |
| `mm_matchmaker_assignments` | a human matchmaker was assigned | **KEEP.** §4's open question is CLOSED. |
| `sd_participants` → `sd_pairings` | the orchestrator pairs automatically | **pairing: DELETE.** But `sd_interest` is a human "yes" and `sd_matches` derives from two of them — see the one remaining question in §7.6. |

Everything else in §4 maps cleanly: `vm_layers`, `cls_review_comments`,
`vm_flags`, `sd_notes.author_user_id`, `cls_submissions`, `cls_grades`,
`cls_exam_papers`, `cls_review_assignments` are all human acts → KEEP;
`mm_pair_scores`, `login_events`, `login_rollup`, `activity_events`,
`activity_rollup` are machine-derived → DELETE.

## 7.4 THE MECHANISM CHANGES — §3's FK surgery is mostly unnecessary

§3 proposed flipping ~10 FKs to `ON DELETE SET NULL` and making each column
nullable. **The silhouette model removes nearly all of that work**, because the
cascade only fires if the `auth.users` row is deleted — and under this model it
never is.

Deletion becomes:

1. **Scrub the identity, keep the row.** Blank `profiles.display_name`; replace
   `profiles.email` and the GoTrue `auth.users.email` with a tombstone value; set
   a `departed_at` / `deleted_at` marker.
2. **Ban the auth account** so it can never be signed into.
3. **Revoke every membership** — `org_members`, `module_roles`.
4. **Delete the machine-derived rows** (§7.3's DELETE column).
5. Everything else keeps pointing at a real, now-anonymous row. **Zero FK
   changes, zero nullable-column migrations.**

**⚠ CORRECTION 2026-09-11 — STEP 3 IS NOT SUFFICIENT YET, AND THE PARAGRAPH BELOW
OVERSTATED IT.** Revoking memberships makes inert only the seats whose predicates
were actually fixed. **Four known predicates are still bare** (docs/19's
2026-09-11 section): `cls_review_assignments_update_reviewer`,
`mm_assignments_select`'s `matchmaker_id` arm, `cls_review_assignments_select`,
and `sd_participants_update_self` / `cls_set_preferred_name`. **So a silhouette
built on step 3 alone would still be able to WRITE a peer grade onto a live
student's work** — the worst of the four, because it is a write. Step 3 becomes
genuinely sufficient only once docs/19's module-role slice lands, which includes
those four. **Do not build the silhouette before it, or sequence it so that step
3 is verified against the four as well.** The original claim, kept below because
its *direction* is right:

**THE SEAT-AUTHORITY FIX SHIPPED 2026-09-10 IS WHAT MAKES STEP 3 SUFFICIENT.**
Before `20260910040000`, revoking memberships left every module seat still
granting access, so a silhouette would have retained full module access forever.
Now, removing the memberships makes every seat inert automatically. The two pieces
of work compose — worth knowing, because it is not obvious from either alone.

**This is also the standard anonymisation posture** for the right to erasure:
personal data is destroyed, the record that other people rely on survives without
identifying anyone.

## 7.5 What the silhouette must render

A silhouette is **a different kind of user, deliberately visible as such.** Today
the visual-messaging fallback chain is `display_name || email || 'Someone'`
(`modules/visual-messaging/ui/conversations/[conversationId]/page.tsx:163`), so a
blanked profile renders as **"Someone"** — indistinguishable from a live user who
simply never set a name. That is the honesty failure this platform's specs already
forbid elsewhere, and it must be a distinct label ("Former member", greyed, no
profile link).

The grace-period state needs its own rendering too: an automated match whose
counterparty has departed shows *"this person left the platform"* until the grace
period expires, then the row goes.

## 7.6 THE ONE QUESTION LEFT

**`sd_interest` and `sd_matches` when a participant is deleted.** The pairing that
put them in a room was automated (delete it). But the *interest* was a human "yes",
and the *match* exists because two humans both said yes. Options:

- **(a)** Treat the match as human (both people chose) → keep it, attached to the
  silhouette, with the departed rendering. The other person keeps the record that
  they matched with someone.
- **(b)** Treat it as automated (the trigger created the row) → delete after the
  grace period, per §7.1's automated-match rule.

The founder's own wording points at **(b)** for the *visible* match ("a temporary
message that the user left... after which the match disappears"), but (a) is
arguable for the underlying `sd_interest` row, which is a record of what a person
actually did. **Unresolved.**

## 7.7 §7.6 IS CLOSED (founder, 2026-09-11) — and it opens one new product item

**DECISION: KEEP the interest and the match. Move them to an archive section,
with a reason. For a departed person the reason is "the user left / was
removed".**

Founder's reasoning, and it is the honesty argument this platform already applies
elsewhere: *"If they can never reconnect their profile then it should disappear —
but it's a problem, since the person saying yes who is still around might wonder
what happened to her prince charming."* A match that silently vanishes is worse
than one that is labelled. Same family as the module-4 spec's four-state invite
rendering and the view-as `emptyReason` work: **an absence with no explanation is
the one answer a surface must never give.**

It is also consistent with §7.1 without needing an exception — a mutual match
exists because **two humans each said yes**, so it is a human act and the rule
already says keep it.

**Consequence for §7.1's automated-match wording:** the "temporary message, then
the match disappears" phrasing is refined rather than reversed. The match does not
disappear — it *moves*, and the grace-period message is what carries it there.

### THE NEW ITEM, and a collision it must not walk into

The founder also sketched a larger surface: *"perhaps there is a section
displayed of those matches that were tried but didn't work, and maybe that
includes the feedback of the user as to why they turned it down. Such a section
needs to be hashed out."*

**Recorded as a NEW, unspecified product item — not part of the deletion work.**
The departed-user case needs only a single archive row with the reason "left the
platform"; the broader feature is its own design.

**AND IT COLLIDES HEAD-ON WITH A DELIBERATE, SECURITY-REVIEWED PROPERTY.**
docs/modules/module-6-speed-dating.md:71 records, as one of nine hand-reviewed
guards: *"RLS hides unrevealed matches from both parties; **a rejected side is
indistinguishable from an undecided one**."* Matchmaking's `mm_mutual_matches()`
and Redt-It's entire premise rest on the same gating.

So:

- **"This person left the platform"** is NOT a rejection signal and creates no
  conflict. It can ship with the deletion work.
- **"Here is why they turned you down"** REVERSES that guard. It would tell a
  participant both that they were rejected *and* why — precisely the disclosure
  three modules were built to prevent. That is a founder decision with real
  product consequences (it changes what people risk by saying no), not an
  implementation detail, and it must not be absorbed into the archive section by
  accident.

**If the archive is built, the safe default is: show the OUTCOME, never the
counterparty's reason** — unless the founder decides deliberately, in writing,
to reverse the reveal guard. Belongs as a dated entry in the module-6 and
module-1 specs when it is hashed out.

## 7.8 REFINEMENT (founder, 2026-09-11) — departure is disclosed ONLY when it is the ACTUAL blocking cause

§7.7's safe default is tightened. The founder: *"The person leaving is not a
rejection. And if they were turned down by the current user then that is the
stated reason, and their leaving the platform should not be disclosed. It's only
in the scenario where they might wonder why is there no next step, and the
natural next step is prevented by their leaving the platform, that this info is
shown to the current user."*

**The rule:**

| The viewer's own state | What the archive row says |
|---|---|
| **I declined them** | "You declined." **Nothing about their account.** The outcome is already explained by the viewer's own action. |
| **I said yes and was waiting** | "This person left the platform." The departure IS the reason the next step never came. |

**Why this is right on two counts, not one:**

1. **Information minimisation.** A viewer who declined someone has their answer.
   Telling them that person later left the platform discloses that person's
   account status for no reason the viewer needs — and, aggregated over many
   declines, leaks who is leaving.
2. **It preserves the reveal guard exactly** (module-6:71, "a rejected side is
   indistinguishable from an undecided one"). A viewer who said yes was awaiting
   a reveal either way, so "they left" explains the silence **without revealing
   whether the other person had said yes or no.** The guard survives untouched.

### THE IMPLEMENTATION TRAP — do not let "departed" become a FALSE explanation

Departure must only be given as the cause **when it actually is the cause.** If
the outcome was already determined before the person left — the viewer declined,
or the counterparty declined and no match row was ever created — then the state
is already settled and departure is not what blocked it.

Attributing it to departure in that case is wrong twice: it **misstates the
cause**, and it **discloses an account status** that nothing required. The same
"an absence needs the RIGHT explanation, not just an explanation" discipline the
platform already applies to its four-state invite rendering and the view-as
`emptyReason` work.

→ The archive's reason column must be derived from **what actually blocked the
next step**, never from "is this person departed?" as a standalone test.
