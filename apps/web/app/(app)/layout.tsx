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

  return (
    <div className="min-h-screen bg-gray-50">
      <AppHeader user={user} displayName={profile?.display_name} isSuperadmin={profile?.is_superadmin} />
      <main className="mx-auto max-w-5xl p-4 sm:p-6">{children}</main>
      <SiteFooter />
    </div>
  )
}
