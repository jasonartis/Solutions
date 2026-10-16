# 25 — Pending invites (invite people who are not on the platform / org yet)

**Status 2026-10-16: SLICE 1 (ORG PRE-INVITE) IS BUILT — migration `20261016010000`; read §11 first for
what was built, what was measured, and what is only locally proven. Slices 2–4 are not started.**

**Original status: REQUIREMENTS BRIEF, 2026-10-15.** Written by a
Sonnet session from the founder's decisions so they are not lost; the **schema, RLS and trigger design
is OPUS work** (docs/03 #12 rhythm: draft → adversarial review → live-verify as real users → tests →
docs), and a novel mechanism of this size is a Fable-tier *review* candidate (CLAUDE.md model rules).
**Per the standing rule, a build does not start until the founder initiates it.**

## 1. The problem (founder, 2026-10-15, testing visual messaging)

A chat creator invited an address that is not in the org and got *"No user found with email …
add them as an org member first"* — an instruction they usually cannot follow (only an org admin adds
org members). More broadly the founder does not want to force the order **platform → org → module →
chat**: *"I might want to invite family members as test users. Do I need to make them sign up before
adding them to things, then wait for them to tell me they registered?"* He wants to set everything up
first, so that **on registration they are ready to go.**

## 2. Founder decisions (2026-10-15) — do not re-litigate

1. **Hold time: 30 days**, for every kind of pending invite (this is also the founder decision 8 already
   on record from 2026-09-04, docs/20 §0 item 8 / §7.7, which had been orphaned).
2. **The model: anyone may pre-invite to anything they could invite to if the person were already
   here.** A chat creator may pre-invite to the chat; whoever may invite to an org may pre-invite to the
   org. A pre-invite takes effect when its prerequisites are met (the person signs up; later joins the
   org). **This applies to ALL existing and future invite types on the platform**, not just visual
   messaging.
3. **Claude's four refinements — proposed by the Sonnet session and implicitly accepted (the founder replied
   "draft it"), NOT separately ruled on; confirm if any is contested:** each link in the chain is
   independent (a chat invite never creates org membership); authority is re-checked at claim; the inviter
   never learns whether the person already exists; only a verified email can claim (§4).

## 3. What exists today (verify each before relying on it — this was read, not re-measured)

> **RE-MEASURED 2026-10-15 against the live local catalog (§11.1).** Everything below held, with
> one omission that matters: the ORG flow had its own, larger oracle (any account on the platform),
> which this section did not mention.

- **Org invites:** `org_members.status` is `pending|active` (default `pending`), with `invited_by`,
  `invited_at`, `accepted_at` (migration `20260727010000_org_invite_accept.sql`). Only the invited user,
  through `org_accept_invite()`, flips their own seat active; it **revalidates the inviter** (that is why
  `invited_by` is load-bearing). `org_find_user_by_email` resolves an existing account (docs/20 §8.3, and
  docs/18 item 9: admin email-lookup logging is deferred but its build shape — hash the address — is decided).
- **Chat (visual messaging) invites:** accept-first seats — a seat made for someone else is `pending`
  (`vm_members_c_invite`), confers nothing until the invitee accepts (`vm_accept_conversation_invite`);
  decline, decline-and-block (self-block, per conversation) and unblock exist. The resolver is
  `find_module_peer`, which returns an id **only for an ACTIVE member of the org** — which is exactly what
  produces the refusal above, and it is also an email-membership oracle (see §4.3).
- **Every existing invite needs an existing `auth.users` row** (a pending row is keyed by `user_id`). There
  is **no** invite to a person with no account. docs/20's earlier `vm_pending_invites` + signup-time
  resolver + pruner design was dropped without a decision (docs/20 §7.7, P3) — **this brief is that decision.**
- **Re-signup blocks (docs/21 §7.12)** are enforced by a trigger on `auth.users` for signup and email
  change, keyed by `account_email_fingerprint()` (aggressive normalisation: gmail dots, `+tag`). The signup
  screen shows one identical "check your email" notice for taken/blocked/fresh addresses (§7.12.1).
