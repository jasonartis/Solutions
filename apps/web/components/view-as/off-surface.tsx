import type { PositionSurface } from '@platform/core'

// The three off-surface lists, shared by the in-module view-as tabs and the
// Owner Console (extracted 2026-08-06 alongside SectionTable).
//
// ALL THREE ARE RENDERED, NOT TWO (docs/03 #18). `unreadableByPosition` was
// declared and test-enforced from slice 5 but invisible on screen until
// 2026-08-04, which hid the single most useful sentence on nail-salon's cashier
// tab ("a cashier cannot read the earnings ledger"). The badges keep the three
// claims apart on screen exactly as the declaration keeps them apart in code,
// because they are claims about three different readers.

export function hasOffSurface(surface: PositionSurface): boolean {
  return (
    surface.personal.length > 0 ||
    surface.excluded.length > 0 ||
    (surface.unreadableByPosition?.length ?? 0) > 0
  )
}

export function OffSurfaceLists({ surface }: { surface: PositionSurface }) {
  if (!hasOffSurface(surface)) return null

  return (
    <details className="mt-6 rounded-lg border border-gray-200 bg-white p-4 text-sm">
      <summary className="cursor-pointer font-medium text-gray-700">
        What this view deliberately leaves out
      </summary>
      <p className="mt-3 text-xs text-gray-500">
        Three different claims, deliberately not merged: <strong>personal</strong> — you cannot
        read it either; <strong>excluded</strong> — you can read it and this tab declines to
        render it; <strong>not readable by this position</strong> — the position itself has no
        read path, so the absence describes their permissions, not this page.
      </p>
      <p className="mt-2 text-xs text-gray-400">
        An empty <span className="font-mono">excluded</span> list means no WHOLE table is withheld
        — not that nothing is. Column-level decisions live in each section&rsquo;s allow-list and are
        named in its caveat (2026-08-05).
      </p>
      <ul className="mt-3 space-y-2 text-xs text-gray-600">
        {surface.personal.map((p) => (
          <li key={p.table}>
            <span className="mr-2 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-purple-700">
              personal
            </span>
            <span className="font-mono">{p.table}</span> — {p.why}
          </li>
        ))}
        {surface.excluded.map((e) => (
          <li key={e.table}>
            <span className="mr-2 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-600">
              excluded
            </span>
            <span className="font-mono">{e.table}</span> — {e.why}
          </li>
        ))}
        {(surface.unreadableByPosition ?? []).map((u) => (
          <li key={u.table}>
            <span className="mr-2 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700">
              not readable by this position
            </span>
            <span className="font-mono">{u.table}</span> — {u.why}
          </li>
        ))}
      </ul>
    </details>
  )
}
