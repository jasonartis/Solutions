import Link from 'next/link'
import { notFound } from 'next/navigation'
import { marked } from 'marked'
import { getModule } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { helpRegistry } from '@/lib/help-registry'

// One walkthrough (docs/03): numbered click-by-click steps for a role.
// Staff guides 404 for non-staff — visibility is enforced here, not just
// hidden on the index.
export default async function GuidePage(props: {
  params: Promise<{ orgSlug: string; moduleKey: string; role: string }>
}) {
  const { orgSlug, moduleKey, role } = await props.params
  const help = helpRegistry[moduleKey]
  const manifest = getModule(moduleKey)
  const guide = help?.guides.find((g) => g.role === role)
  if (!help || !manifest || !guide) notFound()

  const supabase = await createClient()
  const { data: org } = await supabase.from('orgs').select('id, name, slug').eq('slug', orgSlug).single()
  if (!org) notFound()

  // Entitlement + level gate: the module must be enabled here, and staff
  // guides are staff-only ("each level sees their level and below").
  const { data: entitlement } = await supabase
    .from('org_modules')
    .select('enabled')
    .eq('org_id', org.id)
    .eq('module_key', moduleKey)
    .single()
  if (!entitlement?.enabled) notFound()
  if (guide.staff) {
    const { data: isStaff } = await supabase.rpc('module_can_manage', {
      check_org_id: org.id,
      check_module_key: moduleKey,
    })
    if (!isStaff) notFound()
  }

  const html = await marked.parse(guide.body)

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">
        {org.name} · {manifest.name}
      </p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">{guide.title}</h1>
        <Link href={`/o/${orgSlug}/help`} className="text-sm text-blue-600 hover:underline">
          ← All guides
        </Link>
      </div>
      <article
        className="prose-sm max-w-2xl rounded-lg border border-gray-200 bg-white p-6 [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_li]:mb-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:mb-3 [&_ul]:list-disc [&_ul]:pl-5"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
