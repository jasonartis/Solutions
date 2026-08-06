import Link from 'next/link'
import { getModule, moduleRegistry } from '@platform/core'
import { requireSuperadmin } from '@/lib/platform'
import { browsableModuleKeys } from '@/lib/data-browser'
import { renderSurface, scopeNodes, type ScopeNode } from '@/lib/view-as'
import {
  consolePositions,
  declaredPairs,
  holdersOf,
  planConsoleRender,
  type ConsoleMode,
} from '@/lib/console-view-as'
import { SectionTable } from '@/components/view-as/section-table'
import { OffSurfaceLists } from '@/components/view-as/off-surface'

// The Owner Console view-as. Design, what it bypasses, and the dated UNLOGGED
// decision all live in lib/console-view-as.ts's header — read that first; this
// file is the screen.
//
// Everything below is a GET form: org, module, position, mode, person, scope are
// all in the URL. That is not a security boundary and does not need to be (the
// gate is a UI gate over the caller's own RLS client — see the lib header), and
// it makes any view the founder is looking at a link he can paste into a note
// about why something behaved the way it did. Debuggability is the stated
// primary requirement for this pair of tools.

type Props = {
  searchParams: Promise<{
    org?: string
    module?: string
    position?: string
    mode?: string
    person?: string
    scope?: string
  }>
}

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

const MODES: { value: ConsoleMode; label: string; blurb: string }[] = [
  {
    value: 1,
    label: 'As if I held it',
    blurb: 'The position’s page shape filled with MY own rows. Usually empty — a superadmin holds no module seats — which is the truthful answer, not a bug.',
  },
  {
    value: 2,
    label: 'What one named person sees',
    blurb: 'Rows ABOUT one holder of this position. Offered only where the surface can express it.',
  },
  {
    value: 3,
    label: 'The whole position surface',
    blurb: 'No person filter: every row this position reads in the chosen scope. Shows MORE than any one holder sees — that is the point, and affected sections say so.',
  },
]

