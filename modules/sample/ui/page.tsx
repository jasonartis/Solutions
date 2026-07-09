// TEMPLATE (module 0). The page lives INSIDE the module folder; apps/web
// mounts it with a one-line route wrapper. Conventions on display:
//   - requireOrgModule() gate (docs/03 #2) — org by slug → entitlement → 404
//   - role detection via the module's definer rpc, not client-side guessing
//   - role-adaptive rendering (staff form vs member view)
import { requireOrgModule } from '@/lib/module-gate'
import { addItem, createProject, toggleItem } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

export default async function SamplePage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'sample')

  const [{ data: canManage }, { data: projects }, { data: items }] = await Promise.all([
    supabase.rpc('smp_can_manage', { check_org_id: org.id }),
    supabase.from('smp_projects').select('id, name').eq('org_id', org.id).order('created_at'),
    supabase.from('smp_items').select('id, project_id, body, done').order('created_at'),
  ])

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-6 text-2xl font-semibold">Sample Module</h1>

      {canManage && (
        <form action={createProject.bind(null, orgSlug)} className="mb-6 flex items-center gap-2">
          <input name="name" required placeholder="New project name" className={`${inputCls} min-w-56`} />
          <button className={btnCls}>Create project</button>
        </form>
      )}

      <div className="space-y-6">
        {(projects ?? []).map((p) => (
          <section key={p.id} className="rounded-lg border border-gray-200 bg-white p-5">
            <h2 className="mb-3 text-lg font-medium">{p.name}</h2>
            <ul className="mb-4 space-y-1 text-sm">
              {(items ?? [])
                .filter((i) => i.project_id === p.id)
                .map((i) => (
                  <li key={i.id} className="flex items-center justify-between">
                    <span className={i.done ? 'text-gray-400 line-through' : ''}>{i.body}</span>
                    <form action={toggleItem.bind(null, orgSlug, i.id, !i.done)}>
                      <button className="text-xs text-blue-600 hover:underline">
                        {i.done ? 'Reopen' : 'Done'}
                      </button>
                    </form>
                  </li>
                ))}
            </ul>
            <form action={addItem.bind(null, orgSlug, p.id)} className="flex items-center gap-2">
              <input name="body" required placeholder="Add an item…" className={`${inputCls} flex-1`} />
              <button className={btnCls}>Add</button>
            </form>
          </section>
        ))}
        {(projects ?? []).length === 0 && (
          <p className="text-gray-500">No projects yet{canManage ? ' — create one above.' : '.'}</p>
        )}
      </div>
    </div>
  )
}
