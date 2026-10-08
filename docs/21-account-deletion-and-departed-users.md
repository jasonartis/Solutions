# Account deletion and departed users — what survives a person leaving

**Status: BUILT, ON PRODUCTION AND PROD-VERIFIED 2026-10-08 — migration `20261007090000`, read
§7.10 for what exists and what is still owed.** `scripts/prod-verify-account-deletion.mts` on
prod: 3 controls pass / 29 fail pre-apply → **85/0 post-apply**. The one check still pending is
§[6], whether pg_cron has actually run the job — it can only pass from 2026-10-09 03:17 UTC.
The design below is unchanged.

**Previous status: FULLY DECIDED, NOT BUILT (2026-10-07). READ §7 FIRST, then §7.9.** The founder's
SILHOUETTE model (§7, 2026-09-11) supersedes §3's mechanism and §4's classification — **§4's
"needs sign-off" rows are all CLOSED by §7.3/§7.7**, and the last three product questions were
answered 2026-10-07 (§7.9). Nothing here waits on the founder; it is ready to build (Opus).
*(Before 2026-10-07 this header still said §4 "needs sign-off", which sent a session to report
the work as blocked when it was not. A header is a claim like any other: re-read it when the
body below it moves.)*

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

## 7.9 THE LAST THREE QUESTIONS — ANSWERED (founder, 2026-10-07: "defaults")

Asked as scenarios with prior-art defaults; the founder took all three defaults.

1. **Who starts a deletion: BOTH.** A self-serve **"Delete my account"** on `/account` with a
   typed confirmation (every major platform does this), AND the superadmin can start it from
   the Owner Console for an emailed request (`/privacy` says "on request", which both satisfy).
2. **Grace period: 30 DAYS** (Facebook/Instagram; Google is ~20).
3. **Signing back in during the grace period CANCELS the deletion** (Facebook's behaviour; it
   is the point of a reversible state). After 30 days the silhouette step (§7.4) is
   irreversible and nothing reconnects the identity (§7.2).

