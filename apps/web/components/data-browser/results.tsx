'use client'

import { useMemo, useState } from 'react'
import { formatCell } from '@/lib/format-cell'
import type { BrowsedResult, BrowsedSection } from '@/lib/data-browser'

// The data browser's result renderer.
//
// A client component because the founder's requirement is that a large answer
// stay findable: search across every table at once, hide columns you don't care
// about, collapse what you're not looking at. None of that is expressible in a
// server render, and all of it is presentation over data already fetched — no
// query re-runs, so filtering here can never reach anything RLS didn't already
// return.
//
// Everything defaults to SHOWING more rather than less, because the question
// this screen answers is "what do you hold about me?" and a filtered-by-default
// view would quietly answer a narrower one. The single exception is empty
// tables, which are hidden by default and counted in the header so their
// absence is visible rather than silent.

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

function matchesSearch(row: Record<string, unknown>, needle: string): boolean {
  if (!needle) return true
  const lower = needle.toLowerCase()
  for (const value of Object.values(row)) {
    if (formatCell(value).toLowerCase().includes(lower)) return true
  }
  return false
}

function SectionCard({
  section,
  search,
  subjectId,
}: {
  section: BrowsedSection
  search: string
  subjectId: string
}) {
  const [collapsed, setCollapsed] = useState(false)
  const [hiddenColumns, setHiddenColumns] = useState<string[]>([])

  const rows = useMemo(
    () => section.rows.filter((r) => matchesSearch(r, search)),
    [section.rows, search],
  )
  const shown = section.columns.filter((c) => !hiddenColumns.includes(c))

  // Search deliberately scans EVERY column, including hidden ones — narrowing
  // it to visible columns could drop a matching row, and losing rows is the one
  // thing this tool must not do. The cost is a row that appears with no visible
  // cell containing the search term, which looks like a bug. Counting those and
  // saying so keeps the behaviour honest instead of merely correct.
  const matchedOnlyHidden = useMemo(() => {
    if (!search || hiddenColumns.length === 0) return 0
    return rows.filter((r) => {
      const visibleOnly: Record<string, unknown> = {}
      for (const c of shown) visibleOnly[c] = r[c]
      return !matchesSearch(visibleOnly, search)
    }).length
  }, [rows, search, hiddenColumns, shown])

  const toggleColumn = (c: string) =>
    setHiddenColumns((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]))

  return (
    <section className="mb-4 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-sm font-medium text-gray-700 hover:underline"
            aria-expanded={!collapsed}
          >
            {collapsed ? '▸' : '▾'} {section.label}
          </button>
          <span className="font-mono text-[10px] text-gray-400">{section.table}</span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold text-gray-600">
            {rows.length}
            {search && rows.length !== section.rows.length ? ` of ${section.rows.length}` : ''}
          </span>
          {section.truncated && (
            <span
              className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700"
              title="The row cap was reached — this is a prefix of the real answer, not all of it."
            >
              truncated
            </span>
          )}
        </div>
        {!collapsed && section.columns.length > 0 && (
          <details className="text-xs text-gray-500">
            <summary className="cursor-pointer select-none">
              columns ({shown.length}/{section.columns.length})
            </summary>
            <div className="mt-1 flex max-w-lg flex-wrap gap-x-3 gap-y-1 rounded border border-gray-200 bg-gray-50 p-2">
              {section.columns.map((c) => (
                <label key={c} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={!hiddenColumns.includes(c)}
                    onChange={() => toggleColumn(c)}
                  />
                  <span className="font-mono text-[10px]">{c}</span>
                </label>
              ))}
            </div>
          </details>
        )}
      </div>

      {section.note && !collapsed && (
        <p className="mt-2 text-xs italic text-gray-500">{section.note}</p>
      )}

      {!collapsed && matchedOnlyHidden > 0 && (
        <p className="mt-2 rounded bg-blue-50 p-2 text-xs text-blue-800">
          {matchedOnlyHidden} row{matchedOnlyHidden === 1 ? '' : 's'} here match your search only in
          a column you have hidden. Nothing is being dropped — re-show the columns to see why.
        </p>
      )}

      {section.error && (
        <p className="mt-2 rounded bg-red-50 p-2 text-xs text-red-700">
          Could not read this table: {section.error}. That is RLS refusing the read, which is the
          honest answer — nothing here bypasses it.
        </p>
      )}

      {!collapsed && !section.error && rows.length === 0 && (
        <p className="mt-2 text-sm text-gray-400">
          {section.rows.length === 0 ? 'No rows here.' : 'No rows match the search.'}
        </p>
      )}

      {!collapsed && rows.length > 0 && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-gray-400">
                {shown.map((c) => (
                  <th key={c} className="py-1 pr-3 font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  {shown.map((c) => (
                    <td
                      key={c}
                      className={
                        // Highlight the cell that made this row match the
                        // subject, so it's obvious WHY a row is here — several
                        // tables name a person in three or four columns.
                        row[c] === subjectId
                          ? 'py-1 pr-3 font-medium text-blue-700'
                          : 'py-1 pr-3 text-gray-700'
                      }
                    >
                      {formatCell(row[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

export default function DataBrowserResults({
  result,
  subjectId,
}: {
  result: BrowsedResult
  subjectId: string
}) {
  const [search, setSearch] = useState('')
  const [showEmpty, setShowEmpty] = useState(false)
  const [source, setSource] = useState('all')

  const bySource = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of result.sections) {
      counts.set(s.source, (counts.get(s.source) ?? 0) + s.rows.length)
    }
    return counts
  }, [result.sections])

  const visible = useMemo(() => {
    return result.sections.filter((s) => {
      if (source !== 'all' && s.source !== source) return false
      const matching = search ? s.rows.filter((r) => matchesSearch(r, search)).length : s.rows.length
      if (!showEmpty && matching === 0 && !s.error) return false
      return true
    })
  }, [result.sections, search, showEmpty, source])

  const totalRows = result.sections.reduce((n, s) => n + s.rows.length, 0)
  const hiddenCount = result.sections.length - visible.length

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search every table…"
          className={`${inputCls} w-64`}
        />
        <select value={source} onChange={(e) => setSource(e.target.value)} className={inputCls}>
          <option value="all">All sources</option>
          {result.sources.map((s) => (
            <option key={s} value={s}>
              {s} ({bySource.get(s) ?? 0})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-xs text-gray-600">
          <input
            type="checkbox"
            checked={showEmpty}
            onChange={(e) => setShowEmpty(e.target.checked)}
          />
          show empty tables
        </label>
        <span className="ml-auto text-xs text-gray-500">
          {totalRows} row{totalRows === 1 ? '' : 's'} across {result.sections.length} table
          {result.sections.length === 1 ? '' : 's'}
          {hiddenCount > 0 && ` · ${hiddenCount} hidden`}
        </span>
      </div>

      {visible.length === 0 && (
        <p className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-500">
          {result.sections.length === 0
            ? 'Nothing anywhere references this person in this org.'
            : 'Nothing matches the current search or filters.'}
        </p>
      )}

      {visible.map((s) => (
        <SectionCard key={`${s.source}:${s.table}`} section={s} search={search} subjectId={subjectId} />
      ))}

      {result.unreadable.length > 0 && (
        <section className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h3 className="text-sm font-medium text-amber-900">
            May hold data about this person, readable by nobody
          </h3>
          <p className="mt-1 text-xs text-amber-800">
            These tables can hold rows about this person, and no viewer can read them — not staff,
            not an org owner, not you. They are listed rather than left out, because
            &ldquo;nothing here&rdquo; and &ldquo;something here that nobody may read&rdquo; are
            different answers.
          </p>
          <ul className="mt-2 space-y-2">
            {result.unreadable.map((u) => (
              <li key={u.table} className="text-xs text-amber-900">
                <span className="font-mono font-semibold">{u.table}</span>{' '}
                <span className="text-amber-700">({u.source})</span>
                <p className="mt-0.5 text-amber-800">{u.why}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
