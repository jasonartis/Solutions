import { chromium } from 'playwright'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  buildWeek,
  generateWeek,
  lineRuleSchema,
  myzmanimCredsFromEnv,
  renderScheduleHtml,
  type ScheduleTypeConfig,
} from '../../../../modules/synagogue-schedules/src/index'

// job_requests kind: 'synagogue-schedules.render'
// payload: { weekStart: 'YYYY-MM-DD' } (a Sunday)
// Renders every enabled export profile for the org's week into the
// syn-exports bucket and returns the storage paths.
export const RENDER_KIND = 'synagogue-schedules.render'

type Job = { id: string; org_id: string; payload: { weekStart?: string } }

export async function runSynagogueRender(admin: SupabaseClient, job: Job) {
  const weekStart = job.payload.weekStart
  if (!weekStart || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new Error(`Invalid weekStart in payload: ${weekStart}`)
  }
  const orgId = job.org_id

  const [{ data: org }, { data: entitlement }] = await Promise.all([
    admin.from('orgs').select('name').eq('id', orgId).single(),
    admin
      .from('org_modules')
      .select('enabled, settings')
      .eq('org_id', orgId)
      .eq('module_key', 'synagogue-schedules')
      .single(),
  ])
  if (!org || !entitlement?.enabled) throw new Error('Org missing or module not enabled')
  const settings = entitlement.settings as {
    latitude?: number
    longitude?: number
    timezone?: string
    israel?: boolean
    accentColor?: string
    logoUrl?: string
    myzmanimLocationId?: string
  }
  const timeZone = settings.timezone ?? 'America/New_York'

  // myzmanim primary, hebcal fallback (spec).
  const week = await buildWeek(weekStart, {
    latitude: settings.latitude,
    longitude: settings.longitude,
    timeZone,
    israel: settings.israel,
    myzmanimLocationId: settings.myzmanimLocationId,
    credentials: myzmanimCredsFromEnv(),
  })
  const sunday = new Date(`${weekStart}T12:00:00`)

  const [{ data: types }, { data: sections }, { data: lines }, { data: overrides }, { data: profiles }] =
    await Promise.all([
      admin.from('syn_schedule_types').select('*').eq('org_id', orgId).order('sort'),
      admin.from('syn_sections').select('*').eq('org_id', orgId).order('sort'),
      admin.from('syn_lines').select('*').eq('org_id', orgId).order('sort'),
      admin.from('syn_overrides').select('*').eq('org_id', orgId).eq('week_start', weekStart),
      admin
        .from('syn_export_profiles')
        .select('*')
        .eq('org_id', orgId)
        .eq('enabled', true)
        .order('sort'),
    ])
  if (!profiles || profiles.length === 0) throw new Error('No enabled export profiles configured')

  const config: ScheduleTypeConfig[] = (types ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    nameHebrew: t.name_hebrew,
    triggerCondition: t.trigger_condition ?? {},
    span: t.span,
    sections: (sections ?? [])
      .filter((s) => s.schedule_type_id === t.id)
      .map((s) => ({
        id: s.id,
        name: s.name,
        nameHebrew: s.name_hebrew,
        visibilityCondition: s.visibility_condition ?? {},
        lines: (lines ?? [])
          .filter((l) => l.section_id === s.id)
          .flatMap((l) => {
            const parsed = lineRuleSchema.safeParse(l.rule)
            return parsed.success ? [{ name: l.name, nameHebrew: l.name_hebrew, rule: parsed.data }] : []
          }),
      })),
  }))

  const documents = generateWeek(
    config,
    (overrides ?? []).map((o) => ({ sectionId: o.section_id, text: o.text, textHebrew: o.text_hebrew })),
    week,
    timeZone,
  )

  const subtitle = `Week of ${sunday.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`

  const browser = await chromium.launch()
  const outputs: { profile: string; path: string }[] = []
  try {
    for (const profile of profiles) {
      const html = renderScheduleHtml(
        documents,
        {
          orgName: org.name,
          accentColor: settings.accentColor ?? null,
          logoUrl: settings.logoUrl ?? null,
        },
        { grayscale: profile.grayscale, subtitle },
      )
      const page = await browser.newPage()
      await page.setContent(html, { waitUntil: 'networkidle' })

      let buffer: Buffer
      let ext: string
      let contentType: string
      if (profile.format === 'pdf') {
        const margin = `${profile.margins_mm ?? 12}mm`
        buffer = await page.pdf({
          format: 'Letter',
          margin: { top: margin, right: margin, bottom: margin, left: margin },
          printBackground: true,
        })
        ext = 'pdf'
        contentType = 'application/pdf'
      } else {
        await page.setViewportSize({ width: profile.width_px ?? 1200, height: 800 })
        buffer = await page.screenshot({ fullPage: true, type: 'jpeg', quality: 90 })
        ext = 'jpg'
        contentType = 'image/jpeg'
      }
      await page.close()

      const slug = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      const path = `${orgId}/${weekStart}/${slug}.${ext}`
      const { error } = await admin.storage
        .from('syn-exports')
        .upload(path, buffer, { contentType, upsert: true })
      if (error) throw new Error(`Upload failed for ${profile.name}: ${error.message}`)
      outputs.push({ profile: profile.name, path })
    }
  } finally {
    await browser.close()
  }

  return { files: outputs }
}
