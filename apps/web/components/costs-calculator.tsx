'use client'

// Owner Console cost model (docs/costs). Everything is computed in the browser from
// packages/platform/src/cost-model.ts — the same numbers docs/costs/cost-model.md is
// generated from. Nothing here reads or writes the database: assumptions and user
// types you edit are kept in THIS browser (localStorage) only.

import { useEffect, useMemo, useState } from 'react'
import {
  CORE_KEY,
  DEFAULT_GLOBALS,
  DEFAULT_MODULES,
  PRICES,
  TIERS,
  allocate,
  evaluatePricing,
  personaCost,
  planFor,
  priceForMargin,
  type Confidence,
  type Globals,
  type ModuleAssumption,
  type OwnCost,
  type PriceKey,
  type PriceOverrides,
  type PricingInputs,
} from '@platform/core'
import type { RealNumbers } from '@/lib/costs-real'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const STORE = 'costs-calculator.v2'
const STALE_DAYS = 90

// The founder's own costs start at $0 on purpose (2026-11-09): he fills them in when he knows them.
const DEFAULT_OWN_COSTS: OwnCost[] = [
  { id: 1, name: 'Legal / terms and privacy review', monthly: 0 },
  { id: 2, name: 'Accountant / bookkeeping', monthly: 0 },
  { id: 3, name: 'Insurance', monthly: 0 },
  { id: 4, name: 'My own time', monthly: 0 },
]

const DEFAULT_PRICING = { orgs: 1, baseFeePerOrg: 0, aiPricePerCall: 0, videoPricePerMinute: 0, paymentFeePct: 0 }

interface UserType {
  id: number
  name: string
  count: number
  modules: string[]
}

const DEFAULT_TYPES: UserType[] = [
  { id: 1, name: 'Single (matchmaking + photos)', count: 60, modules: ['matchmaking', 'photos'] },
  { id: 2, name: 'Student', count: 25, modules: ['classroom'] },
  { id: 3, name: 'Salon customer', count: 10, modules: ['nail-salon'] },
  { id: 4, name: 'Speed dater', count: 5, modules: ['speed-dating', 'matchmaking'] },
]

const usd = (n: number) => (n >= 1000 ? '$' + Math.round(n).toLocaleString('en-US') : n >= 1 ? '$' + n.toFixed(2) : '$' + n.toFixed(4))
const short = (n: number) => (n >= 1e9 ? n / 1e9 + 'B' : n >= 1e6 ? n / 1e6 + 'M' : n >= 1e3 ? n / 1e3 + 'k' : String(n))

const CONF: Record<Confidence, string> = {
  verified: 'bg-green-100 text-green-800',
  'third-party': 'bg-amber-100 text-amber-800',
  assumption: 'bg-gray-200 text-gray-700',
}

