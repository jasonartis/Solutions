import JSZip from 'jszip'
import { NextResponse } from 'next/server'
import { getModule } from '@platform/core'
import { createClient } from '@/lib/supabase/server'
import { exportRegistry } from '@/lib/export-registry'
import { readExportSettings } from '@/lib/export-settings'
import { toCsv } from '@/lib/csv'

// Data-export endpoint (docs/03 primitive). POST form fields: orgSlug,
// moduleKey, hat, sets (repeated). Every fetch runs AS the caller under RLS —
// the export can never contain more than they can already read — and the hat
// must be one the caller actually holds (server-checked, not trusted).
export async function POST(request: Request) {
  const form = await request.formData()
  const orgSlug = String(form.get('orgSlug') ?? '')
  const moduleKey = String(form.get('moduleKey') ?? '')
  const hat = String(form.get('hat') ?? '')
  const setKeys = form.getAll('sets').map(String)

  const def = exportRegistry[moduleKey]
  if (!def || !getModule(moduleKey) || setKeys.length === 0) {
    return NextResponse.json({ error: 'Nothing to export' }, { status: 400 })
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })

  // Org by slug (RLS hides orgs the caller isn't in) + entitlement check.
  const { data: org } = await supabase.from('orgs').select('id, slug').eq('slug', orgSlug).single()
  if (!org) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const { data: entitlement } = await supabase
    .from('org_modules')
    .select('enabled')
    .eq('org_id', org.id)
    .eq('module_key', moduleKey)
    .single()
  if (!entitlement?.enabled) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const ctx = { orgId: org.id, userId: user.id }
  const myHats = await def.myHats(supabase, ctx)
  if (!myHats.includes(hat)) {
    return NextResponse.json({ error: 'You do not hold that hat' }, { status: 403 })
  }

  // Export controls: staff bypass their own switches; everyone else is bound.
  const [settings, { data: isStaff }] = await Promise.all([
    readExportSettings(supabase, org.id, moduleKey),
    supabase.rpc('module_can_manage', { check_org_id: org.id, check_module_key: moduleKey }),
  ])
  if (!isStaff && settings.disabledHats.includes(hat)) {
    return NextResponse.json({ error: 'Exporting is turned off for this role' }, { status: 403 })
  }

  const zip = new JSZip()
  const included: string[] = []
  for (const set of def.dataSets) {
    if (!setKeys.includes(set.key)) continue
    if (!set.hats.includes(hat)) continue // hat filter is server-side too
    if (!isStaff && settings.disabledSets.includes(set.key)) continue // controls too
    const rows = await set.fetch(supabase, ctx)
    zip.file(`${set.key}.csv`, toCsv(rows))
    zip.file(`${set.key}.json`, JSON.stringify(rows, null, 2))
    included.push(`${set.key} (${rows.length} rows)`)
  }
  if (included.length === 0) {
    return NextResponse.json({ error: 'No data sets matched your selection' }, { status: 400 })
  }
  zip.file(
    'README.txt',
    `Solutions Platform data export\norg: ${org.slug}\nmodule: ${moduleKey}\nhat: ${hat}\nexported: ${new Date().toISOString()}\n\nContents:\n${included.join('\n')}\n`,
  )

  const bytes = await zip.generateAsync({ type: 'uint8array' })
  const stamp = new Date().toISOString().slice(0, 10)
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${org.slug}-${moduleKey}-${stamp}.zip"`,
    },
  })
}
