import Link from 'next/link'
import type { User } from '@supabase/supabase-js'

// The top bar of every signed-in page. Shared by the (app) layout and by
// public pages that a signed-in person also reaches (e.g. /privacy from the
// footer) — with `user` null it shows a "Sign in" link instead.
export function AppHeader({
  user,
  displayName,
  isSuperadmin,
}: {
  user: User | null
  displayName?: string | null
  isSuperadmin?: boolean
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-gray-200 bg-white px-4 py-3 sm:px-6">
      <div className="flex items-center gap-4 sm:gap-6">
        <Link href={user ? '/dashboard' : '/login'} className="font-semibold">
          Solutions Platform
        </Link>
        {isSuperadmin && (
          <Link href="/console" className="text-sm text-blue-600 hover:underline">
            Owner Console
          </Link>
        )}
      </div>
      <div className="flex items-center gap-4 text-sm text-gray-600">
        {user ? (
          <>
            <Link href="/account" className="max-w-[40vw] truncate hover:underline sm:max-w-none">
              {displayName || user.email}
            </Link>
            <form action="/auth/signout" method="post">
              <button type="submit" className="text-gray-500 hover:text-gray-800 hover:underline">
                Sign out
              </button>
            </form>
          </>
        ) : (
          <Link href="/login" className="text-blue-600 hover:underline">
            Sign in
          </Link>
        )}
      </div>
    </header>
  )
}
