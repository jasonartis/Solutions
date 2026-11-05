import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import { SiteFooter } from '@/components/site-footer'
import { AppHeader } from '@/components/app-header'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const profile = await getProfile()

  // Unread replies to the person's own feedback (docs/27): no email, so this
  // badge is the notification. Own tickets only — RLS would also hand the
  // superadmin everyone's.
  const { data: myTickets } = await supabase
    .from('feedback_tickets')
    .select('last_staff_message_at, user_read_at')
    .eq('created_by', user.id)
    .not('last_staff_message_at', 'is', null)
  const feedbackUnread = (myTickets ?? []).filter(
    (t) => t.user_read_at === null || t.last_staff_message_at! > t.user_read_at,
  ).length

  return (
    <div className="min-h-screen bg-gray-50">
      <AppHeader
        user={user}
        displayName={profile?.display_name}
        isSuperadmin={profile?.is_superadmin}
        feedbackUnread={feedbackUnread}
      />
      <main className="mx-auto max-w-5xl p-4 sm:p-6">{children}</main>
      <SiteFooter />
    </div>
  )
}