export default function CostsCalculator({ real }: { real: RealNumbers }) {
  const [users, setUsers] = useState(100_000)
  const [globals, setGlobals] = useState<Globals>(DEFAULT_GLOBALS)
  const [modules, setModules] = useState<ModuleAssumption[]>(DEFAULT_MODULES)
  const [types, setTypes] = useState<UserType[]>(DEFAULT_TYPES)
  const [margin, setMargin] = useState(60)
  const [overrides, setOverrides] = useState<PriceOverrides>({})
  const [ownCosts, setOwnCosts] = useState<OwnCost[]>(DEFAULT_OWN_COSTS)
  const [pricing, setPricing] = useState(DEFAULT_PRICING)
  const [realNote, setRealNote] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  // Set after mount so the server-rendered page and the first client render agree.
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => setNow(Date.now()), [])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORE)
      if (raw) {
        const s = JSON.parse(raw)
        if (s.users) setUsers(s.users)
        if (s.globals) setGlobals({ ...DEFAULT_GLOBALS, ...s.globals })
        if (s.modules) setModules(DEFAULT_MODULES.map((d) => ({ ...d, adoption: s.modules[d.key] ?? d.adoption })))
        if (s.types) setTypes(s.types)
        if (typeof s.margin === 'number') setMargin(s.margin)
        if (s.overrides) setOverrides(s.overrides)
        if (s.ownCosts) setOwnCosts(s.ownCosts)
        if (s.pricing) setPricing({ ...DEFAULT_PRICING, ...s.pricing })
      }
    } catch {
      /* storage blocked or corrupt: start from defaults */
    }
    setLoaded(true)
  }, [])

  useEffect(() => {
    if (!loaded) return
    try {
      localStorage.setItem(
        STORE,
        JSON.stringify({ users, globals, margin, types, overrides, ownCosts, pricing, modules: Object.fromEntries(modules.map((m) => [m.key, m.adoption])) }),
      )
    } catch {
      /* ignore */
    }
  }, [loaded, users, globals, modules, types, margin, overrides, ownCosts, pricing])

  const plan = useMemo(() => planFor(users, modules, globals, overrides), [users, modules, globals, overrides])
  const costs = useMemo(() => allocate(users, modules, globals, plan), [users, modules, globals, plan])
  const allTiers = useMemo(() => TIERS.map((n) => ({ n, plan: planFor(n, modules, globals, overrides) })), [modules, globals, overrides])
  const result = useMemo(
    () => evaluatePricing(users, modules, globals, overrides, { ...pricing, orgs: Math.max(1, pricing.orgs), ownCosts } satisfies PricingInputs, margin),
    [users, modules, globals, overrides, pricing, ownCosts, margin],
  )
  const moduleName = (k: string) => modules.find((m) => m.key === k)?.name ?? k

  const typeRows = types.map((t) => {
    const c = personaCost(costs, t.modules)
    return { t, loaded: c.perUserMonthly, marginal: c.perUserMarginalMonthly, price: priceForMargin(c.perUserMonthly, margin) }
  })
  const totalTypeUsers = types.reduce((s, t) => s + t.count, 0)

  return (
    <div className="space-y-8">
      {/* Controls */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-lg font-semibold">1. How big is the platform?</h2>
        <div className="flex flex-wrap items-center gap-2">
          {TIERS.map((n) => (
            <button
              key={n}
              onClick={() => setUsers(n)}
              className={`rounded border px-3 py-1 text-sm ${users === n ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-gray-300'}`}
            >
              {short(n)}
            </button>
          ))}
          <label className="ml-3 text-sm text-gray-600">
            or any number of registered users{' '}
            <input
              type="number"
              min={1}
              value={users}
              onChange={(e) => setUsers(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              className={`${inputCls} w-40`}
            />
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
          <button
            onClick={() => {
              const ratio = real.registered > 0 ? Math.min(1, Math.max(0.05, real.active30 / real.registered)) : globals.mauRatio
              if (real.registered > 0) setUsers(real.registered)
              setGlobals({ ...globals, mauRatio: ratio })
              setModules(modules.map((m) => (m.key in real.moduleReach ? { ...m, adoption: Math.min(1, real.moduleReach[m.key] ?? m.adoption) } : m)))
              setPricing({ ...pricing, orgs: Math.max(1, real.orgs) })
              setRealNote(
                `Filled from the database at ${new Date(real.measuredAt).toLocaleString()}: ${real.registered} registered, ${real.active30} signed in during the last 30 days (${Math.round(ratio * 100)}%), ${real.orgs} organisations. Module shares are the share of members whose organisation has the module switched on, an upper bound on real use. Modules no organisation has switched on, and the AI and photos assumptions, keep their defaults.`,
              )
            }}
            className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700"
          >
            Use my real numbers
          </button>
          <button
            onClick={() => {
              setUsers(100_000)
              setGlobals(DEFAULT_GLOBALS)
              setModules(DEFAULT_MODULES)
              setRealNote(null)
            }}
            className="rounded border border-gray-300 px-3 py-1 hover:bg-gray-50"
          >
            Back to the default assumptions
          </button>
          <span className="text-gray-500">
            Right now: {real.registered} registered, {real.active30} active in 30 days, {real.orgs} organisations.
          </span>
        </div>
        {realNote && <p className="mt-2 rounded bg-blue-50 p-2 text-xs text-blue-900">{realNote}</p>}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-sm">
            <span className="block text-gray-600">Share of users active in a month: {Math.round(globals.mauRatio * 100)}%</span>
            <input type="range" min={5} max={100} value={Math.round(globals.mauRatio * 100)} onChange={(e) => setGlobals({ ...globals, mauRatio: Number(e.target.value) / 100 })} className="w-full" />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600">AI model</span>
            <select value={globals.aiModel} onChange={(e) => setGlobals({ ...globals, aiModel: e.target.value as 'sonnet' | 'haiku' })} className={inputCls}>
              <option value="sonnet">Sonnet 5.5 ($2 in / $10 out per M tokens)</option>
              <option value="haiku">Haiku 5.5 ($0.10 / $0.50)</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-gray-600">Months of data kept in the database and file storage</span>
            <input type="number" min={1} max={120} value={globals.retentionMonths} onChange={(e) => setGlobals({ ...globals, retentionMonths: Math.max(1, Number(e.target.value) || 1) })} className={`${inputCls} w-24`} />
          </label>
          <label className="text-sm">
            <span className="block text-gray-600">Target margin on price: {margin}%</span>
            <input type="range" min={0} max={90} value={margin} onChange={(e) => setMargin(Number(e.target.value))} className="w-full" />
          </label>
        </div>
      </section>

      {/* Result */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">2. What it costs</h2>
        <p className="text-3xl font-semibold">
          {usd(plan.monthly)} <span className="text-base font-normal text-gray-500">per month</span> · {usd(plan.yearly)}{' '}
          <span className="text-base font-normal text-gray-500">per year</span>
        </p>
        <p className="mt-1 text-sm text-gray-600">
          {Math.round(users * globals.mauRatio).toLocaleString('en-US')} active users · {usd(plan.monthly / users)} per registered user per month ·{' '}
          <strong>{plan.name}</strong>
        </p>
        <p className="mt-1 text-xs text-gray-500">Accuracy: {plan.accuracy}</p>

        <h3 className="mt-5 font-semibold">Where the setup has to change at this size</h3>
        <ul className="ml-5 mt-1 list-disc space-y-1 text-sm text-gray-700">
          {plan.changes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>

        <h3 className="mt-5 font-semibold">Line items</h3>
        <div className="overflow-x-auto">
          <table className="mt-1 w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-1 pr-3">Group</th>
                <th className="pr-3">Line</th>
                <th className="pr-3 text-right">Monthly</th>
                <th className="pr-3">Kind</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {plan.lines.map((l) => (
                <tr key={l.group + l.label} className="border-b border-gray-100 align-top">
                  <td className="py-1 pr-3 text-gray-500">{l.group}</td>
                  <td className="pr-3">
                    {l.label}
                    {l.note && <span className="block text-xs text-gray-500">{l.note}</span>}
                  </td>
                  <td className="pr-3 text-right tabular-nums">{usd(l.monthly)}</td>
                  <td className="pr-3 text-xs text-gray-500">{l.fixed ? 'fixed' : 'usage'}</td>
                  <td>
                    <span className={`rounded px-1.5 py-0.5 text-xs ${CONF[l.confidence]}`}>{l.confidence}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-gray-600">
          Platform infrastructure (database, auth, hosting, files) in this plan: <strong>{usd(plan.platformInfraMonthly)}</strong>/month. The same load on Supabase + Vercel list
          prices would be at least <strong>{usd(plan.staysManagedLowerBound)}</strong>/month
          {plan.architecture === 'managed' ? '.' : ' — and one managed database instance could not carry it.'}
        </p>
      </section>

      {/* Per module */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">3. By module</h2>
        <p className="mb-2 text-sm text-gray-600">
          <strong>Loaded</strong> includes a share of the fixed plans (Supabase, Vercel, servers), split by each module&apos;s share of traffic. <strong>Marginal</strong> is only what a
          user&apos;s own usage costs. Price below marginal and you lose money on every user; price below loaded and you only cover the fixed plans at scale. Adoption is editable.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-1 pr-3">Module</th>
                <th className="pr-3">Share of active users</th>
                <th className="pr-3 text-right">Monthly (loaded)</th>
                <th className="pr-3 text-right">Yearly</th>
                <th className="pr-3 text-right">Per user / month (loaded)</th>
                <th className="text-right">Per user / month (marginal)</th>
              </tr>
            </thead>
            <tbody>
              {costs.map((c) => {
                const m = modules.find((x) => x.key === c.key)!
                return (
                  <tr key={c.key} className="border-b border-gray-100">
                    <td className="py-1 pr-3" title={m.why}>
                      {c.name}
                    </td>
                    <td className="pr-3">
                      {c.key === CORE_KEY ? (
                        '100%'
                      ) : (
                        <input
                          type="number"
                          min={0}
                          max={100}
                          value={Math.round(m.adoption * 100)}
                          onChange={(e) => setModules(modules.map((x) => (x.key === c.key ? { ...x, adoption: Math.min(1, Math.max(0, Number(e.target.value) / 100)) } : x)))}
                          className={`${inputCls} w-20`}
                        />
                      )}
                    </td>
                    <td className="pr-3 text-right tabular-nums">{usd(c.monthly)}</td>
                    <td className="pr-3 text-right tabular-nums">{usd(c.monthly * 12)}</td>
                    <td className="pr-3 text-right tabular-nums">{usd(c.perUserMonthly)}</td>
                    <td className="text-right tabular-nums">{usd(c.perUserMarginalMonthly)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* User types */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">4. Cost and price by type of user</h2>
        <p className="mb-2 text-sm text-gray-600">
          A user type is a set of modules. The price shown earns your target margin ({margin}%) on the loaded cost at {short(users)} users. Types are kept in this browser only.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-1 pr-3">Type</th>
                <th className="pr-3">Modules</th>
                <th className="pr-3 text-right">Cost / user / month</th>
                <th className="pr-3 text-right">Marginal</th>
                <th className="pr-3 text-right">Price / month</th>
                <th className="pr-3 text-right">Price / year</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {typeRows.map(({ t, loaded: l, marginal, price }) => (
                <tr key={t.id} className="border-b border-gray-100 align-top">
                  <td className="py-1 pr-3">
                    <input value={t.name} onChange={(e) => setTypes(types.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))} className={`${inputCls} w-52`} />
                  </td>
                  <td className="pr-3">
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {modules
                        .filter((m) => m.key !== CORE_KEY)
                        .map((m) => (
                          <label key={m.key} className="whitespace-nowrap text-xs">
                            <input
                              type="checkbox"
                              checked={t.modules.includes(m.key)}
                              onChange={(e) =>
                                setTypes(types.map((x) => (x.id === t.id ? { ...x, modules: e.target.checked ? [...x.modules, m.key] : x.modules.filter((k) => k !== m.key) } : x)))
                              }
                            />{' '}
                            {m.name.split(' (')[0]}
                          </label>
                        ))}
                    </div>
                  </td>
                  <td className="pr-3 text-right tabular-nums">{usd(l)}</td>
                  <td className="pr-3 text-right tabular-nums">{usd(marginal)}</td>
                  <td className="pr-3 text-right tabular-nums">{usd(price)}</td>
                  <td className="pr-3 text-right tabular-nums">{usd(price * 12)}</td>
                  <td>
                    <button onClick={() => setTypes(types.filter((x) => x.id !== t.id))} className="text-xs text-red-600 hover:underline">
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <button
          onClick={() => setTypes([...types, { id: Math.max(0, ...types.map((t) => t.id)) + 1, name: 'New user type', count: 10, modules: [] }])}
          className="mt-2 rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
        >
          Add a user type
        </button>
        <p className="mt-3 text-xs text-gray-500">
          Monthly price here is per ACTIVE user, the people who cost you something. If only {Math.round(globals.mauRatio * 100)}% of subscribers are active, one paying subscriber pays for
          the inactive ones too, so a price per registered user is {Math.round(globals.mauRatio * 100)}% of these.
          {totalTypeUsers > 0 && ` (Your type mix: ${types.map((t) => `${t.name.split(' (')[0]} ${t.count}`).join(', ')}.)`}
        </p>
        <p className="mt-1 text-xs text-gray-500">Modules used in type names: {types.flatMap((t) => t.modules).map(moduleName).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'none'}.</p>
      </section>

      {/* Pricing: base fee per org + credits */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">5. What to charge: a base fee per organisation plus credits</h2>
        <p className="mb-3 max-w-3xl text-sm text-gray-600">
          The base fee covers the fixed platform cost spread across your clients. AI and live video are charged by use, because they are the only costs that grow with activity. This
          uses the {short(users)} users above, spread over the number of organisations you enter. Your own costs and the payment fee start at $0 — fill them in when you know them.
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {(
            [
              ['orgs', 'Paying organisations', 1],
              ['baseFeePerOrg', 'Base fee per org / month ($)', 0.01],
              ['aiPricePerCall', 'Price per AI call ($)', 0.001],
              ['videoPricePerMinute', 'Price per video minute ($)', 0.001],
              ['paymentFeePct', 'Payment fee (% of revenue)', 0.1],
            ] as const
          ).map(([k, label, step]) => (
            <label key={k} className="text-sm">
              <span className="block text-gray-600">{label}</span>
              <input
                type="number"
                min={0}
                step={step}
                value={pricing[k]}
                onChange={(e) => setPricing({ ...pricing, [k]: Math.max(0, Number(e.target.value) || 0) })}
                className={`${inputCls} w-full`}
              />
            </label>
          ))}
        </div>

        <h3 className="mt-5 font-semibold">Your own costs (per month)</h3>
        <div className="mt-1 space-y-1">
          {ownCosts.map((c) => (
            <div key={c.id} className="flex items-center gap-2">
              <input value={c.name} onChange={(e) => setOwnCosts(ownCosts.map((x) => (x.id === c.id ? { ...x, name: e.target.value } : x)))} className={`${inputCls} w-72`} />
              <span className="text-sm text-gray-500">$</span>
              <input
                type="number"
                min={0}
                value={c.monthly}
                onChange={(e) => setOwnCosts(ownCosts.map((x) => (x.id === c.id ? { ...x, monthly: Math.max(0, Number(e.target.value) || 0) } : x)))}
                className={`${inputCls} w-28`}
              />
              <button onClick={() => setOwnCosts(ownCosts.filter((x) => x.id !== c.id))} className="text-xs text-red-600 hover:underline">
                remove
              </button>
            </div>
          ))}
          <button
            onClick={() => setOwnCosts([...ownCosts, { id: Math.max(0, ...ownCosts.map((c) => c.id)) + 1, name: 'New cost', monthly: 0 }])}
            className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
          >
            Add a cost
          </button>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <div>
            <h3 className="font-semibold">With the prices you entered</h3>
            <table className="mt-1 w-full text-sm">
              <tbody>
                {(
                  [
                    ['Base fees', result.baseRevenue],
                    ['AI credits', result.aiRevenue],
                    ['Video credits', result.videoRevenue],
                    ['Revenue per month', result.revenue],
                    ['Platform cost (section 2)', -result.platformCost],
                    ['Your own costs', -result.ownCostsTotal],
                    ['Payment fees', -result.paymentFees],
                    ['Profit per month', result.profit],
                  ] as const
                ).map(([label, v]) => (
                  <tr key={label} className={`border-b border-gray-100 ${label.startsWith('Profit') || label.startsWith('Revenue') ? 'font-semibold' : ''}`}>
                    <td className="py-1">{label}</td>
                    <td className={`text-right tabular-nums ${label.startsWith('Profit') ? (v < 0 ? 'text-red-600' : 'text-green-700') : ''}`}>{v < 0 ? '−' + usd(-v) : usd(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-sm text-gray-700">
              Margin: <strong>{result.marginPct === null ? 'no revenue yet' : result.marginPct.toFixed(0) + '%'}</strong> · yearly profit <strong>{usd(result.profit * 12)}</strong>
            </p>
            <p className="mt-1 text-sm text-gray-700">
              Break-even:{' '}
              <strong>
                {result.breakEvenOrgs === null
                  ? 'never at these prices'
                  : result.breakEvenOrgs === 1
                    ? 'already covered by one organisation'
                    : `${result.breakEvenOrgs.toLocaleString('en-US')} organisations`}
              </strong>{' '}
              (at {Math.round(users / Math.max(1, pricing.orgs)).toLocaleString('en-US')} registered users each).
            </p>
          </div>
          <div>
            <h3 className="font-semibold">Prices that earn your {margin}% target margin</h3>
            <table className="mt-1 w-full text-sm">
              <tbody>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Base fee per organisation / month</td>
                  <td className="text-right tabular-nums">{usd(result.suggestedBaseFeePerOrg)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Per AI call</td>
                  <td className="text-right tabular-nums">{usd(result.suggestedAiPricePerCall)}</td>
                </tr>
                <tr className="border-b border-gray-100">
                  <td className="py-1">Per video minute</td>
                  <td className="text-right tabular-nums">{usd(result.suggestedVideoPricePerMinute)}</td>
                </tr>
              </tbody>
            </table>
            <button
              onClick={() =>
                setPricing({
                  ...pricing,
                  baseFeePerOrg: Math.ceil(result.suggestedBaseFeePerOrg * 100) / 100,
                  aiPricePerCall: Math.ceil(result.suggestedAiPricePerCall * 10000) / 10000,
                  videoPricePerMinute: Math.ceil(result.suggestedVideoPricePerMinute * 10000) / 10000,
                })
              }
              className="mt-2 rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
            >
              Use these prices
            </button>
            <p className="mt-2 text-xs text-gray-500">
              The suggested base fee is the whole non-AI, non-video platform cost plus your own costs, divided by organisations. It is a cost floor: what you charge is a market decision, and
              clients will accept more than a floor of a few dollars.
            </p>
          </div>
        </div>
      </section>

      {/* All tiers */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">6. All sizes side by side</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-1 pr-3">Users</th>
                <th className="pr-3 text-right">Monthly</th>
                <th className="pr-3 text-right">Yearly</th>
                <th className="pr-3 text-right">Per registered user / month</th>
                <th>Architecture</th>
              </tr>
            </thead>
            <tbody>
              {allTiers.map(({ n, plan: p }) => (
                <tr key={n} className="border-b border-gray-100">
                  <td className="py-1 pr-3">{short(n)}</td>
                  <td className="pr-3 text-right tabular-nums">{usd(p.monthly)}</td>
                  <td className="pr-3 text-right tabular-nums">{usd(p.yearly)}</td>
                  <td className="pr-3 text-right tabular-nums">{usd(p.monthly / n)}</td>
                  <td>{p.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Price sheet */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">7. Price sheet — every price used; edit one to test &quot;what if it rises?&quot;</h2>
        <p className="mb-2 text-sm text-gray-600">
          A changed price is a what-if kept in this browser only; it does not change the docs. A price not checked for {STALE_DAYS} days is marked stale: re-read the vendor&apos;s page, then
          update the value and date in <code>packages/platform/src/cost-model.ts</code>.
          {Object.keys(overrides).length > 0 && (
            <>
              {' '}
              <strong>{Object.keys(overrides).length} price(s) changed.</strong>{' '}
              <button onClick={() => setOverrides({})} className="text-blue-600 hover:underline">
                Reset all prices
              </button>
            </>
          )}
        </p>
        <p className="mb-2 text-sm text-gray-600">
          <span className={`rounded px-1.5 py-0.5 text-xs ${CONF.verified}`}>verified</span> read from the vendor&apos;s own page on that date ·{' '}
          <span className={`rounded px-1.5 py-0.5 text-xs ${CONF['third-party']}`}>third-party</span> from a comparison site ·{' '}
          <span className={`rounded px-1.5 py-0.5 text-xs ${CONF.assumption}`}>assumption</span> ours or from memory — not re-fetched.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left text-gray-500">
                <th className="py-1 pr-3">Vendor</th>
                <th className="pr-3">Item</th>
                <th className="pr-3 text-right">Price</th>
                <th className="pr-3">Checked</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {(Object.entries(PRICES) as [PriceKey, (typeof PRICES)[PriceKey]][]).map(([key, p]) => (
                <tr key={key} className="border-b border-gray-100 align-top">
                  <td className="py-1 pr-3">{p.vendor}</td>
                  <td className="pr-3">
                    {p.item}
                    {'note' in p && p.note && <span className="block text-gray-500">{p.note}</span>}
                    <span className="block break-all text-gray-400">{p.source}</span>
                  </td>
                  <td className="pr-3 text-right tabular-nums">
                    <input
                      type="number"
                      step="any"
                      value={overrides[key] ?? p.value}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        if (e.target.value === '' || !Number.isFinite(v) || v === p.value) {
                          const { [key]: _drop, ...rest } = overrides
                          void _drop
                          setOverrides(rest)
                        } else setOverrides({ ...overrides, [key]: v })
                      }}
                      className={`${inputCls} w-24 text-right ${key in overrides ? 'border-blue-500 bg-blue-50' : ''}`}
                    />{' '}
                    <span className="text-gray-500">{p.unit}</span>
                    {key in overrides && <span className="block text-gray-400">list: {p.value}</span>}
                  </td>
                  <td className="pr-3">
                    {p.checked}
                    {now !== null && (now - new Date(p.checked).getTime()) / 86_400_000 > STALE_DAYS && <span className="ml-1 rounded bg-red-100 px-1 text-red-700">stale</span>}
                  </td>
                  <td>
                    <span className={`rounded px-1.5 py-0.5 ${CONF[p.confidence]}`}>{p.confidence}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
