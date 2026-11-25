# AI Career Resume Builder — idea and design notes (NOT BUILT, NOT STARTED)

> **Status 2026-11-24: planning only. Nothing built. Do not start without the founder initiating it.** Written at the
> founder's instruction ("document this") from the 2026-10/11 planning chat. **Each statement is labelled: FOUNDER =
> his decision in his own words; PROPOSED = the assistant's suggestion he did not explicitly accept; OPEN = unanswered.**
> Never read a PROPOSED line as decided. Legal questions: [docs/31](31-questions-for-a-lawyer.md) B1–B10.
> Related: [docs/32](32-prod-copy-for-development.md) (dev copy), [docs/34](34-disclosures-page.md) (disclosures).

## 1. The idea (FOUNDER)

It came from his own experience with a chatbot: it analysed a job description, asked many questions, and wrote a
"truthful but tailored resume"; later job descriptions reused the earlier facts. He wants to extend this later to
dating profiles and "any two sided search". **"Let's start with a career resume builder."** Dating comes later.
v1 scope agreed: **resume lines only, no cover letter.**

## 2. Module or tool? (FOUNDER, 2026-11-24 — to discuss "when we get to it")

> "perhaps this should be a tool rather than a module and the tool can be used in many places, like speeddating pairing
> and AI using vault data for a make-a-match 'use AI to decide for me slider settings setup or others.' We might need the
> idea of a tool that multiple modules can access rather than an isolated module."

Consequence to remember: the platform rule today is "modules never import other modules; shared behaviour goes through
`packages/platform`, extracted when a SECOND module needs it" (docs/00, docs/03). A cross-module AI tool is the second
use the founder is already naming. **OPEN: tool vs module, and what a tool's access boundary is.** The assistant's earlier
PROPOSAL (build inside the module first, extract at the second use) is overridden for discussion by this remark.

## 3. Costs (FOUNDER: "Cost levels - agree")

Three cap levels: **platform stop, per org, per user**, with meters ("some sort of status bar") that show as each level
nears its limit. The superadmin sees a tree: (1) platform-wide, (1.1) per org, (1.1.1) per org per module, (1.2) per
user, (1.2.1) per user per module. PROPOSED: absorb the cost; meters warn at ~80% and show a message at 100%; the
platform cap is shown to the superadmin only; a provider spend backstop; estimate under 1 cent per session, roughly
$12–120 a month at 3,000 sessions (unconfirmed). He asked for a free tier that works during development and is
"paid and private at the flip of a switch."

## 4. The review loop (FOUNDER)

AI reviewers act as "the people running the search", iterate, and "come back with more questions". On scores:
"'Caveats: the scores are AI opinions,' — that is why we might need more than one reviewer and see the overlap and use
that to judge opinion or 'truth'." PROPOSED: reviewers may only ask questions or suggest emphasis, never add facts;
cap of 3 rounds (OPEN: exact cap); the UI labels scores "advisory".

## 5. The vault (PROPOSED — ownership OPEN)

A "vault" is a personal pile of facts: one entry per fact or story, with tags and a date, kept by the person.
PROPOSED: a person-owned, owner-only platform-level table, not an `org_id` module table (this would need a recorded
exception to the org_id rule, an account-deletion entry with a test, and tests that the superadmin sees nothing).
The assistant itself flagged this as "in question" once the founder demanded full access (§7). **OPEN: person vs org
ownership was never confirmed.** The founder only noted speed-dating notes as a comparable author-only precedent.

## 6. Truthfulness (PROPOSED — the founder did not respond to the specifics)

