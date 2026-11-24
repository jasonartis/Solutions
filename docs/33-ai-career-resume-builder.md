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
