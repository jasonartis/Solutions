// Pure test (no database): flat vs marginal split, usage presets, resilience lines.
// Reference numbers are the founder's 2026-11-17 table (mauRatio 100%, platform lines only, no Resilience group).
import { describe, expect, it } from 'vitest'
import { DEFAULT_GLOBALS, DEFAULT_MODULES, USAGE_PRESETS, activePreset, applyPreset, flatMarginal, planFor, type PresetKey } from '@platform/core'

const g = { ...DEFAULT_GLOBALS, mauRatio: 1 }
const platformOnly = (n: number, key: PresetKey) => flatMarginal(planFor(n, applyPreset(DEFAULT_MODULES, key), g).lines.filter((l) => l.group !== 'Resilience'))

describe('cost model: flat vs marginal, presets, resilience', () => {
  const ref: [PresetKey, number, number][] = [
    ['light', 10, 69.04], ['light', 100, 69.05], ['light', 1000, 95.11],
    ['typical', 10, 69.14], ['typical', 100, 70.02], ['typical', 1000, 135.86],
    ['heavy', 10, 69.88], ['heavy', 100, 153.78], ['heavy', 1000, 481.77],
  ]
  for (const [k, n, total] of ref) it(`${k} at ${n} users totals $${total}`, () => expect(platformOnly(n, k).total).toBeCloseTo(total, 1))

  it('heavy flat part is 69.04 at 10 and 100 users, 95.04 at 1000 (and marginal is the rest)', () => {
    expect(platformOnly(10, 'heavy').flat).toBeCloseTo(69.04, 1)
    expect(platformOnly(100, 'heavy').flat).toBeCloseTo(69.04, 1)
    const t = platformOnly(1000, 'heavy')
    expect(t.flat).toBeCloseTo(95.04, 1)
    expect(t.marginal).toBeGreaterThan(300)
  })

  it('presets are recognised; typical equals the defaults; an edit reads as custom', () => {
    for (const k of ['light', 'typical', 'heavy'] as const) expect(activePreset(applyPreset(DEFAULT_MODULES, k))).toBe(k)
    expect(activePreset(DEFAULT_MODULES)).toBe('typical')
    expect(activePreset(DEFAULT_MODULES.map((m, i) => (i === 1 ? { ...m, adoption: 0.9 } : m)))).toBe('custom')
    expect(USAGE_PRESETS.light.adoption['matchmaking']).toBe(0)
    expect(USAGE_PRESETS.light.adoption['core']).toBe(1)
  })

  it('resilience: cold = one $2 flat line, warm adds the CPX22 box; the domain is not doubled', () => {
    const lines = (r: 'cold' | 'warm') => planFor(1000, DEFAULT_MODULES, { ...g, resilience: r }).lines
    const cold = lines('cold').filter((l) => l.group === 'Resilience')
    const warm = lines('warm').filter((l) => l.group === 'Resilience')
    expect(cold).toHaveLength(1)
    expect(cold[0]!.monthly).toBe(2)
    expect(warm).toHaveLength(2)
    expect(warm[1]!.monthly).toBeCloseTo(19.99 * 1.14, 2)
    expect(warm.every((l) => l.fixed)).toBe(true)
    expect(lines('warm').filter((l) => /domain/i.test(l.label))).toHaveLength(1)
  })
})
