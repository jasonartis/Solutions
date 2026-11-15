import Link from 'next/link'
import { cookies } from 'next/headers'
import { requireSuperadmin } from '@/lib/platform'
import { VIEW_AS_COOKIE, realViewConfigured } from '@/lib/view-as-real'

// SEE THEIR REAL SCREEN (docs/13 "REAL VIEW-AS" → "THE DESIGN", 2026-11-12).
// Pick a person in an org that has Classroom on; their classroom pages then
// render exactly as they see them, read-only, with a banner on every screen.
// The database decides who may be viewed and logs every view and page.

type Props = { searchParams: Promise<{ error?: string }> }

const btn = 'rounded bg-gray-900 px-3 py-1 text-sm text-white hover:bg-gray-700'

export default async function RealViewPage({ searchParams }: Props) {
  const { supabase } = await requireSuperadmin()
  const { error } = await searchParams
  const open = (await cookies()).get(VIEW_AS_COOKIE)?.value

  const [orgs, entitlements, members, profiles, recent] = await Promise.all([
    supabase.from('orgs').select('id, name, slug').order('name'),
    supabase.from('org_modules').select('org_id').eq('module_key', 'classroom').eq('enabled', true),
    supabase.from('org_members').select('org_id, user_id, role, status'),
    supabase.from('profiles').select('user_id, display_name'),
    supabase
      .from('view_as_real_sessions')
      .select('id, target_user_id, org_id, created_at, ended_at, expires_at')
      .order('created_at', { ascending: false })
      .limit(10),
  ])
  const failed = [orgs, entitlements, members, profiles, recent].find((r) => r.error)
  if (failed?.error) throw new Error(`real view-as read failed: ${failed.error.message}`)

  const on = new Set((entitlements.data ?? []).map((e) => e.org_id as string))
  const nameOf = new Map((profiles.data ?? []).map((p) => [p.user_id as string, (p.display_name as string) || 'Unnamed member']))
  const orgName = new Map((orgs.data ?? []).map((o) => [o.id as string, o.name as string]))
  const classroomOrgs = (orgs.data ?? []).filter((o) => on.has(o.id as string))
  const status = (s: { ended_at: unknown; expires_at: unknown }, now: number) =>
    s.ended_at ? 'stopped' : Date.parse(s.expires_at as string) < now ? 'expired' : 'open'
  const now = new Date().getTime()

  return (
    <div className="max-w-3xl">
      <Link href="/console" className="text-sm text-blue-600 hover:underline">
        ← Owner Console
      </Link>
      <h1 className="mt-2 mb-1 text-2xl font-semibold">See their real screen</h1>
      <p className="mb-4 text-sm text-gray-600">
        Opens a person&rsquo;s own Classroom pages, built by the same screens they use, for 30 minutes. It is
        read-only: the database refuses every change, and forms cannot be sent. Every view and every page you open is
        logged. A banner on every screen says whose screen it is. Only Classroom is available so far.
      </p>

      {!realViewConfigured() && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="real-view-unconfigured">
          Not configured on this server: the SUPABASE_JWT_SECRET setting is missing, so no view can start.
        </p>
      )}
      {error && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="real-view-error">
          {error}
        </p>
      )}
      {open && (
        <p className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          A view is open. Stop it (the banner&rsquo;s Stop viewing button) before starting another.
        </p>
      )}

      {classroomOrgs.length === 0 && <p className="text-sm text-gray-500">No organization has Classroom on.</p>}
      {classroomOrgs.map((o) => {
        const people = (members.data ?? [])
          .filter((m) => m.org_id === o.id && (m.status ?? 'active') === 'active')
          .map((m) => ({ id: m.user_id as string, name: nameOf.get(m.user_id as string) ?? 'Unnamed member', role: m.role as string }))
          .sort((a, b) => a.name.localeCompare(b.name))
        return (
          <form key={o.id as string} action="/view-as/start" method="post" className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-white p-3" data-testid="real-view-org">
            <span className="font-medium text-gray-900">{o.name as string}</span>
            <input type="hidden" name="org" value={o.id as string} />
            <input type="hidden" name="slug" value={o.slug as string} />
            <label className="sr-only" htmlFor={`target-${o.id}`}>
              Person in {o.name as string}
            </label>
            <select id={`target-${o.id}`} name="target" className="rounded border border-gray-300 px-2 py-1 text-sm" required>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.role})
                </option>
              ))}
            </select>
            <button type="submit" className={btn} disabled={!!open || !realViewConfigured()}>
              See their screen
            </button>
          </form>
        )
      })}

      <h2 className="mt-8 mb-2 text-sm font-semibold text-gray-700">Recent real views</h2>
      {(recent.data ?? []).length === 0 ? (
        <p className="text-sm text-gray-500">None yet.</p>
      ) : (
        <ul className="text-sm text-gray-700" data-testid="real-view-recent">
          {(recent.data ?? []).map((s) => (
            <li key={s.id as string}>
              {new Date(s.created_at as string).toLocaleString('en-US')} ·{' '}
              {nameOf.get(s.target_user_id as string) ?? 'someone'} in {orgName.get(s.org_id as string) ?? 'a deleted org'} ·{' '}
              {status(s, now)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
