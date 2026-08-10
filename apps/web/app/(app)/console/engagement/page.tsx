import Link from 'next/link'
import { requireSuperadmin } from '@/lib/platform'
import {
  allPeople,
  getNewestCapturedLogin,
  getOrgMembers,
  getPersonEngagement,
  getQuietestMembers,
  type EngagementRow,
  type OrgEngagementRow,
  type PlatformEngagementRow,
} from '@/lib/engagement'

// Engagement monitoring, phase 3 — the console page (docs/17-engagement-monitoring.md).
//
// "WHO HAS GONE QUIET, AND WHO SHOULD I REACH OUT TO" — a THIRD question,
// distinct from the other two console tools (docs/03 #19 requires saying so,
// not just here): the data browser answers "what do I hold about this
// person", view-as answers "what does this person see", this one answers
// "who has stopped using the platform".
//
// A LOGIN HAS NO ORG (§3). The "by organization" section below shows a
// member's PLATFORM login activity, not activity IN that org — a login
// cannot be attributed to one, and the page says so rather than implying
// otherwise.
//
// Superadmin-only, ordinary RLS client, no `.rpc()`, no service-role — same
// keystone as the other two console tools. See lib/engagement.ts's header.

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function relative(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 60) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

function absolute(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

type Props = {
  searchParams: Promise<{ org?: string; person?: string }>
}

export default async function EngagementPage({ searchParams }: Props) {
  const { supabase } = await requireSuperadmin()
  const sp = await searchParams

  const [newestCaptured, quietest, { data: orgsData }, people] = await Promise.all([
    getNewestCapturedLogin(supabase),
    getQuietestMembers(supabase, 20),
    supabase.from('orgs').select('id, name, slug').order('name'),
    allPeople(supabase),
  ])
  const orgList = orgsData ?? []
  const org = orgList.find((o) => o.id === sp.org) ?? null
  const orgEngagement = org ? await getOrgMembers(supabase, org.id) : null

  const person = sp.person ? people.find((p) => p.userId === sp.person) ?? null : null
  const personEngagement = person ? await getPersonEngagement(supabase, person.userId) : null

  // The honesty badge (§8b item 1, §10 point 4): the capture trigger swallows
  // its own errors so it can never take a sign-in down with it, which makes a
  // capture failure SILENT. This is the one signal this schema can give
  // without `auth` access — how long since ANYONE's login was last captured,
  // platform-wide. It cannot prove capture is broken (there is no ground
  // truth to compare it against on this path), only give a human who knows
  // the platform's real usage something to notice.
  const captureStale = newestCaptured ? Date.now() - new Date(newestCaptured).getTime() > THIRTY_DAYS_MS : true

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-1 flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Engagement</h1>
        <Link href="/console" className="text-sm text-blue-600 hover:underline">
          ← Owner Console
        </Link>
      </div>
      <p className="mb-4 max-w-3xl text-sm text-gray-600">
        <strong>Who has gone quiet, and who should I reach out to</strong> — not the same question
        as the other two console tools:{' '}
        <Link href="/console/data-browser" className="text-blue-600 hover:underline">
          data browser
        </Link>{' '}
        answers what I hold about a person,{' '}
        <Link href="/console/view-as" className="text-blue-600 hover:underline">
          view-as
        </Link>{' '}
        answers what a person sees. This one answers who is still using the platform.
      </p>
      <p className="mb-6 max-w-3xl rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-500">
        A sign-in is a <strong>platform</strong> event, not an org one — nothing records which org
        someone was using when they logged in. So &ldquo;by organization&rdquo; below shows a
        member&rsquo;s platform login activity, not activity <em>in</em> that org, and a person can
        show as active here while actually using a different org entirely.
      </p>

      {/* THE HONESTY BADGE. Always rendered — a badge is a claim to the
          operator, and this one must never be buried behind a picker. */}
      <div
        className={`mb-6 rounded-lg border p-3 text-sm ${
          captureStale ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-gray-200 bg-white text-gray-700'
        }`}
      >
        <strong>Newest captured login:</strong>{' '}
        {newestCaptured ? (
          <>
            {relative(newestCaptured)} ({absolute(newestCaptured)})
          </>
        ) : (
          'none — no login has ever been captured'
        )}
        {captureStale && (
          <p className="mt-1 text-xs">
            That is over 30 days ago (or there has never been one). Capture failures are silent by
            design — the trigger that writes this never blocks a sign-in — so if people have been
            signing in more recently than this, that is worth investigating rather than trusting
            this page&rsquo;s silence.
          </p>
        )}
      </div>

      {/* PLATFORM-WIDE LANDING VIEW. The direct answer to "who should I reach
          out to" with nothing picked — of 12 prod users at ship time, 7 had
          never signed in, which is most of this feature's value. */}
      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-gray-700">Quietest across the platform</h2>
        <p className="mb-3 text-xs text-gray-500">
          Every active member of every org, quietest first. &ldquo;Never signed in&rdquo; means no
          capture has ever seen them — not an error.
        </p>
        <EngagementTable rows={quietest} extraColumn={(r) => r.orgNames.join(', ')} extraLabel="Orgs" />
        {quietest.length === 0 && <p className="text-sm text-gray-400">No active members on the platform yet.</p>}
      </section>

      {/* ORG -> PEOPLE DIRECTION (§1). */}
      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">By organization</h2>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Organisation
            <select name="org" defaultValue={org?.id ?? ''} className={inputCls}>
              <option value="">— pick an org —</option>
              {orgList.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
            Show
          </button>
        </form>

        {org && orgEngagement && (
          <>
            {orgEngagement.pendingCount > 0 && (
              <p className="mb-3 text-xs text-gray-500">
                {orgEngagement.pendingCount} pending invite{orgEngagement.pendingCount === 1 ? '' : 's'} excluded —
                not yet accepted, so not counted as quiet members.
              </p>
            )}
            <EngagementTable rows={orgEngagement.active} extraColumn={(r) => r.orgRole} extraLabel="Org role" />
            {orgEngagement.active.length === 0 && (
              <p className="text-sm text-gray-400">No active members in this org.</p>
            )}
          </>
        )}
      </section>

      {/* PERSON -> ORGS DIRECTION (§1). */}
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">By person</h2>
        <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Person
            <select name="person" defaultValue={person?.userId ?? ''} className={inputCls}>
              <option value="">— pick a person —</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>
                  {p.displayName}
                  {p.email && p.email !== p.displayName ? ` (${p.email})` : ''}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
            Show
          </button>
        </form>

        {person && personEngagement && (
          <>
            <p className="mb-3 text-sm text-gray-700">
              <strong>{personEngagement.displayName}</strong> — last signed in{' '}
              <strong>{relative(personEngagement.lastLoginAt)}</strong>
              {personEngagement.lastLoginAt && <> ({absolute(personEngagement.lastLoginAt)})</>}. Signed in{' '}
              {personEngagement.loginsLast30d} time{personEngagement.loginsLast30d === 1 ? '' : 's'} in the last 30
              days.{' '}
              <span className="text-xs text-gray-500">
                ({personEngagement.observedLogins} observed since {absolute(personEngagement.observedSince) || 'capture began'} — not a
                lifetime total.)
              </span>
            </p>
            <p className="mb-2 text-xs text-gray-500">
              Member of, currently — not where they&rsquo;ve been active (a login has no org):
            </p>
            <ul className="space-y-1 text-sm text-gray-700">
              {personEngagement.orgs.map((o) => (
                <li key={o.id}>
                  {o.name} <span className="text-xs text-gray-400">({o.role})</span>
                </li>
              ))}
              {personEngagement.orgs.length === 0 && <li className="text-gray-400">No active org memberships.</li>}
            </ul>
          </>
        )}
      </section>
    </main>
  )
}

function EngagementTable<T extends EngagementRow>({
  rows,
  extraColumn,
  extraLabel,
}: {
  rows: T[]
  extraColumn: (row: T) => string
  extraLabel: string
}) {
  if (rows.length === 0) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-gray-200 text-gray-400">
            <th className="py-1 pr-3 font-medium">Person</th>
            <th className="py-1 pr-3 font-medium">{extraLabel}</th>
            <th className="py-1 pr-3 font-medium">Last login</th>
            <th className="py-1 pr-3 font-medium">Last 30 days</th>
            <th className="py-1 font-medium">
              Observed logins{' '}
              <span className="font-normal text-gray-300" title="Not a lifetime total — counts only since capture began for this row">
                (since capture)
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId} className="border-b border-gray-100 last:border-0">
              <td className="py-1 pr-3 text-gray-700">
                {r.displayName}
                {r.email && r.email !== r.displayName ? <span className="text-gray-400"> ({r.email})</span> : null}
              </td>
              <td className="py-1 pr-3 text-gray-600">{extraColumn(r)}</td>
              <td className="py-1 pr-3">
                {r.lastLoginAt ? (
                  <span title={absolute(r.lastLoginAt)}>{relative(r.lastLoginAt)}</span>
                ) : (
                  <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                    never signed in
                  </span>
                )}
              </td>
              <td className="py-1 pr-3 text-gray-600">{r.loginsLast30d}</td>
              <td className="py-1 text-gray-500">{r.observedLogins}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
