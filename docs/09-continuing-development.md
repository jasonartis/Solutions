# Continuing Development — starting a fresh Claude session

Losing a chat loses **nothing**: all project knowledge lives in this repo (docs/, CLAUDE.md,
code, git history) plus Claude's persistent memory for this folder. This page is the
restart procedure.

## The 10-second restart

1. Open Claude Code **in `d:\Solutions Platform`** (the folder matters — CLAUDE.md and
   Claude's memory auto-load from it).
2. Paste this starter prompt:

> Read CLAUDE.md (you'll see the current state at the top) and docs/04-build-plan.md.
> Continue development from where the current-state section says we left off — same
> working style as before: keep moving autonomously, ask me as little as possible,
> parallelize with agents where it helps, keep docs/CLAUDE.md current, and run the
> full test suites before every push.

That's it. Claude re-orients from CLAUDE.md's dated "Current state" entries (kept
current as a working agreement) and picks up the build plan.

## What loads automatically vs. what to mention

- **Automatic:** CLAUDE.md (conventions + current state), Claude's memory (your
  preferences: autonomy, explicit TypeScript, sandboxed commands), all docs when read.
- **Worth mentioning if relevant that day:** anything *you* did outside the repo since
  the last session (e.g. "I got new myzmanim credentials", "I created the Hetzner
  account", "the walkthrough failed at step 5").
- **Never needed:** re-explaining the project, the stack, past decisions — those are in
  docs/ and the module SPECs with dates.

## Where the threads live

| Thread | File |
|---|---|
| What's done / in flight / parked | CLAUDE.md "Current state" (top entry) |
| Build order + acceptance bars | docs/04-build-plan.md |
| Per-module decisions (dated) | docs/modules/*.md + modules/*/SPEC.md |
| Parked issues with pickup context | the relevant SPEC.md (e.g. myzmanim in module 3's) |
| Your own prompt history | D:\Jason_prompts\sessions\ (via /log-session) |

## Adding module 7, 8, … the designed way

**docs/03-adding-a-module.md is the instruction set** — anatomy, hard rules, the
step-by-step checklist, the SPEC template, the AI-agent workflow, and the conventions
proven by real modules (updated after each extraction pass). The short version of the
designed flow:

1. Client conversation → write `docs/modules/module-N-<name>.md` + the module's SPEC.md
   using the template (decisions dated).
2. Point Claude (or an agent) at CLAUDE.md + docs/03 + the SPEC + the exemplar module
   (`modules/synagogue-schedules`) — scaffold: schema+RLS+grants migration, manifest,
   pages behind `requireOrgModule()`, worker jobs via `job_requests`, seed, tests.
3. Acceptance = reproduce the client's real artifact from their real data as a test.
4. Enable the entitlement for their org in the Owner Console; onboard users.
5. New shared behavior gets extracted into `packages/platform` and added to docs/03's
   conventions list — never copied between modules.
