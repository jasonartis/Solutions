// Sanity checks for the cost model (docs/costs). Pure — no database. They guard the
// properties a pricing decision leans on, each with a control so a silently-empty
// model cannot pass (docs/03 "Test discipline").
import { describe, expect, it } from 'vitest'
import { DEFAULT_GLOBALS, DEFAULT_MODULES, TIERS, allocate, computeFlows, evaluatePricing, personaCost, planFor, priceForMargin, resolvePrices, PRICES } from '@platform/core'

const g = DEFAULT_GLOBALS
const m = DEFAULT_MODULES

describe('cost model', () => {
  it('every tier prices to a positive, finite monthly total with line items (control: not vacuous)', () => {
    for (const n of TIERS) {
      const plan = planFor(n, m, g)
      expect(plan.lines.length).toBeGreaterThan(3)
      expect(plan.monthly).toBeGreaterThan(0)
      expect(Number.isFinite(plan.monthly)).toBe(true)
      expect(plan.yearly).toBeCloseTo(plan.monthly * 12, 6)
    }
  })

  it('total cost never falls as users grow', () => {
    const totals = TIERS.map((n) => planFor(n, m, g).monthly)
    for (let i = 1; i < totals.length; i++) expect(totals[i]!).toBeGreaterThan(totals[i - 1]!)
  })

  it('module allocation adds back up to the plan total (nothing lost or double-counted)', () => {
    for (const n of TIERS) {
      const plan = planFor(n, m, g)
      const sum = allocate(n, m, g, plan).reduce((s, c) => s + c.monthly, 0)
      expect(sum).toBeCloseTo(plan.monthly, 3)
    }
  })

  it('the architecture changes at the documented sizes', () => {
    expect(planFor(1_000, m, g).architecture).toBe('managed')
    expect(planFor(100_000, m, g).architecture).toBe('managed')
    expect(planFor(10_000_000, m, g).architecture).toBe('self-run')
    expect(planFor(1_000_000_000, m, g).architecture).toBe('multi-region')
  })

  it('marginal cost never exceeds loaded cost, and per-user cost falls as fixed plans spread', () => {
    const small = allocate(10, m, g, planFor(10, m, g))
    const big = allocate(100_000, m, g, planFor(100_000, m, g))
    const s = personaCost(small, ['matchmaking'])
    const b = personaCost(big, ['matchmaking'])
    expect(s.perUserMarginalMonthly).toBeLessThanOrEqual(s.perUserMonthly)
    expect(b.perUserMonthly).toBeLessThan(s.perUserMonthly)
  })

  it('video is the cost driver for speed dating only (control: other modules have none)', () => {
    const f = computeFlows(100_000, m, g)
    expect(f.byModule['speed-dating']!.videoMin).toBeGreaterThan(0)
    for (const mod of m.filter((x) => x.key !== 'speed-dating')) expect(f.byModule[mod.key]!.videoMin).toBe(0)
  })

  it('priceForMargin: 50% margin doubles cost', () => {
    expect(priceForMargin(10, 50)).toBeCloseTo(20, 9)
    expect(priceForMargin(10, 0)).toBe(10)
  })

  it('every price carries a checked date, a source, and a confidence', () => {
    for (const [key, p] of Object.entries(PRICES)) {
      expect(p.checked, key).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(p.source.length, key).toBeGreaterThan(5)
      expect(['verified', 'third-party', 'assumption']).toContain(p.confidence)
    }
  })
})

describe('pricing (base fee per org + AI and video credits)', () => {
  const none = { orgs: 5, baseFeePerOrg: 0, aiPricePerCall: 0, videoPricePerMinute: 0, paymentFeePct: 0, ownCosts: [] }

  it('with no prices there is no revenue and profit equals minus cost (control: costs exist)', () => {
    const r = evaluatePricing(1_000, m, g, undefined, none, 50)
    expect(r.platformCost).toBeGreaterThan(0)
    expect(r.revenue).toBe(0)
    expect(r.profit).toBeCloseTo(-r.platformCost, 6)
    expect(r.marginPct).toBeNull()
  })

  it('charging the suggested prices hits the target margin', () => {
    const base = evaluatePricing(100_000, m, g, undefined, { ...none, orgs: 20 }, 40)
    const priced = evaluatePricing(100_000, m, g, undefined, { ...none, orgs: 20, baseFeePerOrg: base.suggestedBaseFeePerOrg, aiPricePerCall: base.suggestedAiPricePerCall, videoPricePerMinute: base.suggestedVideoPricePerMinute }, 40)
    expect(priced.marginPct!).toBeCloseTo(40, 3)
  })

  it('own costs and payment fees lower profit; break-even is found and really breaks even', () => {
    const pr = { ...none, orgs: 5, baseFeePerOrg: 100, paymentFeePct: 3, ownCosts: [{ id: 1, name: 'legal', monthly: 200 }] }
    const r = evaluatePricing(1_000, m, g, undefined, pr, 40)
    expect(r.ownCostsTotal).toBe(200)
    expect(r.paymentFees).toBeCloseTo(r.revenue * 0.03, 6)
    expect(r.breakEvenOrgs).not.toBeNull()
    const k = r.breakEvenOrgs!
    const at = (n: number) => evaluatePricing((1_000 / 5) * n, m, g, undefined, { ...pr, orgs: n }, 40).profit
    expect(at(k)).toBeGreaterThanOrEqual(0)
    if (k > 1) expect(at(k - 1)).toBeLessThan(0)
  })

  it('a price override changes the bill; an unknown or non-finite override is ignored', () => {
    const base = planFor(1_000, m, g).monthly
    expect(planFor(1_000, m, g, { vercelProSeat: 120 }).monthly).toBeCloseTo(base + 100, 6)
    expect(planFor(1_000, m, g, { vercelProSeat: NaN }).monthly).toBeCloseTo(base, 6)
    expect(resolvePrices({ vercelProSeat: 5 }).vercelProSeat).toBe(5)
    expect(resolvePrices().vercelProSeat).toBe(20)
  })
})
