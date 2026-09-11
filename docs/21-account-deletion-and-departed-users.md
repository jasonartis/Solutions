# Account deletion and departed users — what survives a person leaving

**Status: PLAN, 2026-09-10. NOT BUILT. One founder decision is made (§2); the
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
