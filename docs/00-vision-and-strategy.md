# Vision and Strategy

## Origin

Inspired by an IBM-style "we solve your problems" consulting team: go to a client, learn the problem over a weekend, build a software solution (sensors, data collection, analysis, monitoring), hand it over, move on. That model finishes cleanly but captures no compounding value — the software rots after handoff and every engagement starts from zero.

The founder has run a version of this for years using Google Suite (Sheets + Apps Script + shared docs) because it solved cross-platform data sharing. This platform is the generalization: replace Google Suite as the delivery vehicle with a platform we own.

## The model

**Productized consulting accumulating into vertical SaaS.**

- Each client engagement produces a **module**: a self-contained solution built on shared platform primitives.
- The client becomes a **user of the platform** with access to their module.
- Any client can be granted access to any existing module (per-org entitlements).
- Worst case: every client has exactly one module — still a fine business (productized consulting on shared infrastructure).
- Best case: modules find many clients each, and marginal cost of reselling module N to client M approaches zero.

Pricing philosophy: charge for the build (engagement) **plus a recurring subscription** that covers hosting, maintenance, and support. The "never finished" burden of keeping software alive is real and must be priced, not absorbed.

## Core principles

1. **Extract the platform from real modules; never build it speculatively.** Build the first 2–3 modules with tolerated duplication, then factor out what they actually share. Platforms designed up front guess wrong.
2. **One production deployment, one codebase, one database.** Multi-tenant. Never per-client deployments — every fix ships to everyone at once.
3. **Boring, mainstream technology.** Chosen for AI-assistant fluency (Claude Code, Copilot), hiring availability, and longevity. See docs/02.
4. **Local/cloud parity.** Everything runs locally in Docker exactly as it runs in the cloud. Code and test locally; push confidently.
5. **Least cost, least maintenance, most expandable** — in that tension, prefer managed services with open-source exit ramps (e.g., Supabase: managed now, self-hostable later).
6. **Conventions strict enough that AI can scaffold a module.** The economics depend on "new client → working module in days." That requires rigid module anatomy, exemplar modules, and docs an AI session can load cold (CLAUDE.md + docs/03).
7. **Tenancy isolation is the existential risk.** A data leak between client organizations kills the business. Row-level security from day one, on every table, no exceptions.

## The engagement playbook (target state)

1. Client describes problem (call/visit).
2. Write a module spec using the template in docs/03 (often with AI assistance during the conversation).
3. AI-scaffold the module against platform conventions; refine by hand.
4. Onboard client org, enable entitlement, load/import their data (Google Sheets connector eases migration from existing solutions).
5. Iterate with the client; hand them logins; subscription begins.

## Risks

- **Maintenance creep:** every live module generates support. Mitigate: keep modules thin, absorb complexity into shared primitives, price support in.
- **Over-fitting:** a module built for one client rarely generalizes without a deliberate second pass. Budget that pass before reselling a module.
- **Over-generalization:** the opposite trap — building configurability nobody asked for. Add flexibility only when a second real client needs it.
- **Tenancy leak:** see principle 7.
- **Solo-founder bus factor:** everything documented in this repo; no knowledge lives only in chat histories or one person's head.

## Maintainership

The founder codes alongside Claude Code (Apps Script/JavaScript background), and GitHub Copilot may join the mix. Consequences, decided 2026-07-06:

- **TypeScript**, but biased toward explicit, readable code: fewer clever abstractions, more inline documentation, standard patterns over framework magic.
- Docs written for both humans and AI sessions picking up cold.
