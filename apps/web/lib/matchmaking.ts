// The recompute implementation lives in the module (docs/03 composition);
// this re-export keeps the app-side import path stable. It runs AS the
// caller under RLS from the admin button, and via the service role from the
// worker's rescore tick - one implementation, two callers.
export { recomputeMatches } from '@modules/matchmaking'
