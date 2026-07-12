import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireOrgModule } from '@/lib/module-gate'
import { createMaterial, deleteMaterial, publishMaterial, unpublishMaterial } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'
const dangerCls = 'px-1 py-1.5 text-xs text-red-600 hover:underline'

// Professor console: course materials (reusable content) + per-class publish
// windows. A material is created once per course, then published into one or
// more classes with an optional visible_from/visible_until window.
export default async function MaterialsPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'classroom')

  const { data: courses } = await supabase.from('cls_courses').select('id, name').eq('org_id', org.id)
  if (!courses || courses.length === 0) notFound()

  const [{ data: classes }, { data: materials }, { data: publications }] = await Promise.all([
    supabase.from('cls_classes').select('id, course_id, name').eq('org_id', org.id),
    supabase
      .from('cls_materials')
      .select('id, course_id, kind, title, url, storage_path')
      .eq('org_id', org.id)
      .order('sort'),
    supabase
      .from('cls_publications')
      .select('id, class_id, material_id, visible_from, visible_until'),
  ])

  const toLocalInput = (iso: string | null) => (iso ? iso.slice(0, 16) : '')

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">Classroom — Materials</h1>
        <Link href={`/o/${orgSlug}/m/classroom/manage`} className="text-sm text-blue-600 hover:underline">
          ← Manage
        </Link>
      </div>

      <div className="space-y-8">
        {(courses ?? []).map((course) => {
          const courseClasses = (classes ?? []).filter((c) => c.course_id === course.id)
          const courseMaterials = (materials ?? []).filter((m) => m.course_id === course.id)
          return (
            <section key={course.id} className="rounded-lg border border-gray-200 bg-white p-5">
              <h2 className="mb-4 text-lg font-medium">{course.name}</h2>

              <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
                Add material
              </h3>
              <form
                action={createMaterial.bind(null, orgSlug, course.id)}
                className="mb-6 flex flex-wrap items-center gap-2"
              >
                <input name="title" required placeholder="Title" className={`${inputCls} min-w-48`} />
                <select name="kind" className={inputCls} defaultValue="document">
                  <option value="lecture">Lecture</option>
                  <option value="homework_spec">Homework spec</option>
                  <option value="video">Video</option>
                  <option value="document">Document</option>
                </select>
                <input name="url" placeholder="URL (optional)" className={`${inputCls} min-w-64`} />
                <input name="file" type="file" className="text-sm" />
                <button className={btnCls}>Add</button>
              </form>

              <div className="space-y-4">
                {courseMaterials.map((m) => {
                  const pubsByClass = new Map(
                    (publications ?? [])
                      .filter((p) => p.material_id === m.id)
                      .map((p) => [p.class_id, p]),
                  )
                  return (
                    <div key={m.id} className="rounded border border-gray-100 p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <div>
                          <span className="font-medium">{m.title}</span>{' '}
                          <span className="text-xs uppercase text-gray-400">{m.kind}</span>
                          {m.url && (
                            <a href={m.url} target="_blank" rel="noreferrer" className="ml-2 text-xs text-blue-600 hover:underline">
                              link
                            </a>
                          )}
                          {m.storage_path && <span className="ml-2 text-xs text-gray-400">file attached</span>}
                        </div>
                        <form action={deleteMaterial.bind(null, orgSlug, m.id, m.storage_path)}>
                          <button className={dangerCls}>Delete</button>
                        </form>
                      </div>

                      <div className="overflow-x-auto">
                      <table className="w-full min-w-[520px] text-sm">
                        <tbody>
                          {courseClasses.map((klass) => {
                            const pub = pubsByClass.get(klass.id)
                            return (
                              <tr key={klass.id} className="border-t border-gray-50">
                                <td className="py-1 pr-3 text-gray-600">{klass.name}</td>
                                <td className="py-1">
                                  <form
                                    action={publishMaterial.bind(null, orgSlug, m.id, klass.id)}
                                    className="flex flex-wrap items-center gap-2"
                                  >
                                    <label className="text-xs text-gray-400">
                                      From{' '}
                                      <input
                                        type="datetime-local"
                                        name="visibleFrom"
                                        defaultValue={toLocalInput(pub?.visible_from ?? null)}
                                        className={inputCls}
                                      />
                                    </label>
                                    <label className="text-xs text-gray-400">
                                      Until{' '}
                                      <input
                                        type="datetime-local"
                                        name="visibleUntil"
                                        defaultValue={toLocalInput(pub?.visible_until ?? null)}
                                        className={inputCls}
                                      />
                                    </label>
                                    <button className={btnCls}>{pub ? 'Update' : 'Publish'}</button>
                                  </form>
                                </td>
                                <td className="py-1 pl-3">
                                  {pub && (
                                    <form action={unpublishMaterial.bind(null, orgSlug, pub.id)}>
                                      <button className={dangerCls}>Unpublish</button>
                                    </form>
                                  )}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                      </div>
                    </div>
                  )
                })}
                {courseMaterials.length === 0 && (
                  <p className="text-sm text-gray-400">No materials yet.</p>
                )}
              </div>
            </section>
          )
        })}
      </div>
      <p className="mt-4 text-xs text-gray-400">
        Times shown in your browser's local time zone; leave From/Until blank for always-visible.
      </p>
    </div>
  )
}
