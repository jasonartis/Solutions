import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import DisplayNameForm from './display-name-form'

export default async function AccountPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const profile = await getProfile()

  return (
    <div className="max-w-lg">
      <h1 className="mb-1 text-2xl font-semibold">Your account</h1>
      <p className="mb-6 text-sm text-gray-500">
        Your display name is how other members of your organizations see you.
      </p>

      <DisplayNameForm initial={profile?.display_name ?? ''} />

      <div className="rounded border border-gray-200 bg-white p-4">
        <h2 className="mb-1 text-sm font-medium">Email address</h2>
        {/* Read from the SESSION, never from the database (docs/22 §3 R2): the
            address is already in the token, and after the email slice
            `auth.users` holds the only copy that exists. */}
        <p className="text-sm text-gray-600">{user?.email}</p>
        <p className="mt-2 text-xs text-gray-400">
          Other members of your organizations can see your display name. They cannot see your email address.
        </p>
      </div>
    </div>
  )
}
