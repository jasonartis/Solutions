// Platform-owner tool: set a synagogue org's location settings in PRODUCTION.
//   pnpm exec tsx scripts/prod-set-shul-location.ts <org-slug> [lat] [lng] [tz] [myzmanimLocationId]
// Defaults: Brooklyn 11210 (the founder's shul).
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const here = dirname(fileURLToPath(import.meta.url))
const env = readFileSync(resolve(here, '../.env.deploy'), 'utf8')
const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1]?.trim() ?? ''

const [slug, lat, lng, tz, locationId] = process.argv.slice(2)
if (!slug) {
  console.error('Usage: pnpm exec tsx scripts/prod-set-shul-location.ts <org-slug> [lat] [lng] [tz] [locationId]')
  process.exit(1)
}

async function main() {
  const admin = createClient(
    `https://${get('SUPABASE_PROJECT_REF')}.supabase.co`,
    get('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } },
  )
  const { data: org } = await admin.from('orgs').select('id, name').eq('slug', slug).single()
  if (!org) throw new Error(`No org with slug '${slug}'`)

  const { data: row } = await admin
    .from('org_modules')
    .select('settings')
    .eq('org_id', org.id)
    .eq('module_key', 'synagogue-schedules')
    .single()
  if (!row) throw new Error(`Module not enabled for '${slug}' — toggle it in the Owner Console first`)

  const settings = {
    ...(row.settings as object),
    latitude: Number(lat ?? 40.7128),
    longitude: Number(lng ?? -73.9497),
    timezone: tz ?? 'America/New_York',
    israel: false,
    myzmanimLocationId: locationId ?? 'US11210',
  }
  const { error } = await admin
    .from('org_modules')
    .update({ settings })
    .eq('org_id', org.id)
    .eq('module_key', 'synagogue-schedules')
  if (error) throw new Error(error.message)
  console.log(`${org.name} (${slug}) location set:`, JSON.stringify(settings))
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
