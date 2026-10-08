import Link from 'next/link'
import { requireOrgModule } from '@/lib/module-gate'
import {
  acceptConversationInvite,
  createConversation,
  declineAndBlockConversationInvite,
  declineConversationInvite,
  unblockConversation,
} from './actions'

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

  // Pending invitations (20261007030000): the caller's own pending seats in
  // this org, read through a definer because the conversation itself is
  // invisible until they accept. Title + who invited them — nothing else.
  const { data: invites } = await supabase.rpc('vm_my_pending_invites', { check_org_id: org.id })
  const pending = (invites ?? []) as {
    conversation_id: string
    title: string
    invited_by_name: string | null
    invited_at: string
  }[]

  // Conversations the caller blocked (20261008010000): their own self-blocked
  // seats, through a definer for the same reason as invitations — a banned
  // seat cannot read its conversation, so the title needs one.
  const { data: blocks } = await supabase.rpc('vm_my_blocked_conversations', { check_org_id: org.id })
  const blocked = (blocks ?? []) as { conversation_id: string; title: string; blocked_at: string }[]

  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <h1 className="mb-6 text-2xl font-semibold">Visual Messaging</h1>

      {pending.length > 0 && (
        <section className="mb-8 rounded-lg border border-blue-200 bg-blue-50 p-5">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-blue-700">Invitations</h2>
          <ul className="space-y-2">
            {pending.map((i) => (
              <li
                key={i.conversation_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-blue-100 bg-white px-4 py-3"
              >
                <span className="text-sm">
                  <span className="font-medium">{i.title}</span>
                  <span className="text-gray-500">
                    {' '}
                    — invited by {i.invited_by_name ?? 'a member'} · {fmt.format(new Date(i.invited_at))}
                  </span>
                </span>
                <span className="flex gap-2">
                  <form action={acceptConversationInvite.bind(null, orgSlug, i.conversation_id)}>
                    <button className={btnCls}>Accept</button>
                  </form>
                  <form action={declineConversationInvite.bind(null, orgSlug, i.conversation_id)}>
                    <button className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50">Decline</button>
                  </form>
                  <form action={declineAndBlockConversationInvite.bind(null, orgSlug, i.conversation_id)}>
                    <button className="rounded border border-red-200 px-3 py-1 text-sm text-red-700 hover:bg-red-50">
                      Decline and block
                    </button>
                  </form>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500">
            You won&apos;t see a conversation&apos;s pictures or replies until you accept. Decline and block stops
            that conversation from inviting you again.
          </p>
        </section>
      )}

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

      {blocked.length > 0 && (
        <section className="mt-10 rounded-lg border border-gray-200 bg-white p-5">
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">Blocked conversations</h2>
          <ul className="space-y-2">
            {blocked.map((b) => (
              <li
                key={b.conversation_id}
                className="flex flex-wrap items-center justify-between gap-2 rounded border border-gray-100 px-4 py-3"
              >
                {/* No date shown: blocked_at is the seat's updated_at, which a
                    silently-reverted update by someone else still bumps. */}
                <span className="text-sm font-medium">{b.title}</span>
                <form action={unblockConversation.bind(null, orgSlug, b.conversation_id)}>
                  <button className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50">Unblock</button>
                </form>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-gray-500">
            Unblocking doesn&apos;t put you back in. It only lets that conversation invite you again.
          </p>
        </section>
      )}
    </div>
  )
}
