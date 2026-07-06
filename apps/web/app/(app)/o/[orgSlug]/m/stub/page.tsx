import { notFound } from 'next/navigation'
import { stubModule } from '@platform/core'
import { createClient } from '@/lib/supabase/server'

// The stub module: proves the whole entitlement chain end-to-end.
// A real module follows exactly this gate pattern (docs/03).
export default async function StubModulePage(props: {
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await props.params
  const supabase = await createClient()

  // RLS returns the org only if the caller is a member (or superadmin).
  const { data: org } = await supabase
    .from('orgs')
    .select('id, name')
    .eq('slug', orgSlug)
    .single()
  if (!org) notFound()

  const { data: entitlement } = await supabase
    .from('org_modules')
    .select('enabled')
    .eq('org_id', org.id)
    .eq('module_key', stubModule.key)
    .single()
  if (!entitlement?.enabled) notFound()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data: roles } = await supabase
    .from('module_roles')
    .select('role')
    .eq('org_id', org.id)
    .eq('module_key', stubModule.key)
    .eq('user_id', user!.id)

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-4 text-2xl font-semibold">{stubModule.name}</h1>
      <div className="rounded-lg border border-gray-200 bg-white p-5 text-sm leading-6 text-gray-700">
        <p>{stubModule.description}</p>
        <p className="mt-3">
          If you can read this, the full chain works: authentication → org membership (RLS) →
          module entitlement → module page.
        </p>
        <p className="mt-3 text-gray-500">
          Your roles in this module:{' '}
          {roles && roles.length > 0 ? roles.map((r) => r.role).join(', ') : 'none assigned'}
        </p>
      </div>
    </div>
  )
}
