import postgres from 'postgres'

// platform.login-events-prune — enforces the 90-day raw retention window on
// `login_events` (docs/17 §6, founder decision 2026-08-09: 90 days raw + a
// permanent rollup).
//
// WHY THIS JOB DOES NOT USE THE SERVICE-ROLE CLIENT, unlike every other job in
// this worker. `public.login_events_prune()` is the only function on the
// platform that can delete from a log, so it is granted to NOBODY: not
// `authenticated`, not `service_role`, not `anon` — only the table owner. The
// worker therefore invokes it over its DIRECT database connection, where it
// already connects as that owner (`postgres` locally; `postgres.<ref>` through
// the session pooler on prod, which is the same role), rather than through
// PostgREST. The consequence is the point: a leaked service-role key cannot
// prune. Full reasoning in the migration header, 20260809010000_login_events.sql.
//
// The function takes NO arguments — the retention window is a literal in its
// body, asserted at 90 days by the RLS suite — so there is nothing this caller
// can get wrong. It cannot narrow the window, widen it, or choose a predicate.
//
// It does not touch `login_rollup`. The rollup is maintained by the capture
// trigger at write time, so the permanent half of the retention decision does
// not depend on this job running at all; this only ever deletes detail that has
// already been counted.
export async function runLoginEventsPrune(connectionString: string): Promise<number> {
  const sql = postgres(connectionString, { max: 1 })
  try {
    // `bigint` comes back as a string from the driver — Number() it once, here,
    // rather than letting a string masquerade as a count in the log line.
    const rows = await sql<{ pruned: string }[]>`select public.login_events_prune() as pruned`
    const pruned = Number(rows[0]?.pruned ?? 0)
    console.log(`[login-events-prune] deleted ${pruned} raw login event(s) past the 90-day window`)
    return pruned
  } finally {
    await sql.end()
  }
}
