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
  personaCost,
  planFor,
  priceForMargin,
  type Confidence,
  type Globals,
  type ModuleAssumption,
} from '@platform/core'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const STORE = 'costs-calculator.v1'

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

export default function CostsCalculator() {
  const [users, setUsers] = useState(100_000)
  const [globals, setGlobals] = useState<Globals>(DEFAULT_GLOBALS)
  const [modules, setModules] = useState<ModuleAssumption[]>(DEFAULT_MODULES)
  const [types, setTypes] = useState<UserType[]>(DEFAULT_TYPES)
  const [margin, setMargin] = useState(60)
  const [loaded, setLoaded] = useState(false)

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
        JSON.stringify({ users, globals, margin, types, modules: Object.fromEntries(modules.map((m) => [m.key, m.adoption])) }),
      )
    } catch {
      /* ignore */
    }
  }, [loaded, users, globals, modules, types, margin])

  const plan = useMemo(() => planFor(users, modules, globals), [users, modules, globals])
  const costs = useMemo(() => allocate(users, modules, globals, plan), [users, modules, globals, plan])
  const allTiers = useMemo(() => TIERS.map((n) => ({ n, plan: planFor(n, modules, globals) })), [modules, globals])
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

      {/* All tiers */}
      <section className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-1 text-lg font-semibold">5. All sizes side by side</h2>
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
        <h2 className="mb-1 text-lg font-semibold">6. Price sheet (every price used, with the date checked)</h2>
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
              {Object.values(PRICES).map((p) => (
                <tr key={p.vendor + p.item} className="border-b border-gray-100 align-top">
                  <td className="py-1 pr-3">{p.vendor}</td>
                  <td className="pr-3">
                    {p.item}
                    {'note' in p && p.note && <span className="block text-gray-500">{p.note}</span>}
                    <span className="block break-all text-gray-400">{p.source}</span>
                  </td>
                  <td className="pr-3 text-right tabular-nums">
                    {p.value} <span className="text-gray-500">{p.unit}</span>
                  </td>
                  <td className="pr-3">{p.checked}</td>
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
