import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const profile = await getProfile()

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
        <div className="flex items-center gap-4 sm:gap-6">
          <Link href="/dashboard" className="font-semibold">
            Solutions Platform
          </Link>
          {profile?.is_superadmin && (
            <Link href="/console" className="text-sm text-blue-600 hover:underline">
              Owner Console
            </Link>
          )}
        </div>
        <div className="flex items-center gap-4 text-sm text-gray-600">
          <span className="max-w-[40vw] truncate sm:max-w-none">
            {profile?.display_name || profile?.email || user.email}
          </span>
          <form action="/auth/signout" method="post">
            <button type="submit" className="text-gray-500 hover:text-gray-800 hover:underline">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <main className="mx-auto max-w-5xl p-4 sm:p-6">{children}</main>
    </div>
  )
}
