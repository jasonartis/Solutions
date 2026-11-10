// PUBLIC: the Report content page (module-9 spec §B1/§H(c)), linked from every
// page's footer. Anyone can use it, signed in or not. Wording approved by the
// founder 2026-11-10 (after an adversarial review of the copy).
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import { AppHeader } from '@/components/app-header'
import { PLATFORM_CONTACT_EMAIL } from '@/lib/platform-identity'
import { ReportForm } from './report-form'

export const metadata = { title: 'Report content' }

export default async function ReportPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const profile = user ? await getProfile() : null
  // The fallback route when a report cannot be sent. Unset, the failure message
  // simply leaves it out (never a placeholder); the console dashboard flags it.
  const contactEmail = PLATFORM_CONTACT_EMAIL

  return (
    <>
      <AppHeader user={user} displayName={profile?.display_name} isSuperadmin={profile?.is_superadmin} />
      <main className="mx-auto max-w-xl px-4 py-12 text-gray-800">
        <h1 className="mb-2 text-2xl font-semibold">Report content</h1>
        <p className="mb-1 text-sm text-gray-700">
          Tell us about something on this platform that shouldn&apos;t be here. You don&apos;t need an account.
        </p>
        <p className="mb-8 text-sm text-gray-700">If someone is in immediate danger, contact the police.</p>
        <ReportForm contactEmail={contactEmail} />
      </main>
    </>
  )
}