**AN OPEN BUILD QUESTION, NOT A FOUNDER ONE — WHAT RUNS THE 30-DAY EXPIRY ON PROD?** Production
has **no continuously-running worker** (CLAUDE.md: pg-boss jobs fire only while
`pnpm worker:prod` runs on the founder's PC — the same reason docs/17's retention prunes and
the zmanim sweep do not run there). So a pg-boss cron that converts "departed" to "deleted"
after 30 days would silently never fire, and "signing back in cancels" would be the only
transition that ever happens. Decide the runner first (e.g. a check performed lazily on
sign-in/read, a Vercel cron hitting a guarded route, or making the departed→deleted step
idempotent and range-based like docs/17's pruner so a late run catches up) — and **say in the
privacy copy what is actually true** about when deletion completes.

**Still owed with the build, not a decision:** the fourth `/privacy` line — "what we keep after
you delete your account, and why" (§5 item 5) — and the "Former member" rendering (§7.5).
**Re-check before building:** §7.4's correction lists four bare predicates that made step 3
insufficient. docs/19's module-role slice (`20260915010000`) has since closed
`cls_review_assignments_update_reviewer` and `mm_assignments_select`'s matchmaker arm;
`sd_participants_update_self` was already unreachable; **`cls_set_preferred_name`'s
unenrolled-student half is still open (CLAUDE.md)** — verify each against the live catalog,
don't trust this list. Under the silhouette model `auth.users` is never deleted, so the two
deletion landmines (docs/20 §30: org delete — since fixed by `20260928010000` — and a
conversation creator's `vm_pin_conversation`) are not on this path; confirm that too.

## 7.10 BUILT (2026-10-07, Opus) — what exists, how expiry runs, what was decided in the build

Migration `20261007090000_account_deletion.sql`; tests `packages/db/src/account-deletion.test.ts`
(11, throwaway accounts only) + two e2e; prod verifier `scripts/prod-verify-account-deletion.mts`.

### How it works

| Step | What happens | Where |
|---|---|---|
| Request (self) | `/account` → "Delete my account", typed confirmation = your own email, checked **in SQL**. | `account_request_deletion` |
| Request (superadmin) | `/console/accounts` → email address. Resolved inside the function; no new lookup exposed. | `account_request_deletion_for_email` |
| Either request | Refused if you are a superadmin, the only active owner/admin of an org, or the only Director (rank ≥ 4) of a module. Otherwise: row `departed`, `due_at = now + 30 days`, **every session deleted** (signed out everywhere). | `account_begin_departure` |
| Grace period | Nothing else changes. Others see you normally — except a speed-dating match (below). | — |
| Sign back in | **Cancels.** Derived, not triggered: a departure is live only while `auth.users.last_sign_in_at <= requested_at`. The dashboard records it (`account_deletion_resume`) and says so. | `account_pending_departure` |
| Superadmin cancel | For a request made in error. | `account_cancel_deletion` |
| Day 30 | The **silhouette** (classification below), then `deleted`. A refusal (e.g. became sole admin during grace) leaves the row `departed` with `last_error`, shown on the console and retried daily. | `account_complete_due_deletions` → `account_silhouette` |

**Why no trigger on `auth.users`:** a new trigger there sits on the critical path of every
sign-in (docs/03 "Triggers on auth.users"). Deriving the cancel from GoTrue's own
`last_sign_in_at` cannot break sign-in and cannot drift from GoTrue. Deleting the sessions at
request time is what makes "signed in since" mean a real new sign-in — a surviving refresh
token would otherwise keep someone using the app for 30 days and then delete them mid-use. An
access token already issued stays valid for its hour, and cannot cancel (tested).

### WHAT RUNS THE 30-DAY EXPIRY ON PROD — §7.9's open build question, answered

**`pg_cron`, inside the database**, job `account-deletions-complete-due`, daily 03:17 UTC, as
`postgres`. Measured on prod before building: pg_cron 1.6.4 available, `cron.database_name =
postgres`. Not pg-boss, because prod has no always-on worker and a pg-boss cron would silently
never fire. A deliberate exception to docs/03 hard rule 5, recorded there. The job is
idempotent and range-based, so a missed day is caught up. **Honesty badge:**
`/console/accounts` reads `cron.job_run_details` and says plainly if the job is unscheduled,
off, failing, never run, or more than two days quiet. The completion function **refuses any
caller with a session** — run with a JWT, `sd_pin_participant` would silently revert the
participant scrub, so there is exactly one caller context.

**What the privacy copy says, and why it is true:** deletion completes 30 days after the
request, by the daily job. It is not instant, and the copy does not claim it is.

### The classification (§7.1's rule applied to every table that names a person)

| Verdict | Tables |
|---|---|
| **REVOKE** (membership) | `org_members`, `module_roles`, `mm_group_members` (the pool — left in place, the rescore job would keep pairing a silhouette) |
| **DELETE** (machine-derived) | `login_events`, `login_rollup`, `activity_events`, `activity_rollup`, `mm_pair_scores`, `sd_pairings` *except* one a safety note or report points at |
| **DELETE** (personal, touches nobody) | `mm_answers` |
| **SCRUB** (copies of identity) | `profiles.display_name`, `user_private.settings`/`is_superadmin`, `cls_class_members` preferred names, `sal_worker_profiles.display_name` (+ `active=false`), `sd_participants.profile`/`profile_card` (+ withdrawn from events not yet complete), the person's key in `sd_matches.contact_shared`, `sal_customers.user_id` → NULL |
| **AUTH** | `email`, `phone` NULL (the address is free for a fresh signup — §7.2); password blanked; metadata emptied; banned 100 years; identities, sessions, MFA, one-time tokens, webauthn, OAuth consents, flow state and GoTrue audit rows deleted. Token columns deliberately **not** NULLed — GoTrue scans some as plain strings. GoTrue still loads the row (tested). |
| **KEEP** | every human act that touched someone else: `vm_layers`, `vm_reactions`, `vm_flags`, `cls_review_comments`, `cls_review_assignments`, `cls_submissions`, `cls_grades`, `cls_exam_papers`, `cls_survey_answers`, `sd_notes` (both directions), `sd_reports`, `sd_interest`, `sd_matches`, `sd_blocks`, `sd_bans`, `mm_interests`, `mm_matchmaker_assignments`, seats/rosters (inert — every seat predicate also requires org membership, docs/19), audit logs, uploaded files |

**The §7.9 re-check, against the live catalog:** `cls_set_preferred_name` (the half still
recorded as open) requires `is_org_member(c.org_id)` in its deployed body, so it is a no-op for
a silhouette, which has no membership — and a silhouette also has no session to call it with.
The two docs/20 §30 landmines are **off this path**: `auth.users` is never deleted, so no FK
cascade or SET NULL fires (`vm_pin_conversation` never sees one), and the org-member revocation
is a direct delete that `org_members_guard_last_admin` would refuse — which is why sole admins
are refused up front.

### Rendering (§7.5, §7.7, §7.8)

- **"Former member"** — `former_members(ids)` + `packages/platform/src/former-members.ts`, wired
  into visual messaging (layer authors and flag reporters), classroom (grading, exams, roster),
  matchmaking mutual matches, speed dating (event page, my-blocks list) and nail-salon workers.
  Needed because a silhouette has no membership, so co-members can no longer read its
  `profiles` row and every page would otherwise print "Someone".
- **Speed-dating archive** — `sd_my_departed_matches(event)` returns the caller's own
  **revealed** matches whose counterparty has left (grace period or deleted). A match row
  exists only when both said yes, so a person the viewer declined, or who declined the viewer,
  is never reported as having left. The reveal guard is untouched.

### Adversarial review (three narrow reviewers, 2026-10-07) — findings and what was done

1. **`former_members` was an oracle** (any uuid → "is this a deleted account?"), reachable by
   someone who had *declined* the person. **Fixed:** the row records `former_org_ids` at
   deletion, and the function answers only to an active member of one of those orgs. Tested
   with a non-co-member control.
2. **Two co-admins could both leave**, each passing because the other was still active, and
   the second would be wedged as sole admin forever. **Fixed:** an admin who is themselves in a
   grace period does not count as the one who stays. Tested with its control.
3. **Gaps in the scrub** — GoTrue audit rows, webauthn/OAuth/flow tables, `phone_change`, and
   no sole-Director check. **Fixed** (version-dependent auth tables are guarded by
   `to_regclass`, so a Supabase upgrade cannot make every silhouette fail).
4. Confirmed sound: no API role can start, cancel or complete someone else's deletion; the
   `sd_pin_participant` no-session bypass is reachable only by trusted backends; nothing
   cascades into another person's records; `sd_my_departed_matches` matches the match policy.

### JUDGEMENT CALLS MADE IN THE BUILD — the founder may want to overrule any of these

- **A salon's customer card survives, unlinked** (`sal_customers.user_id` → NULL; name and
  phone kept). **REVIEWED AND CONFIRMED 2026-10-08** (prior-art research + one adversarial
  reviewer; founder agreed). The card is the salon's own business record: under GDPR the salon
  is the controller and the platform its processor (Art. 28), so the erasure duty is the
  salon's, and a processor that deletes a controller's records unasked is itself in breach.
  Square, Fresha, Booksy, Vagaro, Stripe and Shopify all work this way: deleting the consumer
  account leaves the business's copy, and the person is sent to the business. **OpenTable is
  the one exception** — it claims diner data as its own and makes restaurants delete it. *(An
  earlier version of this bullet cited OpenTable as SUPPORT for keeping the card. That was
  backwards.)* Scrubbing would not help either: deleting the card cascades away the salon's
  appointments, bills and earnings, and `full_name` is NOT NULL, so a scrub means a placeholder
  name across the salon's screens.
  **Changed as a result:** `/privacy` now tells the person to ask the organization, and that
  the platform will help it act on the request (Art. 28(3)(e)).
  **PARKED, ONE SHARED TRIGGER — the first REAL customer card linked to a REAL account.**
  Measured 2026-10-08: prod holds 1 card, the demo seed's, and 0 linked cards in any real org;
  no app path writes `user_id`, `phone`, `email` or `notes` (walk-in add writes `full_name`
  only). When that trigger fires, build:
  1. **An erase-customer action for salon admins** (Square's Buyer Request Portal is the
     model): clear name/phone/email/notes, keep appointments and bills for accounting.
  2. **A flag on the card** when its linked person deletes their account (Shopify's
     `customers/redact` is the model; GDPR Art. 19 arguably requires telling the salon).
  3. **A pre-deletion prompt to export "my customer record"** — after the unlink, that export
     (`modules/nail-salon/ui/export.ts`, filtered on `user_id`) can no longer find the card.
  **AND ONE RULE FOR WHOEVER BUILDS ACCOUNT-TO-CARD LINKING:** never copy the platform account's
  email (or any other platform identity) onto the card. The salon never collected it, so after
  the person deletes their account it would be a platform-sourced identifier the platform
  promised to remove. Recorded in the module-5 spec beside the linking analysis.
- **The residual of finding 1:** a co-member who declined the person in speed dating *and*
  wrote a safety note about them keeps that pairing (a safety record outranks
  minimisation), so they can see "Former member" beside their own note.
  **CONFIRMED BY THE FOUNDER 2026-10-08.**
- **§7.8's "I said yes and was waiting" row is built only for MUTUAL matches.** If the viewer
  said yes and the counterparty never decided, nothing is shown. Showing "left" there but not
  after a "no" would let the viewer tell undecided from rejected — exactly the reveal guard. So
  that case is deliberately silent. **OPEN, founder question 2026-10-08:** show "left" for BOTH
  no and undecided? Treating them identically does not break the reveal guard (they
  already look the same: no match). The constraints if built: show it only once the
  deletion has COMPLETED (not during the grace period, which is reversible and would leak a
  pending decision to a non-match), and only after the event's reveal. Update when decided.
- ~~**Superadmin-initiated deletions are cancelled by the person signing in**~~ **STILL TRUE
  for a deletion at the person's request — but the founder found the gap (2026-10-08): that was
  the superadmin's ONLY action, so a superadmin could not remove someone AGAINST their wishes**
  (he signs in, it cancels). **Built same day: "Remove from platform", §7.11.**
- **Uploaded files are kept** with the records that own them (submissions, layer images).
  **CONFIRMED BY THE FOUNDER 2026-10-08.**
- **A deleted worker's appointments — CORRECTED 2026-10-08, the original bullet described the
  wrong screen.** The CUSTOMER never sees a worker at all ("Your appointments" lists date and
  service only). The real gap is the salon's own **Today's board** (`modules/nail-salon/ui/page.tsx`
  OperatorConsole): it loads only ACTIVE workers, the silhouette sets `active = false`, so the
  Worker column shows "—" and the board's own "Former member" code can never fire. Two
  adversarial reviews (code; product/privacy) both recommend: build the name map from ALL
  workers, keep the pickers active-only, show "Former member" — and on a still-BOOKED
  appointment make it a visible "needs reassigning" marker, since the silhouette never touches
  `sal_appointments`. **Awaiting the founder's go-ahead.**

## 7.11 REMOVE FROM PLATFORM (2026-10-08, `20261008020000`) — a superadmin takes someone off

**Why.** The founder: "Super admins can't lack that power to remove someone from the very
start." The only superadmin action was deletion at the person's request, which signing in
cancels, so it could not remove an unwilling person.

| | Delete at the person's request | **Remove from platform** |
|---|---|---|
| Sign-in | Signed out; may sign back in | **Blocked at once** (`banned_until`), all sessions, refresh tokens and one-time tokens deleted |
| Signing in cancels it | Yes | **Never** — opted out in all three derivations, not only blocked by the ban |
| Who undoes it | The person (sign in) or a superadmin | **A superadmin only**; undo lifts the ban |
| Sole org admin / sole Director | Refused | **Not refused** — returned as a warning; day 30 fails visibly (retried daily) while the ban holds |
| A superadmin as target | Refused | Refused |
| Day 30 | Silhouette | Silhouette (identical) |

A pending removal cannot be overwritten: neither the person's own self-serve request (their
pre-removal access token lives up to an hour) nor a superadmin's "at request" action can
downgrade it into a cancellable deletion. That hole was found while building and independently
by the regression reviewer. Console: `/console/accounts`, a separate red **Remove from
platform** form and an **Undo removal** button in the list. Tests: 7 in
`account-deletion.test.ts` ("remove from platform"); e2e covers the refusal only (a real removal
would ban a seeded user). Two adversarial reviews: no escape found.

