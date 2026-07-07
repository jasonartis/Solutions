import { requireOrgModule } from '@/lib/module-gate'

// Module 2 (Classroom) landing: the caller's classes with announcements and
// open homework. First slice of the module UI — submissions/materials/grades
// pages follow.
export default async function ClassroomPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'classroom')

  // RLS scopes every query: members see their classes, staff see the org's.
  const [{ data: memberships }, { data: classes }] = await Promise.all([
    supabase.from('cls_class_members').select('class_id, role'),
    supabase.from('cls_classes').select('id, name, term').eq('org_id', org.id),
  ])
  const roleByClass = new Map((memberships ?? []).map((m) => [m.class_id, m.role]))
  const visibleClasses = (classes ?? []).filter(
    (c) => roleByClass.has(c.id) || (memberships ?? []).length === 0,
  )

  const classIds = visibleClasses.map((c) => c.id)
  const [{ data: announcements }, { data: homeworks }] = await Promise.all([
    classIds.length
      ? supabase
          .from('cls_announcements')
          .select('class_id, body, posted_at')
          .in('class_id', classIds)
          .order('posted_at', { ascending: false })
      : Promise.resolve({ data: [] as { class_id: string; body: string; posted_at: string }[] }),
    classIds.length
      ? supabase
          .from('cls_homeworks')
          .select('class_id, title, due_at')
          .in('class_id', classIds)
          .order('due_at')
      : Promise.resolve({ data: [] as { class_id: string; title: string; due_at: string | null }[] }),
  ])

  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-6 text-2xl font-semibold">Classes</h1>

      {visibleClasses.length === 0 && (
        <p className="text-gray-500">You are not enrolled in any class yet.</p>
      )}

      <div className="space-y-6">
        {visibleClasses.map((klass) => (
          <section key={klass.id} className="rounded-lg border border-gray-200 bg-white p-5">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-lg font-medium">{klass.name}</h2>
              <span className="text-xs uppercase tracking-wide text-gray-400">
                {roleByClass.get(klass.id) ?? 'staff'} · {klass.term}
              </span>
            </div>

            <h3 className="mb-1 text-sm font-medium uppercase tracking-wide text-gray-500">
              Announcements
            </h3>
            <ul className="mb-4 space-y-1 text-sm text-gray-700">
              {(announcements ?? [])
                .filter((a) => a.class_id === klass.id)
                .slice(0, 3)
                .map((a, i) => (
                  <li key={i}>
                    <span className="text-gray-400">{fmt.format(new Date(a.posted_at))} — </span>
                    {a.body}
                  </li>
                ))}
            </ul>

            <h3 className="mb-1 text-sm font-medium uppercase tracking-wide text-gray-500">
              Homework
            </h3>
            <ul className="space-y-1 text-sm text-gray-700">
              {(homeworks ?? [])
                .filter((h) => h.class_id === klass.id)
                .map((h, i) => (
                  <li key={i} className="flex justify-between">
                    <span>{h.title}</span>
                    <span className="text-gray-400">
                      {h.due_at ? `due ${fmt.format(new Date(h.due_at))}` : 'no deadline'}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