- Interim wording fix already shipped (`3a10297`): the refusal no longer tells a chat maker to do an
  admin-only step. It still says *whether* the address is in the org — remove when this ships.

## 4. Requirements

### 4.1 Behaviour
- **One platform mechanism, not one per feature** (extract-don't-speculate is satisfied: org and chat
  invites are two consumers today). A pending invite = *who* (email), *what* (a kind + target, e.g.
  `org`, `vm_conversation`), *as what* (role/seat), *by whom* (inviter), *when/expires*, *state*.
  Each kind registers how it is **validated at issue**, **re-validated at claim**, and **applied**.
- **Issue:** allowed iff the inviter could invite that person to that target if they were a member. The
  inviter may be a conversation creator who is not an org admin.
- **Claim:** happens at the person's first confirmed sign-in with that exact address (and re-runs when a
  *prerequisite* is met later — e.g. a chat invite that was waiting on org membership). Applying an invite
  produces the **same pending/accept-first state the platform already uses** (a pending seat the person
  still accepts) — a pre-invite must not become a silent forced join. (Org/chat accept-first is a decided
  property: docs/19, `20261007030000`.)
- **Dependencies:** a chat invite never creates org membership. If the person is not in the org, the chat
  invite stays dormant until an org admin (or other authority) adds them. Each invite expires on its own
  30-day clock.
- **Expiry:** 30 days from issue; the inviter sees "expires in N days", can **cancel**, and can **resend**
  (resets the clock). A pruner deletes expired rows (note: **prod has no running worker** — CLAUDE.md;
  account deletion solved this with `pg_cron` inside the database, docs/03 hard rule 5 records the exception).
- **UI:** the inviter's list shows "Invited — pending" with the address, identical whether the person has an
  account or not. Copy for every state; no jargon (CLAUDE.md "user-facing copy": no security mechanisms in text).

### 4.2 Hard security / privacy requirements (each needs a named test)
1. **Verified email only.** Claim by **exact lower+trim match of a CONFIRMED address**, never the
   `account_email_fingerprint` (that one is deliberately aggressive and exists for blocks, not identity).
   An unconfirmed signup must not claim anything (prod has `enable_confirmations` true for email and SMS —
   CLAUDE.md local-auth gotcha).
2. **Authority re-checked at claim.** If the inviter has since left the org/chat, been demoted, banned or
   deleted (the silhouette, docs/21), the invite does not apply. State the rule per kind.
3. **No oracle.** Issuing returns the same result whether the address has an account, is in the org, is
   blocked, or is already a member — same words, same timing as far as practical. This removes the current
   email-membership oracle in `addMember`. (Precedent: the deliberate 23505 silence in `addMember`; and
   docs/21 §7.12.1, where exact HTTP parity was measured impossible but screen parity achieved.)
4. **Blocked and removed people.** A pre-invite must not be a way back for someone removed from the
   platform (docs/21 §7.12) or a self-blocked conversation (docs/21; `vm_guard_self_block`): a self-block
   must beat any pending invite for that conversation; a platform block already prevents the signup itself.
