import { PageHeader } from '@/components/page-header'
import { createClient } from '@/lib/supabase/server'
import { parseFromPath } from '@/lib/feedback'
import { headingForPath, safeFromPath } from '@/lib/back-link'
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

  // Back goes to the page the feedback is about when its heading is known exactly; else My feedback.
  const aboutPath = safeFromPath(from)
  const aboutLabel = headingForPath(aboutPath)

  return (
    <div className="max-w-2xl">
      <PageHeader back={{ href: '/feedback', label: 'My feedback', from: aboutPath, fromLabel: aboutLabel }} title="Send feedback" className="mb-4" />
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
