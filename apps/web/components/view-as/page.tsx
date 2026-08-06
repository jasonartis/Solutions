import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getModule } from '@platform/core'
import { requireOrgModule } from '@/lib/module-gate'
import { SectionTable } from './section-table'
import { OffSurfaceLists } from './off-surface'
import {
  activeSession,
  heldGrants,
  grantKey,
  mode1Allowed,
  renderSurface,
  scopeNodes,
  sessionStillAuthorised,
  tabsFor,
  targetsFor,
} from '@/lib/view-as'
import { endViewAs, startViewAs } from './actions'

// The view-as page (docs/15 §8). One generic component for every module: the
// tab strip comes from the manifest's declared edges and the rendered content
// comes from the position's declared SURFACE, so a table nobody declared
// literally cannot appear on screen. That is what makes §8.1 point 9's
// "anything unclassified defaults to PERSONAL" structural rather than a rule
// someone has to remember.
//
// Styling follows the house idiom (no component library in this repo): plain
// links styled as pills, Tailwind utilities inline, uppercase tracking-wide
// badges keyed by meaning.

type Props = {
  moduleKey: string
  params: Promise<{ orgSlug: string }>
  searchParams: Promise<{ tab?: string; mode?: string }>
}

export async function ViewAsPage({ moduleKey, params, searchParams }: Props) {
  const { orgSlug } = await params
  const { tab: tabParam, mode: modeParam } = await searchParams
  const { supabase, org } = await requireOrgModule(orgSlug, moduleKey)

  const manifest = getModule(moduleKey)!
  const decl = manifest.viewAs

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) notFound()

  const grants = await heldGrants(supabase, org.id, moduleKey, user.id)
  const tabs = tabsFor(decl, grants)
  const base = `/o/${orgSlug}/m/${moduleKey}`

  if (tabs.length === 0) {
    return (
      <div>
        <p className="mb-1 text-sm text-gray-400">{org.name}</p>
        <h1 className="mb-4 text-2xl font-semibold">View as</h1>
        <p className="text-gray-500">
          None of the positions you hold in {manifest.name} has a declared view-as edge below it.
        </p>
        <Link href={base} className="mt-4 inline-block text-sm text-blue-600 hover:underline">
          Back to {manifest.name}
        </Link>
      </div>
    )
  }

  const active = tabs.find((t) => t.position === tabParam) ?? tabs[0]!
  const nodes = await scopeNodes(supabase, org.id, moduleKey)

  // Mode 2 needs BOTH a live logged session (the cookie) and a still-valid
  // authorisation, re-checked here rather than trusted from session start.
  const session = await activeSession(supabase, org.id, moduleKey)
  const sessionUsable =
    session !== null &&
    session.targetRole === active.position &&
    sessionStillAuthorised(decl, grants, nodes, session)
  const wantMode2 = modeParam === '2' && active.mode2
  const inMode2 = wantMode2 && sessionUsable

  const surface = decl.surfaces[active.position]
  const canMode1 = mode1Allowed(decl, grants, active.position)

  let rendered = null
  let targetName = ''
  if (surface && (inMode2 || canMode1)) {
    // Mode 1 is "as if I held that position", so the subject is the CALLER —
    // not "no subject", which would fill the page with everyone's rows and
    // just reproduce the professor's own ambient view under a Student label.
    // For a professor enrolled nowhere this correctly comes back empty (§8.1
    // point 8: mode 1 renders the caller's own possibly-empty data and creates
    // nothing). Tables whose surface has `subjectColumn: null` are class-wide
    // for that position and stay unfiltered in both modes.
    rendered = await renderSurface(
      supabase,
      decl,
      surface,
      org.id,
      nodes,
      // The in-module path is always the ordinary one: §8.1 point 10's
      // intersection with what the CALLER governs. The Owner Console's
      // edge-bypassing authority is deliberately not reachable from here.
      { kind: 'module-grants', grants },
      inMode2 ? session!.targetScopeRef : null,
      inMode2 ? session!.targetUserId : user.id,
    )
    if (inMode2) {
      const { data: p } = await supabase
        .from('profiles')
        .select('display_name')
        .eq('user_id', session!.targetUserId)
        .maybeSingle()
      targetName = (p?.display_name as string | null) || 'that member'
    }
  }

  const targets =
    !inMode2 && active.mode2
      ? await targetsFor(supabase, decl, org.id, moduleKey, user.id, grants, active.position, nodes)
      : []

  return (
    <div>
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-4 flex items-baseline gap-4">
        <h1 className="text-2xl font-semibold">View as</h1>
        <Link href={base} className="text-sm text-blue-600 hover:underline">
          Back to {manifest.name}
        </Link>
      </div>

      <p className="mb-4 max-w-3xl text-sm text-gray-600">
        Each tab is a position below one you hold. It shows that position&rsquo;s data surface — never
        more than your own permissions already return, and never a person&rsquo;s private layer.
      </p>

      <ul className="mb-6 flex flex-wrap gap-2">
        {tabs.map((t) => {
          const on = t.position === active.position
          return (
            <li key={t.position}>
              <Link
                href={`${base}/view-as?tab=${encodeURIComponent(t.position)}&mode=1`}
                className={
                  on
                    ? 'inline-flex items-center gap-1.5 rounded border border-blue-300 bg-blue-100 px-4 py-2 text-sm font-medium text-blue-800'
                    : 'inline-flex items-center gap-1.5 rounded border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50'
                }
              >
                {t.label}
                {t.mode2 && (
                  <span className="rounded bg-white/70 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                    person view
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>

      {inMode2 && (
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <div className="text-sm text-amber-900">
            <span className="mr-2 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-900">
              read-only
            </span>
            Viewing as <strong>{targetName}</strong> in the {active.label.toLowerCase()} capacity.
            This session is recorded. You cannot act on their behalf.
          </div>
          <form action={endViewAs.bind(null, orgSlug, moduleKey, active.position)}>
            <button className="rounded bg-amber-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-900">
              Stop viewing as
            </button>
          </form>
        </div>
      )}

      {!inMode2 && (
        <div className="mb-6 rounded-lg border border-gray-200 bg-gray-50 p-4">
          <p className="mb-1 text-sm font-medium text-gray-700">
            {active.label} — as you would hold it
          </p>
          <p className="mb-3 text-xs text-gray-500">{active.summary}</p>
          {wantMode2 && !sessionUsable && (
            <p className="mb-3 rounded bg-amber-50 p-2 text-xs text-amber-800">
              That view-as session is over or no longer permitted. Pick someone again to start a new one.
            </p>
          )}
          {active.mode2 && targets.length > 0 && (
            <form
              action={startViewAs.bind(null, orgSlug, moduleKey)}
              className="flex flex-wrap items-center gap-2"
            >
              <label htmlFor="grant" className="text-sm text-gray-600">
                Or view as a specific person:
              </label>
              <select
                id="grant"
                name="grant"
                className="rounded border border-gray-300 px-2 py-1 text-sm"
                defaultValue=""
              >
                <option value="" disabled>
                  Choose…
                </option>
                {targets.map((t) => (
                  <option key={grantKey(t)} value={grantKey(t)}>
                    {t.displayName} — {t.role} ({t.scopeLabel})
                  </option>
                ))}
              </select>
              <button className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
                View as
              </button>
            </form>
          )}
          {active.mode2 && targets.length === 0 && (
            <p className="text-xs text-gray-500">
              Nobody holds a {active.label.toLowerCase()} grant you both outrank and cover.
            </p>
          )}
          {!active.mode2 && (
            <p className="text-xs text-gray-500">
              Viewing a specific person in this capacity is not enabled for this module.
            </p>
          )}
        </div>
      )}

      {rendered?.partial && (
        <p className="mb-4 rounded bg-blue-50 p-2 text-xs text-blue-800">
          Partial view — limited to the part of this grant&rsquo;s scope you govern ({rendered.scopeNote}).
        </p>
      )}

      {/* The scope resolver's two honest failure states. Both used to render as
          an ordinary empty page, which is the one thing a view-as tab must not
          do: every scoped section below comes back "Nothing here" and looks like
          a finding about the target's permissions. */}
      {rendered?.scopeError && (
        <p className="mb-4 rounded bg-red-50 p-2 text-xs text-red-700">
          Could not read {rendered.entityTable} ({rendered.scopeError}), so the sections below are
          empty for a reason that has nothing to do with this position. Treat this as a bug, not a
          result.
        </p>
      )}
      {rendered?.blinded && !rendered.scopeError && (
        <p className="mb-4 rounded bg-amber-50 p-2 text-xs text-amber-800">
          No {rendered.entityTable} rows resolved, although this module does have scope nodes here —
          so every scoped section below is empty either because there is genuinely nothing, or
          because your own permissions cannot read {rendered.entityTable}. This page cannot tell
          which, and says so rather than showing you a confident blank.
        </p>
      )}

      {!surface && (
        <p className="text-gray-500">This position has no declared surface, so there is nothing to render.</p>
      )}

      {rendered?.sections.map((s) => <SectionTable key={s.table} section={s} />)}

      {surface && <OffSurfaceLists surface={surface} />}

    </div>
  )
}
