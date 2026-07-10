import Link from 'next/link'
import { requireOrgModule } from '@/lib/module-gate'
import { createConversation } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Module 4 (Visual Messaging) landing: the caller's conversations (RLS shows
// member/creator/staff conversations) + start a new one from a picture.
export default async function VisualMessagingPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { supabase, org } = await requireOrgModule(orgSlug, 'visual-messaging')

  const { data: conversations } = await supabase
    .from('vm_conversations')
    .select('id, title, frozen, created_at')
    .eq('org_id', org.id)
    .order('created_at', { ascending: false })

  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-6 text-2xl font-semibold">Visual Messaging</h1>

      <section className="mb-8 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
          Start a conversation
        </h2>
        <form action={createConversation.bind(null, orgSlug)} className="flex flex-wrap items-center gap-2">
          <input name="title" required placeholder="Title" className={`${inputCls} min-w-56`} />
          <input name="image" type="file" accept="image/*" required className="text-sm" />
          <button className={btnCls}>Create</button>
        </form>
        <p className="mt-2 text-xs text-gray-400">
          A conversation starts with a picture; every reply is a drawing on top of the layer it
          answers.
        </p>
      </section>

      <ul className="space-y-2">
        {(conversations ?? []).map((c) => (
          <li key={c.id} className="flex items-center justify-between rounded border border-gray-200 bg-white px-4 py-3">
            <Link
              href={`/o/${orgSlug}/m/visual-messaging/conversations/${c.id}`}
              className="text-blue-600 hover:underline"
            >
              {c.title}
            </Link>
            <span className="text-xs text-gray-400">
              {c.frozen && <span className="mr-2 uppercase text-amber-600">frozen</span>}
              {fmt.format(new Date(c.created_at))}
            </span>
          </li>
        ))}
        {(conversations ?? []).length === 0 && (
          <li className="text-sm text-gray-500">No conversations yet — start one above.</li>
        )}
      </ul>
    </div>
  )
}
