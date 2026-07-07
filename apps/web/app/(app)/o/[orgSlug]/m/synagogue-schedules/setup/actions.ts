'use server'

import { revalidatePath } from 'next/cache'
import { dayTypeSchema, lineRuleSchema, zmanNameSchema } from '@modules/synagogue-schedules'
import { createClient } from '@/lib/supabase/server'

// Maker-console actions. RLS (syn_can_write) is the enforcement layer —
// makers, org owners/admins, and superadmins can write; anyone else gets a
// database error, not silent success.

function fail(error: { message: string } | null, what: string) {
  if (error) throw new Error(`${what}: ${error.message}`)
}

async function db() {
  return await createClient()
}

export async function createScheduleType(orgId: string, orgSlug: string, formData: FormData) {
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Name is required')
  const span = formData.get('span') === 'day' ? 'day' : 'week'
  const dayTypes = formData.getAll('dayTypes').map(String)
  const trigger = dayTypes.length > 0 ? { dayTypes: dayTypes.map((d) => dayTypeSchema.parse(d)) } : {}

  const supabase = await db()
  const { error } = await supabase.from('syn_schedule_types').insert({
    org_id: orgId,
    name,
    name_hebrew: String(formData.get('nameHebrew') ?? '').trim() || null,
    trigger_condition: trigger,
    span,
  })
  fail(error, 'Create schedule type failed')
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules/setup`)
}

export async function deleteScheduleType(orgSlug: string, id: string) {
  const supabase = await db()
  const { error } = await supabase.from('syn_schedule_types').delete().eq('id', id)
  fail(error, 'Delete failed')
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules/setup`)
}

export async function createSection(
  orgId: string,
  orgSlug: string,
  scheduleTypeId: string,
  formData: FormData,
) {
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Name is required')
  const supabase = await db()
  const { error } = await supabase.from('syn_sections').insert({
    org_id: orgId,
    schedule_type_id: scheduleTypeId,
    name,
    name_hebrew: String(formData.get('nameHebrew') ?? '').trim() || null,
  })
  fail(error, 'Create section failed')
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules/setup`)
}

export async function deleteSection(orgSlug: string, id: string) {
  const supabase = await db()
  const { error } = await supabase.from('syn_sections').delete().eq('id', id)
  fail(error, 'Delete failed')
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules/setup`)
}

export async function createLine(
  orgId: string,
  orgSlug: string,
  sectionId: string,
  formData: FormData,
) {
  const name = String(formData.get('name') ?? '').trim()
  if (!name) throw new Error('Name is required')

  // Assemble the rule from the structured form, then validate against the
  // module's grammar so bad config can never reach the database.
  const condition: Record<string, unknown> = {}
  const condDayTypes = formData.getAll('condDayTypes').map(String)
  if (condDayTypes.length > 0) condition.dayTypes = condDayTypes
  const condDaysOfWeek = formData.getAll('condDaysOfWeek').map(Number)
  if (condDaysOfWeek.length > 0) condition.daysOfWeek = condDaysOfWeek
  const season = String(formData.get('season') ?? '')
  if (season === 'winter' || season === 'summer') condition.season = season

  const timeKind = String(formData.get('timeKind') ?? 'none')
  let time: Record<string, unknown>
  if (timeKind === 'fixed') {
    time = { kind: 'fixed', clock: String(formData.get('clock') ?? '') }
  } else if (timeKind === 'zman') {
    // Free-text myzmanim field name wins over the curated dropdown.
    const zmanCustom = String(formData.get('zmanCustom') ?? '').trim()
    time = {
      kind: 'zman',
      zman: zmanCustom || zmanNameSchema.parse(String(formData.get('zman') ?? 'sunset')),
      offsetMinutes: Number(formData.get('offsetMinutes') ?? 0) || 0,
    }
    const aggregate = String(formData.get('aggregate') ?? '')
    if (aggregate === 'earliest-of-week' || aggregate === 'latest-of-week') {
      time.aggregate = aggregate
    } else if (/^day-[0-6]$/.test(aggregate)) {
      time.aggregate = { dayOfWeek: Number(aggregate.slice(4)) }
    }
    const roundTo = Number(formData.get('roundTo') ?? 0)
    if (roundTo > 0) {
      const direction = String(formData.get('roundDirection') ?? 'down')
      time.round = {
        direction: ['down', 'up', 'nearest'].includes(direction) ? direction : 'down',
        toMinutes: roundTo,
      }
    }
    const notBefore = String(formData.get('notBefore') ?? '').trim()
    if (/^\d{2}:\d{2}$/.test(notBefore)) time.notBefore = notBefore
    const notAfter = String(formData.get('notAfter') ?? '').trim()
    if (/^\d{2}:\d{2}$/.test(notAfter)) time.notAfter = notAfter
  } else {
    time = { kind: 'none' }
  }

  const rule = lineRuleSchema.parse({
    ...(Object.keys(condition).length > 0 ? { condition } : {}),
    time,
  })

  const supabase = await db()
  const { error } = await supabase.from('syn_lines').insert({
    org_id: orgId,
    section_id: sectionId,
    name,
    name_hebrew: String(formData.get('nameHebrew') ?? '').trim() || null,
    rule,
  })
  fail(error, 'Create line failed')
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules/setup`)
}

export async function deleteLine(orgSlug: string, id: string) {
  const supabase = await db()
  const { error } = await supabase.from('syn_lines').delete().eq('id', id)
  fail(error, 'Delete failed')
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules/setup`)
}

export async function publishWeek(orgId: string, orgSlug: string, formData: FormData) {
  const weekStart = String(formData.get('weekStart') ?? '')
  if (!weekStart) throw new Error('Week start date is required')
  const supabase = await db()
  const { error } = await supabase
    .from('syn_published_weeks')
    .upsert({ org_id: orgId, week_start: weekStart, published: true })
  fail(error, 'Publish failed')
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules/setup`)
}

export async function unpublishWeek(orgSlug: string, orgId: string, weekStart: string) {
  const supabase = await db()
  const { error } = await supabase
    .from('syn_published_weeks')
    .delete()
    .eq('org_id', orgId)
    .eq('week_start', weekStart)
  fail(error, 'Unpublish failed')
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules/setup`)
}

export async function createOverride(
  orgId: string,
  orgSlug: string,
  formData: FormData,
) {
  const sectionId = String(formData.get('sectionId') ?? '')
  const weekStart = String(formData.get('weekStart') ?? '')
  const text = String(formData.get('text') ?? '').trim()
  if (!sectionId || !weekStart || !text) throw new Error('Section, week, and text are required')

  const supabase = await db()
  const { error } = await supabase.from('syn_overrides').insert({
    org_id: orgId,
    section_id: sectionId,
    week_start: weekStart,
    text,
    text_hebrew: String(formData.get('textHebrew') ?? '').trim() || null,
  })
  fail(error, 'Create override failed')
  revalidatePath(`/o/${orgSlug}/m/synagogue-schedules/setup`)
}
