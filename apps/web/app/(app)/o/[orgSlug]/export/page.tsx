import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getModule } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { exportRegistry } from '@/lib/export-registry'
import { readExportSettings } from '@/lib/export-settings'
import { saveExportControls } from './actions'

const btnCls = 'rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700'

// Generic data-export page (docs/03 primitive): per enabled module with a
// manifest — the caller's hats (?hat_<module>= picks one; a higher role may
// deliberately choose a lower hat), checkbox data sets, and — for module
// staff — the export CONTROLS that disable hats/sets for the levels below.
// Staff are never blocked by their own switches; /api/export re-checks all
// of this server-side.
export default async function ExportPage(props: {
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const { orgSlug } = await props.params
  const searchParams = await props.searchParams
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data: org } = await supabase.from('orgs').select('id, name, slug').eq('slug', orgSlug).single()
  if (!org || !user) notFound()

  const { data: enabled } = await supabase
    .from('org_modules')
    .select('module_key')
    .eq('org_id', org.id)
    .eq('enabled', true)

  const sections: {
    moduleKey: string
    moduleName: string
    isStaff: boolean
    hats: { key: string; label: string }[]
    chosenHat: string | null
    sets: { key: string; label: string; description?: string }[]
    allHats: { key: string; label: string; allowed: boolean }[]
    allSets: { key: string; label: string; allowed: boolean }[]
    fullyDisabled: boolean
  }[] = []

  for (const { module_key: moduleKey } of enabled ?? []) {
    const def = exportRegistry[moduleKey]
    const manifest = getModule(moduleKey)
    if (!def || !manifest) continue

    const ctx = { orgId: org.id, userId: user.id }
    const [myHats, settings, { data: isStaff }] = await Promise.all([
      def.myHats(supabase, ctx),
      readExportSettings(supabase, org.id, moduleKey),
      supabase.rpc('module_can_manage', { check_org_id: org.id, check_module_key: moduleKey }),
    ])
    if (myHats.length === 0) continue

    // Staff bypass their own switches; everyone else gets the filtered view.
    const usableHats = isStaff ? myHats : myHats.filter((h) => !settings.disabledHats.includes(h))
    const usableSetKeys = (key: string) => isStaff || !settings.disabledSets.includes(key)

    const requested = searchParams[`hat_${moduleKey}`]
    const chosenHat = requested && usableHats.includes(requested) ? requested : (usableHats[0] ?? null)

    sections.push({
      moduleKey,
      moduleName: manifest.name,
      isStaff: Boolean(isStaff),
      hats: def.hats.filter((h) => usableHats.includes(h.key)).map((h) => ({ key: h.key, label: h.label })),
      chosenHat,
      sets: chosenHat
        ? def.dataSets
            .filter((s) => s.hats.includes(chosenHat) && usableSetKeys(s.key))
            .map((s) => ({ key: s.key, label: s.label, description: s.description }))
        : [],
      allHats: def.hats.map((h) => ({
        key: h.key,
        label: h.label,
        allowed: !settings.disabledHats.includes(h.key),
      })),
      allSets: def.dataSets.map((s) => ({
        key: s.key,
        label: s.label,
        allowed: !settings.disabledSets.includes(s.key),
      })),
      fullyDisabled: usableHats.length === 0,
    })
  }

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-2 text-2xl font-semibold">Export your data</h1>
      <p className="mb-8 max-w-2xl text-sm text-gray-500">
        An export contains exactly what you can already see in the app, as CSV (for
        spreadsheets) and JSON (for machines) in one zip. If you hold a higher role you may
        deliberately export with a lower hat.
      </p>

      {sections.length === 0 && (
        <p className="text-gray-500">No exportable modules for your account in this organization.</p>
      )}

      <div className="space-y-8">
        {sections.map((sec) => (
          <section key={sec.moduleKey} className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-lg font-medium">{sec.moduleName}</h2>

            {sec.fullyDisabled ? (
              <p className="text-sm text-gray-500">
                Exporting has been turned off for your role by this module&apos;s staff.
              </p>
            ) : (
              <>
                {sec.hats.length > 1 && (
                  <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-gray-500">Export as:</span>
                    {sec.hats.map((h) => (
                      <Link
                        key={h.key}
                        href={`?hat_${sec.moduleKey}=${h.key}`}
                        className={
                          h.key === sec.chosenHat
                            ? 'rounded bg-blue-600 px-2 py-1 text-white'
                            : 'rounded border border-gray-200 px-2 py-1 text-blue-600 hover:bg-blue-50'
                        }
                      >
                        {h.label}
                      </Link>
                    ))}
                  </div>
                )}

                <form method="post" action="/api/export" className="space-y-2">
                  <input type="hidden" name="orgSlug" value={org.slug} />
                  <input type="hidden" name="moduleKey" value={sec.moduleKey} />
                  <input type="hidden" name="hat" value={sec.chosenHat ?? ''} />
                  {sec.sets.map((s) => (
                    <label key={s.key} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="sets" value={s.key} defaultChecked />
                      <span>{s.label}</span>
                      {s.description && <span className="text-xs text-gray-400">{s.description}</span>}
                    </label>
                  ))}
                  {sec.sets.length === 0 ? (
                    <p className="text-sm text-gray-400">No data sets available for this hat.</p>
                  ) : (
                    <button className={btnCls}>Download zip</button>
                  )}
                </form>
              </>
            )}

            {sec.isStaff && (
              <details className="mt-5 border-t border-gray-100 pt-4">
                <summary className="cursor-pointer text-sm font-medium text-gray-600">
                  Export controls (staff) — what the levels below may export
                </summary>
                <form
                  action={saveExportControls.bind(null, orgSlug, sec.moduleKey)}
                  className="mt-3 space-y-3 text-sm"
                >
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide text-gray-400">Allowed hats</p>
                    {sec.allHats.map((h) => (
                      <label key={h.key} className="mr-4 inline-flex items-center gap-1">
                        <input type="checkbox" name="allowedHats" value={h.key} defaultChecked={h.allowed} />
                        {h.label}
                      </label>
                    ))}
                  </div>
                  <div>
                    <p className="mb-1 text-xs uppercase tracking-wide text-gray-400">Allowed data sets</p>
                    {sec.allSets.map((s) => (
                      <label key={s.key} className="mr-4 inline-flex items-center gap-1">
                        <input type="checkbox" name="allowedSets" value={s.key} defaultChecked={s.allowed} />
                        {s.label}
                      </label>
                    ))}
                  </div>
                  <p className="text-xs text-gray-400">
                    Unchecked = off for everyone below module staff. Staff exports are unaffected.
                  </p>
                  <button className="rounded bg-gray-700 px-3 py-1 text-xs font-medium text-white hover:bg-gray-800">
                    Save controls
                  </button>
                </form>
              </details>
            )}
          </section>
        ))}
      </div>
    </div>
  )
}
