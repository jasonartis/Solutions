# Module 1: Make-a-Match — pure scoring core

**Spec of record:** [docs/modules/module-1-matchmaking.md](../../docs/modules/module-1-matchmaking.md) — all client decisions live there, dated. This file only records build-time choices made while implementing the pure logic in `src/scoring.ts` (no DB, no UI yet).

## Build-time decisions (2026-07-07)

- **Dealbreaker with care 0 is inert.** Care 0 means "don't care", so there is no expected position to enforce; the flag only bites when `care ≠ 0`. UI/persistence should prevent this combination, but the engine tolerates it.
- **`expectedPosition` with care 0 returns `myPosition`.** The value is never used by scoring (care-0 answers are skipped); returning the caller's own position is the least surprising placeholder.
- **A failed dealbreaker returns `score: null`.** The direction short-circuits immediately; the pair is excluded from all lists per spec, so no partial score is meaningful.
- **A null direction is absent, not zero.** `pairScore` averages only the directions that produced a score (a direction is null when that side has no cared-about overlap — e.g. all auto-answers). Both null → `percent: null`, not excluded, meaning "no signal", distinct from a genuine 0% mismatch.
- **`autoAnswer` does not apply admin locks.** It produces the spec's vanilla answer (middle position, care 0, `auto: true`). Materializing locked values (e.g. gender's locked care −10 + dealbreaker) is the persistence layer's job at answer-save time, since locks like `answer` cannot be sensibly defaulted (the user must still state their own gender).
- **Answers referencing unknown questions are skipped defensively** rather than throwing — the caller assembles the question map and stale answers must not poison a rescore batch.
- **Ties in `topMatches`** keep the input order among equal percents (plain descending sort by percent); no secondary tiebreak defined yet — revisit when display rules are decided.
- Zod v4, same package shape/versions as `modules/synagogue-schedules` (the exemplar module).

## Layout

- `src/scoring.ts` — Zod schemas (`questionSchema`, `answerSchema`) + engine (`expectedPosition`, `directionalScore`, `pairScore`, `autoAnswer`, `topMatches`).
- `src/scoring.test.ts` — vitest coverage incl. the spec's gender mechanic, auto-answer inertness, opposite-preference perfection, asymmetric overlap, one-directional dealbreaker exclusion.