Each generated line cites exactly one vault entry (ids checked server-side against the caller's own vault); numbers,
names and dates must match; "led/managed" blocked unless supported; per-line approval; the job description treated as
untrusted input (prompt injection); the UI shows verified / not-verified labels. Liability question: docs/31 B9.

## 7. Access, consent and the AI vendor

- **FOUNDER (operational data):** "I think it is vital that I have full access even to all data." "I don't think I can
  allow an org to keep their data private from my development." "Operational data yes." **"To not have access,
  prevents development, I don't think this is a possibility, ever"** — a "no development access" tier is rejected.
- **FOUNDER (the safety wording, accepted):** "Only you can see it. Access may be available for safety or support, only
  when needed, and a record of such activity is kept." He accepted that it covers **safety and support only**; any other
  purpose (product improvement, AI-assisted development) needs its own sentence. OPEN: whether the sentence stays as is.
- **FOUNDER (per-user choice):** "Perhaps each user has the choice and selects it when starting to use a product? So the
  user gets to uncheck 'Allow your data to be used to better the platform', maybe other checkmarks."
- PROPOSED boxes (shown at first use of a module, changeable in /account, logged, enforced in the database): safety/support
  — required; AI processing — required for AI features; improve the platform — optional; aggregate statistics —
  optional; outreach about unused features — optional. PROPOSED default unchecked (an EU opt-in point; not legal advice).
  Two layers: org-level terms for work data, user-level boxes for personal data. OPEN: defaults and the final list
  (docs/31 B6); whether personal disclosures (vault, notes, dating) keep a user opt-out against development access.
- PROPOSED support access to a vault: a required reason, a time limit, a banner, a permanent log; maybe the user must
  grant it first, or a break-glass path. The founder never chose between those. A future "sign in as the user" support
  session is something he said to keep in mind.
- **Vendor (PROPOSED):** the paid Claude API (Haiku or Sonnet), not the models with 30-day retention (the "Covered Models");
  free tiers (Gemini, OpenAI, OpenRouter, Groq) rejected for real data because they use or may use inputs; development uses
  a mock or synthetic data; a provider switch with NO default (prod refuses to start if unset); every output records its
  model. The vendor's commercial retention article has NOT been read (docs/31 B8).

## 8. Same example the founder gave for operational access

A prospective client who imports accessories from overseas and sells to US stores, using disparate systems. He would map
their flow, make accounts for every role and be handed spreadsheets and ledgers: "I need to view and act like them … see
everything they see as they see it at every level in the hierarchy." This is OPERATIONAL data, not personal disclosure,
and it led to real view-as (docs/13) and the prod copy (docs/32).

## 9. Open list (nothing here is answered)

Vault ownership; tool vs module; user opt-out for personal disclosures; consent defaults and the box list; whether
the safety sentence changes; disclosure that AI-assisted development sends client data to an AI vendor (docs/31 B2);
whether a vault needs a user grant for support; the review-loop cap and truthfulness rules; the vendor's retention terms
(B8); truthfulness liability (B9); a lawyer review before real clients.

## 10. Reasoning and review findings behind the above (recovered 2026-11-25 from the planning chat)

**All of this is the assistant's analysis and three reviewers' claims, NOT founder decisions.** Reviewers did not all read
the repo; items marked (unverified) must be checked against the repo before anyone relies on them.

**Why vault ownership is a real question.** On this platform data normally belongs to an organization and org admins and the
superadmin can read it. A vault is closer to a private diary (layoffs, gaps, visa status, conflicts with a boss).

| | Belongs to the person | Belongs to one org |
|---|---|---|
| Example | Dana's vault follows her if she joins another org | A university career-centre org holds Dana's vault; she loses it if she leaves |
| Who can read it | Only Dana | Dana, plus org admins and the superadmin by the platform's usual rules |
| Fit with platform rules | A new pattern, like `user_private` | Familiar, but admins would see her life story |

The assistant leaned person-owned. Ownership review findings (unverified): (a) **account deletion uses a hand-maintained
list**, so a forgotten vault would survive deletion forever — needs an explicit entry plus a test; (b) **copying the nearest
existing policy would give the superadmin a read arm** — the vault needs its own policy and tests proving the superadmin sees
nothing; (c) **docs/03 says every table has `org_id`**, so this needs a recorded exception; (d) honest wording is "not
readable through the app or normal access" — the database owner and backups can still technically read it, and only
encryption with a key the user holds would change that (nobody has evaluated it); (e) leaving an org: keep read and export
of your own vault, no new content until entitled again; (f) who pays when several orgs grant the module is unanswered (the
assistant's answer: each org's cap counts its own members' use).

**Design-review findings (unverified):** (1) a career vault is sensitive and goes to a third party; `/privacy` names no
processors today, and "not used for training" cannot be promised until the account's real terms are read; (2) ownership (above);
(3) "every line cites a vault entry" does not stop "assisted" becoming "led" — do not claim "truthful by construction";
(4) a pasted job description is untrusted (prompt injection): give the model only the selected entries and no tools;
(5) platform fit: this is the platform's FIRST AI call (no precedent for key handling or timeouts), chat streaming probably
needs a route handler (a new pattern), the worker is not running on prod so everything runs inline, tests must mock the model,
keep dating profiles out of v1; (6) no usage limits exist today: per-user token cap, a kill switch and `org_modules`
entitlement checks needed.

**Truthfulness review (unverified, repo not read):** what a "numbers and names match" check misses — verb strengthening
(assisted → led), scope inflation ("team of 3 interns" → "managed a team"), dropped caveats ("volunteer", "pilot"), derived
facts ("3 years" computed from two dates). Proposed v1 rules: one cited entry per sentence; numbers/dates/names must appear
in the entry; "led/managed" blocked unless supported; no cover letter in v1 (connecting prose has no source entry; later as
templates around cited lines); the screen says "Verified: numbers, names, dates. Not verified: meaning and emphasis."
Server trust: the SERVER stores the interview history (a client-sent one can be forged); entry ids are checked against the
caller's own vault; the user's own words are kept verbatim beside any AI summary; the job description goes in a labelled
untrusted block; **a separate checker call never sees the job description**. Ten test cases were proposed (a transposed
digit, a forged entry id, a malicious job description…) plus **a check that the verifier actually ran, so a test cannot pass
vacuously**.

**Provider switch (proposed):** like the video provider (`SPEED_DATING_VIDEO_PROVIDER`): one setting, **no default — prod
refuses to start if unset, no silent fallback to mock or free**; preview deployments get the mock only and never the paid
key; every generated resume records its model; a free tier may only receive entries flagged synthetic; before any real client,
run a handful of tests against real Claude with fake data (a mock passing proves little about real behaviour). Development can
use a built-in mock (free, good for tests) and/or a free tier with synthetic data only.

**Free-tier research (reviewer-fetched 2026-11, prices unconfirmed — re-fetch before relying):** Google Gemini free tier —
content may be used to improve Google products, unsuitable for real data; OpenAI free tokens only if you opt in to data
sharing, unsuitable; OpenRouter/Groq free models — no clear data policy, unsuitable; self-hosted open model — needs a GPU
server and ops, poor value at this volume; Claude API — no standing free tier (a small starter credit is unconfirmed), best
reported privacy position (no training on API content) but the retention terms still need reading. "The free tiers are free
because your users' data is the payment." Estimated under 1 cent per resume session, roughly $12–120 a month at 3,000
sessions (one figure looked unusually low).

**Who pays (options considered):** absorb it; per-user credits (needs a ledger); usage passthrough (needs billing, clients
dislike open-ended bills); bring-your-own-key (weak for non-technical clients); per-org budget with a hard cap (best fit for
the org-as-customer model). The assistant recommended absorbing with bounds; the founder agreed to the three cap levels (§3).

**Still to check before any plan is final:** the Anthropic account terms on training, retention and zero-data-retention
(the founder's to read; docs/31 B8) and Vercel's maximum function duration on the plan (decides whether chat streaming
works) — neither was ever checked.

## 11. The access discussion behind §7 (recovered 2026-11-25; assistant analysis, founder decisions marked)

**Two kinds of data.** *Operational work data* — what a client does to get its job done (renaming hundreds of PDFs with one
prefix, a year-over-year chart request: found by watching real work, not guessing). *Personal disclosures* — resume vault,
speed-dating notes, dating profiles (layoffs, health gaps, who someone liked). The superadmin already reads across orgs, has
view-as and activity capture; the owner-only vault would be the first place he cannot read, "only because we designed it that way".

**The two policies compared (scenario: Dana uses the resume builder through a client org; Acme's staff rename PDFs):**

| | A: superadmin sees everything, always | B: tiered |
|---|---|---|
| Acme's PDFs / time series | browsed freely | same |
| Dana's vault | readable anytime | needs Dana's grant, or a logged emergency reason |
| What Dana must be told | "Platform staff can read your vault to improve the product" | "Only you can see it. Access may be available for safety or support…" |
| Risk | users who read that may not sign up; if undisclosed, a trust and legal problem | cannot improve the builder from real vaults (use test data or volunteers who opt in) |

The assistant supported A for operational data and B for personal disclosures. **FOUNDER (operational data): position recorded —
full superadmin access to client work data is a stated engagement condition, with five protections (docs/31 B1).** He never
chose A or B for personal disclosures. **The agreed wording covers safety and support only, NOT "to improve the product"** —
that is a separate purpose needing its own sentence and, for client orgs, a line in their terms (docs/00 principle 8: purposes
are separate and set in code, not a blanket yes). Legal note (not advice): for a client org's data the platform is typically a
processor, and own-product improvement use may need the client's agreement (docs/31 B1).

**Options listed that give most of what he needs without reading personal text:** operational data read freely with a
client-agreement clause and a log; behaviour without content (activity events and aggregates such as "12 users renamed over 50
files in a week"); improvement partners who opt in to "help improve the product"; synthetic data; break-glass for the vault
with a mandatory reason and a log the user can see.
