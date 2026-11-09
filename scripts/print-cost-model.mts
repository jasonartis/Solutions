// Prints docs/costs/cost-model.md's tables from the SAME model the Owner Console
// page uses (packages/platform/src/cost-model.ts). Run: pnpm exec tsx scripts/print-cost-model.mts
// Paste/redirect the output into docs/costs/cost-model.md so docs and page never disagree.
import { PRICES, DEFAULT_GLOBALS, DEFAULT_MODULES, TIERS, planFor, allocate, personaCost, priceForMargin, CORE_KEY } from '../packages/platform/src/cost-model'

const usd = (n: number) => '$' + (n >= 100 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2))
const label = (n: number) => (n >= 1e9 ? '1B' : n >= 1e6 ? n / 1e6 + 'M' : n >= 1e3 ? n / 1e3 + 'k' : String(n))
const g = DEFAULT_GLOBALS
const m = DEFAULT_MODULES
const plans = TIERS.map((n) => ({ n, plan: planFor(n, m, g) }))

console.log('## Totals\n')
console.log('| Registered users | Active (30%) | Monthly | Yearly | Per registered user / month | Architecture |')
console.log('|---:|---:|---:|---:|---:|---|')
for (const { n, plan } of plans) {
  console.log(`| ${label(n)} | ${label(n * g.mauRatio)} | ${usd(plan.monthly)} | ${usd(plan.yearly)} | ${usd(plan.monthly / n)} | ${plan.name} |`)
}
console.log('\n## Cost by module (monthly)\n')
console.log('| Module | ' + TIERS.map(label).join(' | ') + ' |')
console.log('|---|' + TIERS.map(() => '---:').join('|') + '|')
const allocs = plans.map(({ n, plan }) => allocate(n, m, g, plan))
for (const mod of m) console.log(`| ${mod.name} | ` + allocs.map((a) => usd(a.find((c) => c.key === mod.key)!.monthly)).join(' | ') + ' |')
console.log('\n## Cost per ACTIVE user using that module (monthly)\n')
console.log('| Module | ' + TIERS.map(label).join(' | ') + ' |')
console.log('|---|' + TIERS.map(() => '---:').join('|') + '|')
for (const mod of m) console.log(`| ${mod.name} | ` + allocs.map((a) => usd(a.find((c) => c.key === mod.key)!.perUserMonthly)).join(' | ') + ' |')
console.log('\n## Marginal cost per ACTIVE user (usage-driven lines only, no share of fixed plans)\n')
console.log('| Module | ' + TIERS.map(label).join(' | ') + ' |')
console.log('|---|' + TIERS.map(() => '---:').join('|') + '|')
for (const mod of m) console.log(`| ${mod.name} | ` + allocs.map((a) => usd(a.find((c) => c.key === mod.key)!.perUserMarginalMonthly)).join(' | ') + ' |')
console.log('\n## Staying managed vs the recommended architecture (platform infrastructure only: database, auth, hosting, files)\n')
console.log('| Users | Recommended | Same load on Supabase + Vercel list prices (lower bound) |\n|---|---:|---:|')
for (const { n, plan } of plans) console.log(`| ${label(n)} | ${usd(plan.platformInfraMonthly)} | ${usd(plan.staysManagedLowerBound)} |`)
console.log('\n## Line items per tier\n')
for (const { n, plan } of plans) {
  console.log(`### ${label(n)} users — ${plan.name}\n`)
  console.log('| Group | Line | Monthly | Confidence |\n|---|---|---:|---|')
  for (const l of plan.lines) console.log(`| ${l.group} | ${l.label} | ${usd(l.monthly)} | ${l.confidence} |`)
  console.log(`| | **Total** | **${usd(plan.monthly)}** | |`)
  console.log('')
}
console.log('## Worked persona: a Single who uses Make-a-Match + Photos\n')
console.log('| Users | Loaded cost / month | Marginal cost / month | Price at 40% margin | Price at 70% margin |\n|---|---:|---:|---:|---:|')
plans.forEach(({ n }, i) => {
  const pc = personaCost(allocs[i], ['matchmaking', 'photos'])
  const c = pc.perUserMonthly
  console.log(`| ${label(n)} | ${usd(c)} | ${usd(pc.perUserMarginalMonthly)} | ${usd(priceForMargin(c, 40))} | ${usd(priceForMargin(c, 70))} |`)
})
void CORE_KEY

if (process.argv.includes('--prices')) {
  console.log('\n## PRICE SHEET\n')
  console.log('| Vendor | Item | Price | Unit | Checked | Confidence | Source / note |\n|---|---|---:|---|---|---|---|')
  for (const p of Object.values(PRICES)) console.log(`| ${p.vendor} | ${p.item} | ${p.value} | ${p.unit} | ${p.checked} | ${p.confidence} | ${p.source}${'note' in p && p.note ? ' — ' + p.note : ''} |`)
}
