# Agents: read CLAUDE.md first

**[CLAUDE.md](CLAUDE.md) is this repository's operating manual for ALL AI
tools** (the name is historical — it applies to Copilot, Cursor, and any
other agent equally). It contains the current-state log, the model/capability
guidance, and links to every convention. Do not work in this repo without it.

Non-negotiables, regardless of tool:

1. Every schema/RLS/trigger change follows docs/03 #12: draft →
   security-review → LIVE verification. Migrations are forward-only,
   additive-first; destructive SQL requires the founder's explicit approval
   plus the `DESTRUCTIVE-CHANGE-APPROVED` marker (CI blocks it otherwise).
2. The service-role key exists ONLY in the worker — never in web code.
3. Never bypass CI (`--no-verify`, pushing around a red build). Deploys only
   happen on green; keep it that way.
4. Any UI change updates that module's walkthrough
   (`modules/<key>/help/guides.ts`) in the same commit.
5. Run `pnpm backup:prod` before anything risky touches production.
6. If your capabilities are light for security-sensitive work, say so and
   recommend a stronger model — do not push through quietly.
7. Migrations are APPEND-ONLY (CI enforces it) — never edit an applied one.
8. Never delete or weaken a test to get a green build (CI ratchets the test
   count) — when a guard blocks you, the guard is right: stop and report.
9. Prod DB access only via pnpm migrate:prod / backup:prod / worker:prod —
   never supabase link, never ad-hoc connections.

The full safeguards, never-do list, and recovery playbook:
[docs/12-safeguards.md](docs/12-safeguards.md).
