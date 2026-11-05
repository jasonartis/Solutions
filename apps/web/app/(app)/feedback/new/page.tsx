import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { parseFromPath } from '@/lib/feedback'
import { NewFeedbackForm } from '../forms'

// "Send feedback" (docs/27). Reached from the link in the top bar, which passes
// the page the person was on as ?from=. The org name is looked up as the
// caller, so it only resolves for an org they can read.
export default async function NewFeedbackPage(props: { searchParams?: Promise<{ from?: string }> }) {
  const { from = '' } = (await props.searchParams) ?? {}
  const parsed = parseFromPath(from)

  let orgName: string | null = null
  if (parsed?.orgSlug) {
    const supabase = await createClient()
    const { data } = await supabase.from('orgs').select('name').eq('slug', parsed.orgSlug).maybeSingle()
    orgName = data?.name ?? null
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-4 flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Send feedback</h1>
        <Link href="/feedback" className="text-sm text-blue-600 hover:underline">
          My feedback
        </Link>
      </div>
      <p className="mb-4 text-sm text-gray-600">
        Report a problem, suggest something, or ask a question. You can follow the conversation under My feedback.
      </p>
      <NewFeedbackForm
        from={parsed ? from : ''}
        details={
          parsed
            ? {
                path: parsed.path,
                notice: parsed.notice,
                error: parsed.error,
                orgName,
                moduleKey: parsed.moduleKey,
                recordIds: parsed.recordIds,
              }
            : null
        }
      />
    </div>
  )
}
