import Link from 'next/link'
import { requireSuperadmin } from '@/lib/platform'
import { canManage, getPositionsSnapshot, type PositionRow } from '@/lib/positions-console'

// The Owner Console's "Positions and authority" screen — every position on the
// platform, the rank the DATABASE gives it, and who can appoint or remove whom.
//
// WHY THIS IS A PAGE AND NOT A DOC. docs/rank-admission-map.md answers the same
// question but is GENERATED — it is only as current as the last time someone ran
// the test that writes it. This reads module_position_rank() live, so a rank
// changed by a migration shows up here on the next page load with no
// regeneration step and nothing to remember.
//
// It is READ-ONLY on purpose. Ranks are immutable config by deliberate design
// (docs/15 §4.1 item 5: a tenant-writable rank table would let someone set
// student = 5 and invert the ladder), so there is nothing here to edit — the
// screen exists to make the enforced ladder legible, not adjustable.

export const dynamic = 'force-dynamic'

function RankPill({ rank }: { rank: number }) {
  if (rank < 0) return <span className="rounded bg-red-100 px-1.5 py-0.5 text-xs text-red-700">unreadable</span>
  const tone =
    rank >= 3 ? 'bg-purple-100 text-purple-800'
    : rank === 2 ? 'bg-blue-100 text-blue-800'
    : rank === 1 ? 'bg-gray-200 text-gray-700'
    : 'bg-gray-100 text-gray-500'
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${tone}`}>{rank}</span>
}

export default async function PositionsConsolePage() {
  const { supabase } = await requireSuperadmin()
  const snap = await getPositionsSnapshot(supabase)

  const tierName = (rank: number) =>
    rank >= 4 ? 'module director'
    : rank === 3 ? 'global module authority'
    : rank === 2 ? 'runs one entity'
    : rank === 1 ? 'operational staff'
    : 'end user'

  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-1 text-sm">
        <Link href="/console" className="text-blue-600 hover:underline">
          ← Owner Console
        </Link>
      </div>
      <h1 className="mb-1 text-2xl font-semibold">Positions and authority</h1>
      <p className="mb-6 max-w-3xl text-sm text-gray-600">
        Every position on the platform and who can appoint or remove whom. Ranks are read from the database&rsquo;s
        own <code className="rounded bg-gray-100 px-1">module_position_rank()</code> on every load, so this is the
        ladder actually being enforced — not a copy that can go stale. Read at{' '}
        {new Date(snap.readAt).toLocaleString()}.
      </p>

      {snap.drifts.length > 0 && (
        <div className="mb-6 rounded border border-red-300 bg-red-50 p-3 text-sm">
          <p className="font-medium text-red-800">
            The database and the code disagree about {snap.drifts.length} rank
            {snap.drifts.length === 1 ? '' : 's'}.
          </p>
          <p className="mt-1 text-red-700">
            SQL is the authority and is what this page shows. The TypeScript table in{' '}
            <code>view-as-modules.ts</code> must mirror it, and a test normally catches this — so seeing it here
            means that test is not running, or a migration landed without its code half.
          </p>
          <ul className="mt-2 list-inside list-disc text-red-700">
            {snap.drifts.map((d) => (
              <li key={`${d.moduleKey}/${d.role}`}>
                {d.moduleKey}/{d.role}: database says {d.sqlRank}, code says {d.tsRank}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="mb-8 rounded border border-gray-200 bg-gray-50 p-4">
        <h2 className="mb-2 text-sm font-semibold">The rules, in order</h2>
        <ol className="list-inside list-decimal space-y-1 text-sm text-gray-700">
          <li>
            <strong>Org owners, org admins and superadmins bypass all of this.</strong> They can appoint or remove
            anyone in their org regardless of rank. Everything below describes only module staff acting on their own
            authority.
          </li>
          <li>
            <strong>To touch grants at all you need rank 2 or higher.</strong> Every write policy on the grants table
            requires it, so rank 1 and rank 0 holders can appoint nobody — even someone below them.
          </li>
          <li>
            <strong>Then you must strictly outrank the seat,</strong> and your own grant&rsquo;s scope must cover it. A
            professor pinned to one class can enroll into that class and nowhere else.
          </li>
          <li>
            <strong>Nobody can change their own seat,</strong> at any rank.
          </li>
        </ol>
        <p className="mt-2 text-sm text-gray-600">
          Rank decides <em>who appoints whom</em>. It does not decide who sees what — a GA and a student are both rank
          1 with entirely different views. For that question use{' '}
          <Link href="/console/view-as" className="text-blue-600 hover:underline">
            View as anything
          </Link>
          .
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-sm font-semibold">The generic ladder</h2>
        <p className="mb-2 max-w-3xl text-sm text-gray-600">
          These four words resolve to the same rank in <em>every</em> module — they are the fallback any unrecognised
          role drops through. No module actually grants them today, but they are valid strings, so a grant written by
          hand with one of these names would carry real authority.
        </p>
        <div className="flex flex-wrap gap-2 text-sm">
          {snap.generic.map((g) => (
            <span key={g.role} className="rounded border border-gray-200 px-2 py-1">
              <code>{g.role}</code> <RankPill rank={g.rank} /> <span className="text-gray-500">{tierName(g.rank)}</span>
            </span>
          ))}
        </div>
      </section>

      {snap.modules.map((mod) => {
        const real = mod.positions.filter((p) => p.rank >= 0)
        const managers = real.filter((p) => p.rank >= 2)
        return (
          <section key={mod.key} className="mb-8 rounded border border-gray-200">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2">
              <h2 className="font-semibold">{mod.name}</h2>
              <span className="text-xs text-gray-500">
                <code>{mod.key}</code> ·{' '}
                {mod.scopeNodes > 0
                  ? `${mod.scopeNodes} scope node${mod.scopeNodes === 1 ? '' : 's'} (grants can be pinned to one)`
                  : 'no scope nodes — every grant is module-wide'}
              </span>
            </div>

            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Position</th>
                  <th className="px-4 py-2 font-medium">Rank</th>
                  <th className="px-4 py-2 font-medium">Tier</th>
                  <th className="px-4 py-2 font-medium">Live grants</th>
                  <th className="px-4 py-2 font-medium">Can appoint / remove</th>
                </tr>
              </thead>
              <tbody>
                {mod.positions.map((p: PositionRow) => {
                  const targets = real.filter((q) => q.role !== p.role && canManage(p, q, mod.scopeNodes).ok)
                  const selfRule = canManage(p, p, mod.scopeNodes)
                  return (
                    <tr key={p.role} className="border-t border-gray-100 align-top">
                      <td className="px-4 py-2">
                        <code>{p.role}</code>
                        {p.undeclared && (
                          <span
                            className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
                            title="Granted in the database but not in this module's declared vocabulary"
                          >
                            undeclared
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        <RankPill rank={p.rank} />
                      </td>
                      <td className="px-4 py-2 text-gray-600">{p.rank >= 0 ? tierName(p.rank) : '—'}</td>
                      <td className="px-4 py-2 text-gray-600">
                        {p.grants === 0 ? (
                          <span className="text-gray-400">none</span>
                        ) : (
                          <>
                            {p.grants}
                            {p.scopedGrants > 0 && (
                              <span className="text-gray-500"> ({p.scopedGrants} scoped)</span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-2">
                        {targets.length === 0 && !selfRule.ok ? (
                          <span className="text-gray-400">
                            nobody — {canManage(p, real.find((q) => q.rank < p.rank) ?? p, mod.scopeNodes).why}
                          </span>
                        ) : (
                          <span className="text-gray-700">
                            {targets.map((t) => t.role).join(', ') || '—'}
                            {selfRule.ok && (
                              <span className="text-gray-500">
                                {targets.length > 0 ? ', ' : ''}
                                {p.role} (only into a narrower scope)
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            {managers.length === 0 && (
              <p className="border-t border-gray-100 px-4 py-2 text-xs text-gray-500">
                No position in this module reaches rank 2, so <strong>only an org owner or admin</strong> can grant or
                revoke anything here.
              </p>
            )}
          </section>
        )
      })}
    </div>
  )
}
