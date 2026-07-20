# Network features — tenancy review (Public Square, cross-org switching, Redt-It)

**Status: REVIEW FINDINGS + RECOMMENDATIONS, not decisions.** Produced 2026-07-20 by
an independent Fable-tier adversarial tenancy review of three founder-proposed
"network-shaped" features (founder's own words: `founder-feedback.md` 2026-07-17
bullets; parked in [docs/15 §10](15-user-model.md)). Key claims were verified against
the live policies before this doc was written. **The founder has decided none of the
open items below** — this doc exists so that when he does, the decisions are made
with the risks already mapped.

The one-sentence summary: **"make the public space an org" is the right instinct and
should be kept — but "it's just an org, RLS unchanged" is only true for module
tables.** The platform-core policies were all written under an unstated assumption:
*an org is a small, vetted, mutually-acquainted group.* Public Square breaks that
assumption, and several core policies fail **open**, not closed, when it does. Every
finding below is a variant of that one theme.

---

## P1 — Public Square findings (verified, ranked)

### P1-1 [CRITICAL] `profiles_select_shared_org` turns Public Square into a platform-wide email directory

Verified in `20260708020000_profiles_shared_org_read.sql`: sharing **any** org grants
row-read of the **whole profile row, email included** (the migration comment says
"display name/email" — written for team tools, per its own words). If (near-)everyone
opts into Public Square, every authenticated user can read every other user's email
via a core-table policy no module controls.

Second-order damage is worse: three modules' most carefully audited privacy designs
exist specifically to gate contact-info reveal — matchmaking's `mm_mutual_matches()`
(mutual interest before email), speed dating's `sd_reveal_matches()` (rejection
indistinguishable from indecision), and Redt-It's entire premise (contact trades on
mutual yes). **All three become theater if both parties' emails were already readable
because they both accepted the Public Square invite.**

**Must be decided before Public Square exists** (Opus + full #12 rhythm; novel
mechanism ⇒ would have wanted Fable review — this review is it): either (a) exclude
network-class orgs from `shares_org_with()` and give them a display-name-only
surface (definer or view), or (b) restructure so `email` is never row-readable
cross-user and rosters go through org-scoped definer functions. Either way, "sharing
an org" must stop implying "may read email" where membership is unvetted.

### P1-2 [CRITICAL] Pending ≠ member, provably — else auto-invite = auto-join

Auto-invite-on-signup + a naive `org_members.status` column means every signup
silently satisfies `is_org_member()`, `shares_org_with()`, and `org_caller_rank()`
for the platform-wide org on day zero — inside the RLS boundary without ever
consenting, and P1-1 becomes universal *and non-optional*. Already folded into
[docs/15 §6](15-user-model.md) as binding: pending is invisible to all three
predicates, with an RLS test proving a pending invitee reads nothing; the invite
card's org-name read gets a narrow definer path.

### P1-3 [HIGH] Opting out is currently impossible

Verified: the shipped hierarchy guard's "nobody touches their own seat" blocks a
plain member from deleting their own row — fine for admin self-lockout, a trap for a
10k-member public org. Folded into docs/15 §6: member self-DELETE carve-out (never
modify), full #12 rhythm since it edits a freshly audited trigger.

### P1-4 [HIGH] Roster enumeration

Verified: `org_members_select_member` lets any member read the org's full roster;
joined with P1-1 that's user_ids + names + emails of the whole platform. Standing in
a public square does not entitle you to its census. Network-class orgs need
roster-read restricted (search-by-exact-handle, not browse) and the members UI
paginated. Precedent question P3 inherits: **"who can enumerate the pool" is a
first-class question in any unvetted org.**

### P1-5 [HIGH] docs/15 §7 defaults assume trusted orgs