**Recorded, not built:**
- **A removed person can sign up again on day 31 with the same address** — the silhouette
  frees it (§7.2: a returning person is a new person). Right for a voluntary deletion, arguably
  wrong for a removal. **FOUNDER DECISION, asked 2026-10-08.** If wanted: keep a HASH of the
  address as a signup deny-list for removals (never the address itself; docs/18 §9's pattern).
- Within the access token's last hour the person still holds their memberships; an org owner
  could, for instance, make themselves sole admin so day 30 keeps failing. The ban holds, the
  console shows the failure. Not an escape.
- Lifting the ban outside the platform (Supabase dashboard / GoTrue admin) leaves a removal
  row whose person can sign in. A trusted actor only; a console check could flag it.
- `/privacy` and the draft Terms do not yet say the platform may remove an account.

### Still owed

- ~~**Production.**~~ **DONE 2026-10-08**, founder go-ahead, backup
  `backups/2026-10-08T06-20-02`, applied in ONE push together with the parallel session's
  `20261007050000` (`db push` cannot apply one alone; the founder confirmed both). Verified on
  prod: own verifier 85/0, `verify-acl-hardening.ts` 17/17, `prod-verify-migration.ts` 0
  failures with 15 bodies matching (its 7 warnings are the benign no-api-role-EXECUTE class:
  internal helpers and a trigger function). `migrate:prod` printed the known pgdelta
  certificate trace AFTER both applies; a follow-up dry run reads "Remote database is up to
  date". **STILL TO CHECK, from 2026-10-09:** re-run the verifier — its §[6] must show a
  `succeeded` run of `account-deletions-complete-due`. Until then the cron job is proven
  SCHEDULED on prod, not proven RUNNING. Behaviour (the silhouette itself) is proven locally
  only, deliberately: proving it on prod means deleting a real account.
- Telling the person (by email) that a deletion was started on their behalf — there is no SMTP
  yet (docs/18), so the founder replies to the emailed request by hand.
- Matchmaking has the "Former member" label but no archive section like speed dating's; the
  founder scoped the archive to speed dating.

