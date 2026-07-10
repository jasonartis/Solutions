import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getModule } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { helpRegistry } from '@/lib/help-registry'

// Platform Help index (docs/03 walkthrough decision): every enabled module
// with guides, filtered to the caller's level — module staff see staff
// guides listed; members see member guides only.
export default async function HelpIndexPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const supabase = await createClient()
  const { data: org } = await supabase.from('orgs').select('id, name, slug').eq('slug', orgSlug).single()
  if (!org) notFound()

  const { data: enabled } = await supabase
    .from('org_modules')
    .select('module_key')
    .eq('org_id', org.id)
    .eq('enabled', true)

  const sections: { moduleKey: string; moduleName: string; guides: { role: string; title: string }[] }[] = []
  for (const { module_key: moduleKey } of enabled ?? []) {
    const help = helpRegistry[moduleKey]
    const manifest = getModule(moduleKey)
    if (!help || !manifest) continue
    const { data: isStaff } = await supabase.rpc('module_can_manage', {
      check_org_id: org.id,
      check_module_key: moduleKey,
    })
    const guides = help.guides.filter((g) => isStaff || !g.staff)
    if (guides.length === 0) continue
    sections.push({
      moduleKey,
      moduleName: manifest.name,
      guides: guides.map((g) => ({ role: g.role, title: g.title })),
    })
  }

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-2 text-2xl font-semibold">Help & walkthroughs</h1>
      <p className="mb-8 max-w-2xl text-sm text-gray-500">
        Step-by-step guides for everything you can do here, written for your role. Follow them
        top to bottom to learn a module — or to test it and tell us where a step doesn&apos;t match.
      </p>

      {sections.length === 0 && <p className="text-gray-500">No guides for your modules yet.</p>}

      <div className="space-y-6">
        {sections.map((sec) => (
          <section key={sec.moduleKey} className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-lg font-medium">{sec.moduleName}</h2>
            <ul className="space-y-1 text-sm">
              {sec.guides.map((g) => (
                <li key={g.role}>
                  <Link
                    href={`/o/${orgSlug}/help/${sec.moduleKey}/${g.role}`}
                    className="text-blue-600 hover:underline"
                  >
                    {g.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