VM's default "global member = can create chats and invite" is, in an unvetted org,
an unsolicited-contact engine where the spammer moderates their own conversation.
Public Square therefore needs: (a) an explicit **module whitelist** (only
stranger-safe modules enabled — the lever already exists, enablement is
superadmin-only; **never matchmaking-family**, whose staff-tier `for all` policies
would hand one org's admins the dating data of everyone opted in), and (b)
**per-org overrides of §7 defaults** (e.g. chat creation request-gated, invites
requiring the invitee's accept — §6's join-policy machinery already provides this).

### P1-6 [MEDIUM] Ownership, moderation, abuse

No org-wide moderation primitive exists (VM flags are per-conversation; no
user-level ban, no rate limits — never needed in vetted orgs). Launch checklist:
named owner/admin seats (the platform operator wearing an org hat), at least one
abuse-report path that isn't per-conversation, and a written acknowledgment that
Public Square means *operating a public community*, with the ongoing cost that
implies.

### P1-7 [MEDIUM] The consent posture is good — iff P1-2 holds

Auto-invite-pending-until-accept is a defensible consent model and dovetails with
the already-authorized invite-accept-for-all-adds. Keep it clean with signup-time
disclosure (no dark-pattern pre-acceptance) and symmetric opt-out (P1-3). The legal
story is only as true as the `is_org_member()` predicate.

### P1-8 [LOW] First-10k-member-org growing pains

Superadmin console member panels, export manifests for admin hats over a giant org,
`shares_org_with()` join performance. Not leaks — schedule, don't discover.

---

## P2 — Cross-org module switching: APPROVED SHAPE (no blockers)

**Verdict: confirmed pure navigation/UI, zero RLS surface — conditional on one
rule: switching is a full navigation, never a client-state swap.** The org slug is
already in every path; every page re-derives org + entitlement server-side; RLS
scopes every query. The safe shape, in one line:

> A server component in the module layout lists the caller's other orgs where
> `org_modules` has the same module enabled, each item a plain
> `<Link href="/o/<slug>/m/<module>">`, landing on the module's **home** page (never
> "same entity across orgs" — it doesn't exist). No client org-state, no shared
> mutable context.

Why the rule matters: VM's canvas holds unsent drafts and org-prefixed storage paths
in client state — a context-swap design could submit an OrgA draft against OrgB
route params; full navigation unmounts everything. Cache discipline to preserve:
every client cache keys by full org-scoped path (true today for the image cache and
router cache), never bare entity ids.

**Sonnet-tier, no migration, buildable tomorrow, independent of everything else in
this doc.**

---

## P3 — Redt-It tenancy shapes (recommendation, decision is the founder's)

- **Shape A — per-org pools (status quo).** Zero RLS novelty, but it ships a
  *different, smaller product* than the draft describes (a shadchan's reach is one
  org). Honest as a v1 wedge; say so out loud if chosen.
- **Shape B — a dedicated pool org** (the Public Square pattern: joining the org =
  joining the pool). Structurally zero new RLS vocabulary — but it **inherits every
  P1 finding**, and two bind hard: P1-1 (joining must NOT expose your email — that
  gating IS the module's product) and P1-4 (matchmakers search the pool; **singles
  must not enumerate each other** — module positions do the gating, with the
  org-member floor deliberately weaker than in trusted orgs). Its staff seats read
  real dating data platform-wide: high-trust appointments only. And it is **its own
  org, NOT Public Square** — the platform-wide org must not become a junk drawer
  where every network module's data commingles under one membership predicate.
- **Shape C — a platform-scoped data plane** (`ri_` tables without org_id). Buys
  nothing Shape B doesn't; costs the platform's single strongest invariant plus a
  second policy vocabulary to audit forever. **Recommend rejecting in writing.**

**Recommendation: Shape B.** The founder's separate-pools lean (Redt-It /
Make-a-Match / Speed Dating stay separate user pools) is **endorsed**, on updated
grounds: the modules have genuinely different consent postures
(assigned-matchmaker-sees-scores vs. event-scoped vs. any-matchmaker-reads-dossiers)
that a shared profile table would flatten to the weakest; modules never import each
other; extract-don't-speculate says merge pools only when a real client demands one
profile across two modules.

---

## D — The architectural line to commit to (proposed for docs/00, founder sign-off)

P1+P2+P3 together are the platform quietly growing a social-network layer — P1-1 is
that layer emerging *by accident*. The one sentence that stops every future feature
from re-litigating it:

> **Every shared or public space is an org; there is no non-org data plane. Orgs
> carry a trust class — `client` (vetted membership, today's defaults) or `network`
> (open/opt-in membership) — and any policy or default that widens visibility
> because two users share an org is presumed unsafe for `network` orgs until
> explicitly reviewed.**

The first clause keeps the existential invariant and rejects Shape C forever. The
second is what P1-1 proves is missing: nothing in the codebase records which
policies assume vetted membership. A one-column `orgs.kind` (or settings flag) gives
`shares_org_with()`, §7 defaults, roster policies, and module whitelists their hook —
and gives every future security review the checklist question: *"what does this do
in a network-class org?"*

---

## Decision checklist (all founder calls, none made yet)

1. Adopt the trust-class principle into docs/00 (and the `orgs.kind` column when
   built)? — gates everything below.
2. Choose the `profiles_select_shared_org` fix shape (P1-1 a or b). **Blocking for
   Public Square and Redt-It Shape B.**
3. Approve the Public Square charter: module whitelist, §7-default overrides,
   roster-read restriction, named owner, abuse path (P1-4/5/6).
4. Redt-It: confirm Shape B + separate pools (P3) → record in the module-7 draft's
   open questions.
5. Cross-org switching: approve the P2 shape → buildable immediately on Sonnet.

**Sequencing reality:** P2 can ship tomorrow. P1 and Redt-It are blocked behind
items 1–3, which are tenancy-core migrations touching `profiles` / `org_members` /
`is_org_member()` — exactly the work docs/15 §11 slice 3 already schedules. **Public
Square is not a new workstream; it is the acceptance test for that slice.**
