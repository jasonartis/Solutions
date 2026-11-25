import { PageHeader } from '@/components/page-header'
import { cookies } from 'next/headers'
import { requireSuperadmin } from '@/lib/platform'
import { VIEW_AS_COOKIE, realViewConfigured } from '@/lib/view-as-real'
import { PersonList, type Person } from './person-list'

// VIEW AS (docs/13 "REAL VIEW-AS" + "WHOLE-ACCOUNT VIEW AS", 2026-11-23).
// Pick ANY person; their whole account (dashboard, account, feedback and every
// organization page) then renders exactly as they see it, read-only, with a banner
// on every screen. The database decides who may be viewed. No page log and no
// notification (founder decision 2026-11-15); the session row is only the on/off switch.

type Props = { searchParams: Promise<{ error?: string; ended?: string }> }

export default async function RealViewPage({ searchParams }: Props) {
  const { supabase, userId } = await requireSuperadmin()
  const { error, ended } = await searchParams
  const open = (await cookies()).get(VIEW_AS_COOKIE)?.value

  const [orgs, members, profiles, privates] = await Promise.all([
    supabase.from('orgs').select('id, name'),
    supabase.from('org_members').select('org_id, user_id, status'),
    supabase.from('profiles').select('user_id, display_name'),
    // Other superadmins cannot be viewed; leave them out when this read allows it (the database refuses them anyway).
    supabase.from('user_private').select('user_id, is_superadmin'),
  ])
  const failed = [orgs, members, profiles].find((r) => r.error)
  if (failed?.error) throw new Error(`view-as read failed: ${failed.error.message}`)

  const ids = (profiles.data ?? []).map((p) => p.user_id as string)
  const { data: emails } = await supabase.rpc('superadmin_user_emails', { target_user_ids: ids })
  const emailOf = new Map(((emails ?? []) as { user_id: string; email: string | null }[]).map((e) => [e.user_id, e.email]))
  const orgName = new Map((orgs.data ?? []).map((o) => [o.id as string, o.name as string]))
  const admins = new Set(
    (privates.data ?? []).filter((p) => p.is_superadmin === true).map((p) => p.user_id as string),
  )
  const selfId = userId

  const people: Person[] = (profiles.data ?? [])
    .filter((p) => p.user_id !== selfId && !admins.has(p.user_id as string))
    .map((p) => ({
      id: p.user_id as string,
      name: (p.display_name as string) || 'Unnamed member',
      email: emailOf.get(p.user_id as string) ?? null,
      orgs: [
        ...new Set(
          (members.data ?? [])
            .filter((m) => m.user_id === p.user_id && (m.status ?? 'active') === 'active')
            .map((m) => orgName.get(m.org_id as string))
            .filter((n): n is string => !!n),
        ),
      ].sort(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

  return (
    <div className="max-w-3xl">
      <PageHeader back={{ href: '/console', label: 'Owner Console' }} title="View as" className="mb-1" />
      <p className="mb-4 text-sm text-gray-600">
        Opens a person&rsquo;s whole account for 30 minutes, built by the same screens they use. It is read-only: the
        database refuses every change and forms cannot be sent, and a banner on every screen says whose screen it is.
      </p>

      {!realViewConfigured() && (
        <p className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800" data-testid="real-view-unconfigured">
          Not configured on this server: the SUPABASE_JWT_SECRET setting is missing, so no view can start.
        </p>
      )}
      {ended !== undefined && !open && (
        <p className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700" data-testid="real-view-ended">
          {ended ? `Your view of ${ended.slice(0, 100)} ended.` : 'Your view ended.'}
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

      <PersonList people={people} disabled={!!open || !realViewConfigured()} />
    </div>
  )
}
