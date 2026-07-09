import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'
import { exportRegistry } from '@/lib/export-registry'
import { getModule } from '@platform/core'

const btnCls = 'rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700'

// Generic data-export page (docs/03 primitive): for each enabled module with
// a manifest, show the caller's hats (?hat_<module>=... picks one — an admin
// may deliberately choose a lower hat) and checkbox data sets for that hat.
// Selection posts to /api/export, which re-checks everything server-side.
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
  const enabledKeys = (enabled ?? []).map((m) => m.module_key)

  const sections: {
    moduleKey: string
    moduleName: string
    hats: { key: string; label: string }[]
    chosenHat: string
    sets: { key: string; label: string; description?: string }[]
  }[] = []

  for (const moduleKey of enabledKeys) {
    const def = exportRegistry[moduleKey]
    const manifest = getModule(moduleKey)
    if (!def || !manifest) continue
    const myHats = await def.myHats(supabase, { orgId: org.id, userId: user.id })
    if (myHats.length === 0) continue
    const chosenHat = searchParams[`hat_${moduleKey}`] && myHats.includes(searchParams[`hat_${moduleKey}`]!)
      ? searchParams[`hat_${moduleKey}`]!
      : myHats[0]!
    sections.push({
      moduleKey,
      moduleName: manifest.name,
      hats: def.hats.filter((h) => myHats.includes(h.key)).map((h) => ({ key: h.key, label: h.label })),
      chosenHat,
      sets: def.dataSets
        .filter((s) => s.hats.includes(chosenHat))
        .map((s) => ({ key: s.key, label: s.label, description: s.description })),
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
              <input type="hidden" name="hat" value={sec.chosenHat} />
              {sec.sets.map((s) => (
                <label key={s.key} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="sets" value={s.key} defaultChecked />
                  <span>{s.label}</span>
                  {s.description && <span className="text-xs text-gray-400">{s.description}</span>}
                </label>
              ))}
              {sec.sets.length === 0 ? (
                <p className="text-sm text-gray-400">No data sets for this hat.</p>
              ) : (
                <button className={btnCls}>Download zip</button>
              )}
            </form>
          </section>
        ))}
      </div>
    </div>
  )
}