export default async function ConsoleViewAsPage({ searchParams }: Props) {
  const { supabase, userId } = await requireSuperadmin()
  const sp = await searchParams
  const mode: ConsoleMode = sp.mode === '2' ? 2 : sp.mode === '3' ? 3 : 1

  // Every org — a superadmin picks any of them (docs/13 answer 4). An ordinary
  // read: `orgs_select_member` carries an `is_superadmin()` arm.
  const { data: orgs } = await supabase.from('orgs').select('id, name, slug').order('name')
  const orgList = orgs ?? []
  const org = orgList.find((o) => o.id === sp.org) ?? null

  // Modules the org has EVER had, not `enabled = true` — the data browser's rule
  // (docs/03 #19), for the same reason: disabling a module must not hide the very
  // history someone opens this tool to inspect.
  const orgModuleKeys = org ? await browsableModuleKeys(supabase, org.id) : []
  const modules = moduleRegistry.filter((m) => orgModuleKeys.includes(m.key))
  const manifest = modules.find((m) => m.key === sp.module) ? getModule(sp.module!) : null
  const decl = manifest?.viewAs ?? null

  const positions = decl ? consolePositions(decl) : []
  const chosen = positions.find((p) => p.position === sp.position) ?? null

  const nodes =
    org && manifest ? await scopeNodes(supabase, org.id, manifest.key) : new Map<string, ScopeNode>()
  const nodeList = Array.from(nodes.values()).sort((a, b) => a.path.localeCompare(b.path))

  // The bypass picker, only where a person is being asked for.
  const holders =
    org && manifest && chosen && mode === 2 && chosen.personFilterable
      ? await holdersOf(supabase, org.id, manifest.key, chosen.position, nodes)
      : []
  const holder = sp.person ? holders.find((h) => h.key === sp.person) ?? null : null

  const plan =
    decl && chosen
      ? planConsoleRender({
          decl,
          position: chosen.position,
          mode,
          superadminId: userId,
          holder,
          personWasRequested: Boolean(sp.person),
          scopeChoice: sp.scope ?? null,
          nodes,
        })
      : null

  const pairs = decl ? declaredPairs(decl) : []

  const surface = decl && chosen?.hasSurface ? decl.surfaces[chosen.position] : undefined
  const rendered =
    org && decl && surface && plan?.ok
      ? await renderSurface(
          supabase,
          decl,
          surface,
          org.id,
          nodes,
          // THE BYPASS, named. See RenderAuthority in lib/view-as.ts: this skips
          // the declared edge, the rank/coverage conditions and §8.1 point 10's
          // caller-scope intersection — and nothing else. Not RLS, not the
          // surface declaration.
          { kind: 'platform-superadmin' },
          plan.scopeRef,
          plan.subjectUserId,
        )
      : null

  const qs = (over: Record<string, string | undefined>) => {
    const params = new URLSearchParams()
    const merged = {
      org: org?.id,
      module: manifest?.key,
      position: chosen?.position,
      mode: String(mode),
      person: sp.person,
      scope: sp.scope,
      ...over,
    }
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v)
    return `/console/view-as?${params.toString()}`
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-1 flex items-baseline gap-3">
        <h1 className="text-xl font-semibold">View as anything</h1>
        <Link href="/console" className="text-sm text-blue-600 hover:underline">
          ← Owner Console
        </Link>
      </div>

      {/* Stated on screen, not only in the code. The operator must always know
          which of the two console tools they are in, and which rules this one is
          standing outside of. */}
      <p className="mb-2 max-w-3xl text-sm text-gray-600">
        <strong>What this position or person sees</strong> — the module&rsquo;s own declared surface,
        rendered for any position in any org, ignoring the manifest&rsquo;s view-as edges. This is{' '}
        <em>not</em> the{' '}
        <Link href="/console/data-browser" className="text-blue-600 hover:underline">
          data browser
        </Link>
        , which answers the opposite question — what the platform holds <em>about</em> a person.
      </p>
      <p className="mb-6 flex flex-wrap gap-2 text-[11px]">
        <span className="rounded bg-red-100 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-red-800">
          bypasses declared edges
        </span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-gray-600">
          not logged
        </span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-gray-600">
          read-only
        </span>
        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-semibold uppercase tracking-wide text-gray-600">
          bounded by your own RLS, never more
        </span>
      </p>

      <form method="get" className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <label className="flex flex-col gap-1 text-xs text-gray-600">
          Organisation
          <select name="org" defaultValue={org?.id ?? ''} className={inputCls}>
            <option value="">— pick an org —</option>
            {orgList.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>

        {org && (
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Module
            <select name="module" defaultValue={manifest?.key ?? ''} className={inputCls}>
              <option value="">— pick a module —</option>
              {modules.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {org && decl && (
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Position
            <select name="position" defaultValue={chosen?.position ?? ''} className={inputCls}>
              <option value="">— pick a position —</option>
              {positions.map((p) => (
                <option key={p.position} value={p.position}>
                  {p.label} (rank {p.rank}){p.hasSurface ? '' : ' — no surface, renders blank'}
                </option>
              ))}
            </select>
          </label>
        )}

        {chosen && (
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Mode
            <select name="mode" defaultValue={String(mode)} className={inputCls}>
              {MODES.map((m) => (
                <option
                  key={m.value}
                  value={String(m.value)}
                  disabled={m.value === 2 && !chosen.personFilterable}
                >
                  {m.label}
                  {m.value === 2 && !chosen.personFilterable ? ' — not expressible here' : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {chosen && mode === 2 && chosen.personFilterable && (
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Person
            <select name="person" defaultValue={sp.person ?? ''} className={inputCls}>
              <option value="">— pick a holder —</option>
              {holders.map((h) => (
                <option key={h.key} value={h.key}>
                  {h.displayName} ({h.scopeLabel})
                </option>
              ))}
            </select>
          </label>
        )}

        {chosen && nodeList.length > 0 && (
          <label className="flex flex-col gap-1 text-xs text-gray-600">
            Scope
            <select name="scope" defaultValue={sp.scope ?? ''} className={inputCls}>
              <option value="">{mode === 2 ? '— this grant’s own scope —' : '— whole module —'}</option>
              <option value="all">whole module</option>
              {nodeList.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <button
          type="submit"
          className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
        >
          Render
        </button>
      </form>

      {/* The mode explanation is shown for the CHOSEN mode rather than hidden in a
          tooltip: the founder's requirement for this surface was that the choice
          between the three be obvious in the UI. */}
      {chosen && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="mb-2 flex flex-wrap gap-2">
            {MODES.map((m) => {
              const on = m.value === mode
              const off = m.value === 2 && !chosen.personFilterable
              return off ? (
                <span
                  key={m.value}
                  className="cursor-not-allowed rounded border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-300"
                  title="This surface has no per-person table, so a person view cannot be expressed"
                >
                  {m.label}
                </span>
              ) : (
                <Link
                  key={m.value}
                  href={qs({ mode: String(m.value), person: m.value === 2 ? sp.person : undefined })}
                  className={
                    on
                      ? 'rounded border border-blue-300 bg-blue-100 px-3 py-1.5 text-sm font-medium text-blue-800'
                      : 'rounded border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50'
                  }
                >
                  {m.label}
                </Link>
              )
            })}
          </div>
          <p className="text-xs text-gray-600">{MODES.find((m) => m.value === mode)!.blurb}</p>
          {chosen.summary && <p className="mt-2 text-xs italic text-gray-500">{chosen.summary}</p>}
        </div>
      )}

      {plan && !plan.ok && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p>{plan.refusal}</p>
          {plan.hint && <p className="mt-2 text-xs text-amber-800">{plan.hint}</p>}
        </div>
      )}

      {plan?.ok && plan.holder && (
        <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
          Rendering <strong>{plan.holder.displayName}</strong> as {chosen!.label.toLowerCase()} —
          grant scope <span className="font-medium">{plan.holder.scopeLabel}</span>.
          {plan.scopeOverridden && (
            <span className="ml-1 text-blue-800">
              You have moved this render off that grant&rsquo;s own scope, so it is no longer
              &ldquo;what they see&rdquo; — it is this position&rsquo;s surface in the scope you picked.
            </span>
          )}
        </div>
      )}

      {rendered?.scopeError && (
        <p className="mb-4 rounded bg-red-50 p-2 text-xs text-red-700">
          Could not read {rendered.entityTable} ({rendered.scopeError}), so every scoped section
          below is empty for a reason that has nothing to do with this position. Treat this as a bug,
          not a result.
        </p>
      )}
      {rendered?.blinded && !rendered.scopeError && (
        <p className="mb-4 rounded bg-amber-50 p-2 text-xs text-amber-800">
          No {rendered.entityTable} rows resolved, although this module does have scope nodes in
          this org — so every scoped section below is empty either because there is genuinely
          nothing, or because <strong>your own</strong> permissions cannot read{' '}
          {rendered.entityTable}. This page cannot tell which, and says so rather than showing you a
          confident blank.
        </p>
      )}

      {rendered && (
        <p className="mb-4 text-xs text-gray-500">
          Scope: {rendered.scopeNote || 'whole module'}
        </p>
      )}

      {rendered?.sections.map((s) => <SectionTable key={s.table} section={s} />)}
      {surface && rendered && <OffSurfaceLists surface={surface} />}

      {/* docs/13's read-only positions / ranks / pair-grid viewer, folded in
          where it earns its keep: these decisions are real, reviewed and tested
          but otherwise buried in a TypeScript file, and this is the screen where
          someone is about to step over one of them. */}
      {decl && (
        <details className="mt-8 rounded-lg border border-gray-200 bg-white p-4 text-sm">
          <summary className="cursor-pointer font-medium text-gray-700">
            The declared rules for {manifest!.name} — positions, ranks and the pair grid
          </summary>
          <p className="mt-3 text-xs text-gray-500">
            Read-only. Turning an edge ON is deliberately not a switch: the completeness check&rsquo;s
            value is that flipping one drags the decision through a diff, a reviewer and a test run
            (docs/13). This page bypasses these rules for the operator; it does not change them.
          </p>

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500">Positions</h3>
          <ul className="mt-2 space-y-1 text-xs text-gray-600">
            {positions.map((p) => (
              <li key={p.position}>
                <span className="font-mono">{p.position}</span> — rank {p.rank} ·{' '}
                {p.hasSurface ? (
                  <>
                    surface declared ·{' '}
                    {p.personFilterable ? 'has per-person tables' : 'no per-person table (scope-narrowed)'}
                  </>
                ) : (
                  <span className="text-gray-400">no surface — renders blank here</span>
                )}
              </li>
            ))}
          </ul>

          <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-gray-500">
            Rank-differential pairs
          </h3>
          <p className="mt-1 text-xs text-gray-400">
            Every ordered pair with a rank gap must carry an explicit entry or the build fails
            (docs/15 §8.1 point 11). Equal-rank pairs need none and get their exclusion for free.
          </p>
          <div className="mt-2 space-y-3">
            {pairs.map((p) => (
              <div key={`${p.from}->${p.to}`} className="rounded border border-gray-100 bg-gray-50 p-2">
                <div className="flex flex-wrap items-baseline gap-2 text-xs">
                  <span className="font-mono text-gray-700">
                    {p.from} → {p.to}
                  </span>
                  <span
                    className={
                      p.mode1
                        ? 'rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700'
                        : 'rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500'
                    }
                  >
                    mode 1 {p.mode1 ? 'on' : 'off'}
                  </span>
                  <span
                    className={
                      p.mode2
                        ? 'rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-700'
                        : 'rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500'
                    }
                  >
                    mode 2 {p.mode2 ? 'on' : 'off'}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-gray-600">{p.note}</p>
              </div>
            ))}
            {pairs.length === 0 && (
              <p className="text-xs text-gray-400">
                No rank-differential pairs — this module&rsquo;s vocabulary is entirely rank 0, so it
                implies no view-as decisions at all.
              </p>
            )}
          </div>
        </details>
      )}
    </main>
  )
}