5. **The stored address is a data subject with no account** (docs/modules/module-4 "TWO PRIVACY
   OBLIGATIONS"): not in the data browser, not exportable, no deletion route. **The 30-day expiry plus the
   inviter's cancel must BE the deletion mechanism, and be described as such.** Also: the privacy page
   needs a line for it (owed; docs/12 item 6 was overridden twice — "do not make it three"), and the
   founder reviews all `/privacy` wording himself. Store the address (the inviter must see and cancel it);
   delete it on claim, cancel or expiry. Decide whether to keep a one-way fingerprint after deletion — the
   founder removed the retention sentence from `/privacy` for blocks (2026-10-14); do not quietly add another
   retained identifier.
6. **Table hygiene:** the new table starts with `revoke all … from public, anon, authenticated,
   service_role` **before** any grant (docs/03 #27 — a privilege escalation shipped once from skipping this);
   every function states its full ACL; policies are split per command, never `for all` (docs/20 §8.1);
   any helper that must answer about a THIRD party cannot be caller-relative (docs/03 #29, e.g.
   `is_org_member`); a trigger's volatility is load-bearing (docs/03 #30); the claim step runs as a definer
   hooked on signup/first confirmed sign-in — **respect the auth-trigger criticality rules in docs/03**
   (a trigger on `auth.users` that fails can block every signup; `login_events` is the worked precedent) and
   note the prod "Before User Created" hook is ON.
7. **Abuse limits:** cap pending invites per inviter and per target address (an address spammed with
   invites from many orgs is a harassment vector, and `/signup` is an email sender; prod's built-in sender
   is **2 emails/hour**, docs/18 item 7). **Decide whether issuing an invite sends an email at all** — the
   platform has no custom SMTP yet; without an email the person only sees the invite after signing up by
   other means (the founder tells them). Recommend: no email in v1, inviter shares the link; revisit with
   SMTP.

### 4.3 The invite-to-address oracle, stated plainly
Today a conversation admin can learn whether an address is an active member of the org (the refusal text
differs). The founder asked if that matters: it is small (org-mates already see each other's display names)
but real, and it is the same class as docs/22's email-visibility work. This feature should **remove** it,
not add a second one.

## 5. Scenarios the build must pass (use real seed users; write these as e2e/RLS tests)

1. **Family test users (the founder's case):** the org admin pre-invites three addresses to the org with a
   module role, and to a chat. None has an account. They sign up (confirmed) → each sees a pending org
   invite, accepts, then sees the chat invite, accepts → ready. Nothing was manual in between.
2. **Chat maker who is not an org admin** pre-invites an address that is not in the org: accepted silently;
   the chat invite sits dormant; the person signs up and is NOT in the chat until an org admin adds them to
   the org; the moment they are, the chat invite appears. They never gain org membership from the chat invite.
3. **Existing user** invited to the chat: same inviter-facing result as scenario 2 (no oracle).
4. **Expiry:** day 31 → gone, the address no longer stored anywhere, the inviter sees it expired, a resend
   works.
5. **Inviter loses authority** (removed from the chat/org) before the person signs up → nothing applies.
6. **Self-block wins:** the person self-blocked that conversation → the pending invite never applies.
7. **Platform-removed address** (docs/21 §7.12) → signup itself is refused as today; the pending invite
   does not resurrect them.
8. **Typo'd / wrong person:** an invite to `a@x.com` cannot be claimed by `b@x.com`, or by an unconfirmed
   `a@x.com`.
9. **Cancel** by the inviter removes the row. A non-inviter, non-admin cannot read or cancel it.

## 6. Founder answers to the open questions (2026-10-16) — SETTLED unless marked open

1. **Email on issue: NO, for every invite type** (recommended A; the founder did not push back after the
   clarification that "invite" always means an invite to a thing — org, chat — and that there is no separate
   "invite to the platform"). The inviter tells the person to sign up; they see their invites on first sign-in.
   **Open only as an explicit confirmation:** the founder asked what the question meant and answered the other
   four; treat 1A as accepted, but say so in the build reply.
2. **CAPS: YES (founder 2026-10-16, superseding his first answer "no cap" — "we could have a cap to be safe, pick
   what is best, make it easy to raise later"). Claude's pick: at most 100 PENDING invites per inviter, and at
   most 20 pending invites naming any one address across ALL inviters** (the second stops many people piling
   onto one address; the first stops one person flooding). Both are plenty for family/test use. **The two numbers
   live in `platform_settings` (superadmin-only key/value, migration `20260923010000`) with these values as the
   code fallback, so raising them is a console edit, not a migration or deploy.** Over the cap the issue is
   refused with a plain-language message to the inviter (it says THEIR limit, never anything about the address —
   the per-address cap must not become an oracle either: when it trips, behave exactly as for any other
   silent no-op). Revisit again when invites start sending email (docs/18 item 7).
3. **Org admins see every pending invite whose target belongs to their org (A)** — org invites AND chat invites
   to conversations in that org, including ones issued by others, even when the invitee is not an org member
   yet ("Dana invited X to *Family sketch*; X is not in the org yet"). They can cancel any. Seeing a chat invite
   confers nothing: **a chat invite never creates org membership**; adding X to the org is a separate step by
   someone with that authority.
4. **A chat pre-invite for someone without the module role (or not yet in the org) is HELD, not refused**,
   applying once the prerequisites are met and expiring at 30 days otherwise. **WHO SEES WHAT'S MISSING
   (founder asked, 2026-10-16):** the **org admin** sees the specific reason ("waiting for org membership" /
   "needs the visual-messaging role") because they are the one who can act on it. The **ordinary inviter**
   (e.g. a chat maker who is not an org admin) sees only a generic "Pending" — a specific reason would tell
   them whether the address has an account / is in the org, which is the oracle this feature exists to
   remove (§4.2 #3). The **invitee** sees nothing about it until every prerequisite is met; then it appears as
   a normal pending invite they can accept or decline.
5. **v1 kinds: `org`, then `vm_conversation`. Other modules' invite-like flows come later, one at a time.**

6. **Is there a PLATFORM invite (a superuser emails someone to join the platform)? Not in v1 — decided
   2026-10-16 after the founder asked "what do other apps do?".** Facts: **signup is OPEN today** (anyone can
   create an account at `/login`; they land with no org and see nothing; removal blocks apply — docs/21 §7.12),
   so a stand-alone "invite to the platform" has no job: **an org invite IS the platform invite** — the
   address is invited to a thing, and signing up is what activates it. What other apps do: Slack, Notion,
   GitHub, Google Workspace invite you to a WORKSPACE/ORG (the account is created on the way in); a bare
   "invite to the product" exists mainly for closed betas that GATE signup (Linear/Superhuman-style
   invite-only waitlists, invite codes). That gate would only matter if signup were closed (a client
   requirement), and sending the invite email is blocked anyway by the 2/hour sender (docs/18 item 7).
   **Builder: keep `kind` extensible and the table target-optional, so a future `platform` kind (an address
   allowed to sign up while signup is closed) is just another kind, not a redesign — but build NOTHING for it
   now.** Revisit with the first client that wants invite-only signup or when custom SMTP exists.

### 6a. Still genuinely open (builder brings these)

- How an invite carries its prerequisites (org + module role) and reports which are missing (answer 4 fixes
  the behaviour, not the data shape).
- Which of the other modules' invite-like flows (classroom enrolment, speed-dating registration, salon workers,
  matchmaking pool) are the same shape — list them for later; none are in v1.
- The exact "expires in N days" / resend wording, and the `platform_settings` key names for the two caps.

## 7. Suggested slicing (smallest first; each independently shippable + prod-verifiable)

1. **Org pre-invite** end to end (table, issue/cancel/expire, claim on confirmed sign-in, no oracle) — the
   platform primitive plus one consumer.
2. **Chat pre-invite** as the second consumer (dormant-until-org-member rule, self-block precedence).
3. UI for both inviter lists; the privacy-page line (founder reviews wording).
4. Remove the interim membership-revealing refusal in `addMember`.

## 8. Not in scope
Anonymous public links (stay deferred post-v1, module-4 spec); Public Square (docs/20 — invite-only v1);
SSO; changing accept-first semantics.

## 9. Pointers
docs/20 §0 item 8, §7.7, §8.3 · docs/modules/module-4-visual-messaging.md (TWO PRIVACY OBLIGATIONS; the
2026-10-14/15 entries) · docs/21 §7.12, §7.12.1 · docs/22 (email lives only in `auth.users`, read through
definers) · docs/19 (seat authority) · docs/03 #1, #12, #22, #27, #29, #30 · docs/18 items 7 and 9 ·
`supabase/migrations/20260727010000_org_invite_accept.sql`, `20261007030000` (accept-first seats).

## 10. Appendix — starter prompt for the Opus build session (slice 1)

Paste into a fresh Opus session. Kept here so it is not lost with the chat that wrote it.

~~~~
You are Opus. Task: BUILD SLICE 1 of pending invites (org pre-invite) per
docs/25-pending-invites.md. The founder (Jason) is initiating this build.

READ FIRST, in order:
1. CLAUDE.md "Current state" (top block) + "Standing rules" + the model-choice and gotchas sections
2. docs/25-pending-invites.md — the full brief; §2 decisions are settled, do not re-litigate
3. docs/03-adding-a-module.md hard rules and conventions #1, #12, #22, #27, #29, #30
4. docs/20-public-square.md §0 item 8, §7.7, §8.3 (the orphaned no-account-invite design and why it was dropped)
5. docs/21 §7.12 and §7.12.1 (re-signup blocks, signup-screen parity) and docs/22 (email lives only in auth.users)
6. supabase/migrations/20260727010000_org_invite_accept.sql and 20261007030000 (accept-first seats)

DO NOT START CODING until you have:
- re-measured §3 of the brief against the live local DB and the migrations (it was read, not measured), and
  written down what you found, including anything that contradicts it
- brought the founder the open questions in §6 that block slice 1 (email on issue — recommend no for v1;
  per-inviter/per-address caps; admin visibility of all pending invites). Do not decide those silently.
  Standing rule: don't block on a founder answer — record the question, proceed on the recommended default,
  flag it in your reply.

CLAIM A MIGRATION VERSION first: run ListAgents, SendMessage any concurrent session with the version you
take, pick one with gaps. A Sonnet session owns modules/visual-messaging/ui and has pushed UI changes —
don't touch it; slice 1 is org-level only.

SLICE 1 SCOPE: the platform primitive + ONE consumer (org). Table, issue / cancel / resend / 30-day expiry,
claim at a confirmed sign-in by EXACT lower+trim email (not the fingerprint), no-oracle issuing, authority
re-checked at claim, a pruner that actually runs on prod (prod has no worker — use pg_cron in the database, see
docs/03 hard rule 5), caps, and the inviter/admin list UI. A claim produces the existing PENDING org seat
(accept-first), never an active one.

PROCESS (non-negotiable, docs/03 #12): draft the design -> adversarial review (two narrow reviewers, each with
one question and a word cap — a single broad reviewer has died on limits before; Fable-tier review is
justified for this novel mechanism) -> build -> live-verify as real signed-in users -> RLS tests naming each
failure -> docs. Every item in brief 4.2 needs a named test, and every section-5 scenario must be a test. New
table: revoke all from public, anon, authenticated, service_role BEFORE any grant. A trigger/hook on auth.users
that can fail can block every signup — study login_events and the prod Before-User-Created hook before
touching that path.

MIGRATION HYGIENE: it must meet an EMPTY database (supabase db reset locally before calling it done — CI runs
migrations before any seed). Before `supabase db reset` on the shared local DB, check with other sessions
(ListAgents/SendMessage). Prod: backup first, `pnpm migrate:prod --dry-run`, get the founder's go-ahead IN YOUR
OWN SESSION, then a policy-aware prod verifier (template: scripts/prod-verify-*.mts) with controls; run it
before AND after. The generic prod-verify-migration.ts is function-only and would pass vacuously on
tables/policies.

TOOLING NOTES (this host): pnpm may not be on PATH (shim via corepack enable --install-directory <dir> — see
the gotcha). Stage explicit paths and use git commit -- <paths>; other sessions share this tree. Never
--no-verify. Check Windows commit memory if dev tooling dies mysteriously. In git-bash prefix
MSYS_NO_PATHCONV=1 when passing /paths into docker exec.

DONE MEANS: slice 1 on prod and verified, docs/25 updated with what was built and measured, CLAUDE.md's status
block kept lean, journal entry written. Say so plainly if anything is only locally proven.

SCOPE LIMITS: slices 2-4 (chat consumer, lists/privacy copy, removing the old refusal in addMember) are NOT part
of this session unless the founder asks. If your work drifts into something needing a lighter or heavier
model than you, say so at the start of the turn.
~~~~

Two facts for that session: the visual-messaging UI work is all pushed (last UI commit `8402ea5`); slice 1 is
org-only because it is the smallest piece that proves the platform mechanism and the chat rule
("dormant until the person is an org member") depends on it.
## 11. SLICE 1 — BUILT (2026-10-16, Opus) — org pre-invite

Migration `20261016010000_pending_invites_org.sql`. Code: `apps/web/app/(app)/o/[orgSlug]/members/`
(actions, page, `invite-form.tsx`), `apps/web/lib/org-members.ts`, `apps/web/lib/platform.ts` (the claim),
`apps/web/app/(app)/console/` (the caps editor). Tests: `packages/db/src/pending-invites.test.ts` (one test
per §4.2 item and per slice-1 scenario), e2e "pending invites: an address with NO account…". Prod verifier:
`scripts/prod-verify-pending-invites.mts` (run before AND after `migrate:prod`).

### 11.1 §3 re-measured (live local catalog, 2026-10-15)

All of §3 held. **Missing from §3:** the org members page's `addMember` threw *"No user found with email X —
they must sign up first"*, and `org_find_user_by_email` answered "does ANY account have this address?" for
every org admin — a platform-wide account-existence oracle, larger than the chat one in §4.3. Both are gone:
the page now invites by address, and the function is **superadmin-only** (the Owner Console still uses it).
Also measured: local auth autoconfirms (`enable_confirmations = false`); `org_members_guard_hierarchy` and
`module_roles_guard_hierarchy` treat "no signed-in user" as the trusted service path; pg_cron 1.6.4 is
installed; a function-level `SET request.jwt.claims` is REFUSED on this database.

### 11.2 The shape

- **Table `pending_invites`**: kind (`org` only), org_id, target_id, email (lower+trim), role, invited_by,
  created_at, expires_at; one row per (kind, target, address). org_id/target_id are nullable at the table
  level and required per kind, so a future `platform` kind (§6 answer 6) is a new kind, not a redesign.
  `revoke all` from every API role, then `grant select` to authenticated only. **One policy, SELECT,
  `is_org_admin(org_id)`.** Every write goes through a definer.
- **Issue** (`pending_invite_issue_org`): allowed iff the caller could add that role directly (org admin,
  rank strictly above). Never asks whether an account exists. Answers `invited` / `exists` (someone above you
  already holds an invite for this address — visible in the list) / `already_member` (only from THIS org's
  seats, which the admin already reads with addresses).
- **Claim** (`pending_invites_claim_mine`): **an RPC the dashboard calls, NOT a trigger on `auth.users`** — a
  failing auth trigger can block every sign-in, and a sign-in trigger would never reach an existing user who
  stays signed in. It needs the caller's address CONFIRMED, matches it exactly (never by fingerprint), skips
  banned/deleted/anonymous accounts and addresses shared by two accounts, and turns each live invite into the
  existing **PENDING** org seat. `org_accept_invite` re-checks the inviter again at accept.
- **Authority at claim** (`pending_invite_apply`, internal): the inviter must not be banned or departed, and
  must be a superadmin or an ACTIVE member who outranks the invited role (the same rule as accept). A dead
  invite is deleted unused.
- **The applier clears the caller's identity** (`set_config` on `request.jwt.claims`/`.sub`, restored at its
  single exit and in its exception handler) so the seat is created on the inviter's behalf through the guard
  triggers' service path. The claim asserts the identity came back.
- **Cancel**: any org admin of the org (§6 answer 3). **Resend**: re-issues, so it keeps the issue rule; it
  moves the invite to the resender and gives 30 more days. **Resending can keep an invite alive indefinitely**
  — that follows from "resend resets the clock".
- **Expiry**: an hourly pg_cron job (`pending-invites-prune-expired`, `23 * * * *`) deletes expired rows and
  rows whose inviter's account deletion has COMPLETED (not during the 30-day grace). The members page shows when
  it last ran (docs/03 hard rule 5).
- **Caps** (§6 answer 2): 100 open per inviter, 20 open per address across everyone, in `platform_settings`
  key `pending_invites.caps` (`{"maxPerInviter", "maxPerAddress"}`), edited on the Owner Console; malformed
  values fall back to the defaults rather than breaking issuing. Over the inviter cap: *"You have reached your
  limit of N open invitations."* Over the address cap: the ordinary "Invitation saved" and **nothing stored**.
  **Residual, stated:** the admin's waiting list will not show that invitation, so a watchful admin can infer
  the address is heavily invited elsewhere — never whether it has an account.
- **No email is sent** (§6 answer 1, accepted). The page says so and tells the admin to let the person know.

### 11.3 What adversarial review changed (two narrow Fable reviewers, 2026-10-15)

1. **Module roles are NOT carried on an org pre-invite.** A grant written at claim survives its inviter losing
   authority (module_roles has no tie to org_members) and goes live later through somebody else's invite.
   **Slice 2 must grant module roles at ACCEPT, after the inviter re-check** — this also serves §6 answer 4.
2. `org_find_user_by_email` narrowed to superadmin (above).
3. The SELECT policy lost an "inviter reads their own" arm: a demoted admin kept reading addresses, and could
   watch a row vanish early (= "this address now has an account").
4. The first per-address cap was dropped because its refusal leaked other orgs' invitations; the founder's
   later cap is silent for that reason.
5. The address never appears in a warning, a log line or a thrown server-action error.
6. Departed inviters' rows are pruned; the applier has one exit; duplicate-address accounts claim nothing; the
   applier re-checks the address itself.

### 11.4 Verification

- `pending-invites.test.ts` — every §4.2 item and slice-1 scenario. **Teeth proven** by breaking the
  database on purpose: dropping the confirmed check, dropping the authority re-check, and skipping the
  identity restore each turned the matching tests red; restored, green.
- Full db suite 395/395 from `supabase db reset` (the migration meets an EMPTY database), typecheck 9/9.
- `prod-verify-pending-invites.mts`: local 61/0 (2 warnings: no cron run yet; auth config not checkable on
  local). **Prod pre-apply 8 pass / 55 fail — every control green, and prod's auth config CONFIRMS
  `mailer_autoconfirm = false` and `mailer_secure_email_change_enabled = true`**, which is what makes a
  confirmed address proof of ownership.
- **ON PRODUCTION 2026-10-16** (backup `backups/2026-10-16T06-27-18`; `migrate:prod`, then push, deploy
  `3fac438` READY): verifier **8/55 → 64/0**; `prod-verify-migration.ts` 0 failures (2 warnings, the benign
  internal-function class); `verify-acl-hardening.ts` 14/17 after apply (new objects unclassified) → **17/17**
  once classified. **Live as real users on prod, 12/12:** alice (demo-a admin) issued an invite to a fresh
  address; charlie read nothing; an org-admin lookup of an existing address returned nothing; a throwaway
  confirmed account with that address claimed exactly one PENDING seat, the stored address was gone, it
  accepted, and the seat was active with `invited_by` = alice; the real members page rendered with the form
  and the list. Everything it created was deleted. **The throwaway account was made confirmed through the
  admin API, so prod's real confirmation email was NOT exercised** (prod's sender is 2/hour, docs/18 item 7).
  The first hourly prune had not run yet at the time of writing — re-run the verifier to see §[5] go green.
- **Only locally proven:** the claim's failure paths (lapsed inviter, unconfirmed, banned), and that a
  confirmed address cannot be obtained without owning it under prod's GoTrue (the unconfirmed-account
  pre-hijack question in review note 5 — whether GoTrue keeps an attacker's password when the real owner
  later confirms an unconfirmed signup — was NOT measured).

### 11.5 Still open

- **Privacy-page line (owed, §4.2.5; founder reviews the wording).** Draft, not applied: *"If someone
  invites you by email address before you have an account, we keep that address for up to 30 days so the
  invitation can reach you when you sign up. It is deleted when you join, when the invitation is cancelled,
  or when it expires. Copies may remain in backups for a limited time."*
- §6a: how a chat invite carries prerequisites — answered in shape by 11.3 item 1 (grant at accept); the
  data shape is slice 2's.
- Other modules' invite-like flows, for later: classroom enrolment and salon workers are "grant a module
  position to an existing org member" — the same shape as a module role carried on an invite. Speed-dating
  registration and the matchmaking pool are SELF-service (the person joins), so they are not invites.
- Deploy order: **`migrate:prod` FIRST, then `git push`.** Reversed, the members page errors (its table does
  not exist yet); migrate-first only makes org admins' Invite fall back to the old refusal for a few minutes.
