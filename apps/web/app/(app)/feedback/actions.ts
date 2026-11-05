'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { parseFromPath } from '@/lib/feedback'

// Feedback actions (docs/27). Every one runs as the caller and goes through a
// feedback_* SECURITY DEFINER function; the functions decide who may do what.
// Refusals come back as {ok, reason}, never a throw (docs/03 #22: a thrown
// Server Action message is redacted in production).

type Result = { ok: true } | { ok: false; reason: string }

/** Send a new ticket. On success, goes to the ticket's page. */
export async function sendFeedback(formData: FormData): Promise<Result> {
  const kind = String(formData.get('kind') ?? '')
  const title = String(formData.get('title') ?? '').trim()
  const body = String(formData.get('body') ?? '').trim()
  const includeDetails = formData.get('includeDetails') === 'on'
  if (!title) return { ok: false, reason: 'Please give it a short title.' }
  if (title.length > 200) return { ok: false, reason: 'The title must be 200 characters or fewer.' }
  if (!body) return { ok: false, reason: 'Please describe what happened or what you would like.' }
  if (body.length > 5000) return { ok: false, reason: 'The message must be 5000 characters or fewer.' }

  const supabase = await createClient()
  const from = parseFromPath(String(formData.get('from') ?? ''))

  // The org on a ticket is only ever one the person belongs to; the database
  // re-checks (feedback_open raises 'Unknown organization'). A slug they cannot
  // read simply resolves to nothing, and the ticket is sent without an org.
  let orgId: string | null = null
  if (from?.orgSlug) {
    const { data } = await supabase.from('orgs').select('id').eq('slug', from.orgSlug).maybeSingle()
    orgId = data?.id ?? null
  }

  // Shown to the person before sending (the "what will be sent" panel), and
  // dropped entirely if they untick "include page and browser details".
  let context: Record<string, unknown> = {}
  if (includeDetails) {
    let browser: Record<string, unknown> = {}
    try {
      browser = JSON.parse(String(formData.get('browser') ?? '{}')) as Record<string, unknown>
    } catch {
      browser = {}
    }
    context = {
      page: from ? { path: from.path, notice: from.notice, error: from.error, recordIds: from.recordIds } : null,
      browser: {
        userAgent: String(browser.userAgent ?? '').slice(0, 300),
        viewport: String(browser.viewport ?? '').slice(0, 20),
        language: String(browser.language ?? '').slice(0, 20),
        timeZone: String(browser.timeZone ?? '').slice(0, 60),
      },
      appVersion: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? 'local',
    }
  }

  const { data: ticketId, error } = await supabase.rpc('feedback_open', {
    p_kind: kind,
    p_title: title,
    p_body: body,
    p_org_id: orgId,
    p_module_key: includeDetails ? (from?.moduleKey ?? null) : null,
    p_context: context,
  })
  if (error) return { ok: false, reason: error.message }

  revalidatePath('/feedback')
  redirect(`/feedback/${ticketId as string}?sent=1`)
}

/** The person (or staff) adds a message to a ticket. Staff may mark it internal. */
export async function replyToTicket(ticketId: string, formData: FormData): Promise<Result> {
  const body = String(formData.get('body') ?? '').trim()
  const internal = formData.get('internal') === 'on'
  if (!body) return { ok: false, reason: 'Write a message first.' }
  if (body.length > 5000) return { ok: false, reason: 'The message must be 5000 characters or fewer.' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('feedback_reply', { p_ticket_id: ticketId, p_body: body, p_internal: internal })
  if (error) return { ok: false, reason: error.message }

  revalidatePath(`/feedback/${ticketId}`)
  revalidatePath(`/console/feedback/${ticketId}`)
  revalidatePath('/feedback')
  revalidatePath('/console/feedback')
  return { ok: true }
}

/** Status change. The person may only close their own; staff may set any. */
export async function setTicketStatus(ticketId: string, status: string): Promise<Result> {
  const supabase = await createClient()
  const { error } = await supabase.rpc('feedback_set_status', { p_ticket_id: ticketId, p_status: status })
  if (error) return { ok: false, reason: error.message }
  revalidatePath(`/feedback/${ticketId}`)
  revalidatePath(`/console/feedback/${ticketId}`)
  revalidatePath('/feedback')
  revalidatePath('/console/feedback')
  return { ok: true }
}
