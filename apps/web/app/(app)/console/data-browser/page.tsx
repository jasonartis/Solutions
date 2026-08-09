import Link from 'next/link'
import { requireSuperadmin } from '@/lib/platform'
import { browsePerson, browsableModuleKeys, subjectsIn } from '@/lib/data-browser'
import DataBrowserResults from '@/components/data-browser/results'
import { logSuperadminLookup } from '@/lib/superadmin-log'

// The per-person data browser (docs/13, founder decision 2026-08-02).
//
// "WHAT DO I HOLD ABOUT THIS PERSON?" — every row the VIEWER may read that
// names the subject, bounded by RLS and nothing else.
//
// THE LABELLING IS A REQUIREMENT, NOT COPY (founder, 2026-08-02): this must
// never be presented as "what they see". That is view-as, which is curated by a
// surface declaration and deliberately narrower than the viewer's own reach.
// Presenting one as the other is the single way this pair of tools becomes
// misleading, so the contrast is stated on the page itself rather than assumed.
//
// Superadmin-only for now, but nothing below is superadmin-shaped: the query
// runs on the caller's own client, so the same component works unchanged for a
// professor the day the founder decides to expand it (docs/13 answer 1, which
// says it would then follow view-as access).
//
// LOGGED SINCE 2026-08-07 (docs/15 2026-08-06/07 decision 5; the DB half is
// migration 20260807010000, the app half lib/superadmin-log.ts).
//
// This comment used to read "UNLOGGED, like the rest of the Owner Console — and
// here that is simply what happens, not something suppressed: reading is the
// unstamped side of the platform everywhere, and this page writes nothing at
// all." Both of its factual claims are now false, and it is corrected in place
// rather than deleted because the REASONING it recorded is what got overturned:
// "reads are the unstamped side" is true of the platform generally and was
// exactly the wrong inference HERE, because this tool is `select *` over every
// row that names a person — the most revealing read on the platform, and the
// one whose absence from any log made logging only its narrower sibling
// incoherent (docs/15 decision 5's own words).

type Props = {
  searchParams: Promise<{ org?: string; subject?: string }>
}

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

export default async function DataBrowserPage({ searchParams }: Props) {
  const { supabase } = await requireSuperadmin()
  const { org: orgId, subject: subjectId } = await searchParams

  // Every org: a superadmin picks any of them (docs/13 answer 4). RLS permits
  // it via is_superadmin(), so this is an ordinary read.
  const { data: orgs } = await supabase.from('orgs').select('id, name, slug').order('name')
  const orgList = orgs ?? []
  const org = orgList.find((o) => o.id === orgId) ?? null

  const subjects = org ? await subjectsIn(supabase, org.id) : []
  const subject = subjects.find((s) => s.userId === subjectId) ?? null

  const moduleKeys = org ? await browsableModuleKeys(supabase, org.id) : []
  const result = org && subject ? await browsePerson(supabase, org.id, subject.userId, moduleKeys) : null

  // THE LOOKUP LOG. Gated on the same `org && subject` condition as the lookup
  // itself, so populating the org/person pickers records nothing — a row here
  // means a real person was actually browsed.
  //
  // `module_key`, `position` and `scope_ref` are all null and that is not a gap:
  // this tool spans every module the org has ever had in ONE lookup, so it has
  // no single module key, and it has no notion of a position or a scope at all.
  // The table's shape CHECK requires exactly this for `tool='data-browser'`, so
  // the asymmetry with view-as is enforced rather than merely intended.
  const logged =
    org && subject
      ? await logSuperadminLookup(supabase, {
          tool: 'data-browser',
          orgId: org.id,
          subjectUserId: subject.userId,
        })
      : null

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-1 flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">Data browser</h1>
        <Link href="/console" className="text-sm text-blue-600 hover:underline">
          ← Owner Console
        </Link>
      </div>
      <p className="mb-4 max-w-3xl text-sm text-gray-600">
        <strong>What I can see about this person</strong> — every row you are allowed to read that
        names them. This is <em>not</em> what they see: that is{' '}
        <span className="whitespace-nowrap">view-as</span>, which shows a curated surface and is
        deliberately narrower. This one is bounded by your own read permissions and nothing else.
      </p>

      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
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
        {org && (
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Person
            <select name="subject" defaultValue={subject?.userId ?? ''} className={inputCls}>
              <option value="">— pick a person —</option>
              {subjects.map((s) => (
                <option key={s.userId} value={s.userId}>
                  {s.displayName}
                  {s.email && s.email !== s.displayName ? ` (${s.email})` : ''}
                  {s.status !== 'active' ? ` — ${s.status}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="submit"
          className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
        >
          {org && subject ? 'Refresh' : 'Show'}
        </button>
      </form>

      {/* Same honesty rule as the console view-as: a lookup that could not be
          logged says so rather than passing itself off as recorded. */}
      {logged && !logged.logged && (
        <p className="mb-4 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800">
          <strong>This lookup was NOT recorded in the superadmin lookup log</strong> ({logged.error}).
          The results below still rendered, and everything shown is something you could already read —
          but the audit trail has a hole where this lookup should be. Treat it as a bug, not a result.
        </p>
      )}

      {org && subjects.length === 0 && (
        <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
          This org has no members you can read.
        </p>
      )}

      {result && subject && (
        <>
          <div className="mb-3 text-sm text-gray-600">
            <span className="font-medium text-gray-800">{subject.displayName}</span> in{' '}
            <span className="font-medium text-gray-800">{org!.name}</span> · org role{' '}
            <span className="font-mono text-xs">{subject.orgRole}</span> · searching{' '}
            {moduleKeys.length} module{moduleKeys.length === 1 ? '' : 's'} this org has ever had, plus platform
            tables
          </div>
          <DataBrowserResults result={result} subjectId={subject.userId} />
        </>
      )}
    </main>
  )
}
