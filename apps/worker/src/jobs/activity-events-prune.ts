import postgres from 'postgres'

// platform.activity-events-prune — enforces the 90-day raw retention window on
// `activity_events` (docs/17 phase 2, founder decision 2 of 2026-08-10: 90 days
// raw + a permanent rollup that never expires).
//
// DELIBERATELY THE SAME WINDOW AS PHASE 1, so there is one retention number to
// remember rather than two, and this job is a near-copy of
// `login-events-prune.ts` for the same reason: two retention jobs that behave
// differently are two things to reason about at 4am.
//
// WHY THIS JOB DOES NOT USE THE SERVICE-ROLE CLIENT, unlike most jobs in this
// worker. `public.activity_events_prune()` is granted to NOBODY — not
// `authenticated`, not `service_role`, not `anon` — because it is one of only two
// functions on the platform that can delete from a log. The worker invokes it
// over its DIRECT database connection, where it already connects as the table
// owner (`postgres` locally; `postgres.<ref>` through the session pooler on prod,
// which is the same role), rather than through PostgREST. The consequence is the
// point: a leaked service-role key cannot prune. The function is also
// `security invoker`, so even a future migration that carelessly granted EXECUTE
// to `service_role` would still fail at the privilege layer, since that role
// holds no DELETE on the table.
//
// The function takes NO arguments — the retention window is a literal in its
// body, asserted at 90 days by the RLS suite — so there is nothing this caller
// can get wrong. It cannot narrow the window, widen it, or choose a predicate.
//
// IT DOES NOT TOUCH `activity_rollup`, and that is the whole reason the permanent
// half of the retention decision is safe. The rollup is maintained by the capture
// path at write time, so the founder's explicit requirement — "even if they did
// not engage in a while, we know at least the last time they did" — does not
// depend on this job running, running once, or running at all. This only ever
// deletes raw detail that has ALREADY been counted.
export async function runActivityEventsPrune(connectionString: string): Promise<number> {
  const sql = postgres(connectionString, { max: 1 })
  try {
    // `bigint` comes back as a string from the driver — Number() it once, here,
    // rather than letting a string masquerade as a count in the log line.
    const rows = await sql<{ pruned: string }[]>`select public.activity_events_prune() as pruned`
    const pruned = Number(rows[0]?.pruned ?? 0)
    console.log(`[activity-events-prune] deleted ${pruned} raw activity event(s) past the 90-day window`)
    return pruned
  } finally {
    await sql.end()
  }
}
