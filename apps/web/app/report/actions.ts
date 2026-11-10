'use server'

import { headers } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import { REPORT_REASONS } from '@/lib/content-reports'

// The public Report content route (module-9 spec §B1/§H(c); migration
// 20261114010000). Open to people who are NOT signed in.
//
// The database is the gate: content_report_submit refuses any call without the
// server-only CONTENT_REPORT_TOKEN, caps reports per visitor address and
// platform-wide, and re-validates every field. This action runs as the visitor
// (their own Supabase client, anon or signed in, never the service role) and
// only adds the token and the address hint.
//
// Refusals come back as {ok, reason} (docs/03 #22). 'fields' = something the
// person can fix; 'refused' = anything else (limit reached, intake down).

export type ReportField = 'where' | 'reason' | 'details' | 'email' | 'signature' | 'nonconsent' | 'accurate'
export type ReportResult = { ok: true } | { ok: false; reason: 'fields'; fields: ReportField[] } | { ok: false; reason: 'refused' }

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

export async function submitReport(formData: FormData): Promise<ReportResult> {
  // Honeypot: a hidden field people never see. A bot that fills it is told
  // "thank you" and nothing is stored.
  if (String(formData.get('website') ?? '') !== '') return { ok: true }

  const where = String(formData.get('where') ?? '').trim()
  const reason = String(formData.get('reason') ?? '')
  const details = String(formData.get('details') ?? '').trim()
  const email = String(formData.get('email') ?? '').trim()
  const signature = String(formData.get('signature') ?? '').trim()
  const nonconsent = formData.get('nonconsent') === 'on'
  const accurate = formData.get('accurate') === 'on'
  const intimate = reason === 'intimate'

  // Same limits as the database, checked here so the person sees which field.
  const fields: ReportField[] = []
  if (!where || where.length > 1000) fields.push('where')
  if (!REPORT_REASONS.some((r) => r.value === reason)) fields.push('reason')
  if (details.length > 2000) fields.push('details')
  if (!EMAIL_RE.test(email) || email.length > 254) fields.push('email')
  if (intimate && (!signature || signature.length > 200)) fields.push('signature')
  if (intimate && !nonconsent) fields.push('nonconsent')
  if (!accurate) fields.push('accurate')
  if (fields.length) return { ok: false, reason: 'fields', fields }

  const token = process.env.CONTENT_REPORT_TOKEN
  if (!token) return { ok: false, reason: 'refused' }
  const h = await headers()
  // Vercel sets x-real-ip to the visitor's address; locally every visitor is 'unknown'.
  const clientHint = h.get('x-real-ip') ?? h.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'

  const supabase = await createClient()
  const { error } = await supabase.rpc('content_report_submit', {
    p_token: token,
    p_client_hint: clientHint,
    p_where_seen: where,
    p_reason: reason,
    p_details: details || null,
    p_email: email,
    p_accurate: true,
    p_signature: intimate ? signature : null,
    p_nonconsent: intimate,
  })
  if (!error) return { ok: true }
  if (/Invalid report/.test(error.message)) return { ok: false, reason: 'fields', fields: [] }
  // A refusal inside submit rolls back with it, so it is counted by a separate call
  // (the dashboard shows refusals, so a flood is seen).
  if (/Too many reports/.test(error.message)) {
    await supabase.rpc('content_report_note_refusal', { p_token: token, p_client_hint: clientHint })
  }
  return { ok: false, reason: 'refused' }
}
