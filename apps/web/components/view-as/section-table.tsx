import { formatCell } from '@/lib/format-cell'
import type { RenderedSection } from '@/lib/view-as'

// One rendered surface section, shared by the in-module view-as tabs and the
// Owner Console's edge-bypassing surface (docs/13). Extracted 2026-08-06 for the
// same reason `formatCell` was: these two screens sit next to each other in the
// operator's head, and a section that rendered two different ways on them —
// especially one that badged its narrowing on one page and not the other — would
// be worse than either alone.

export function SectionTable({ section }: { section: RenderedSection }) {
  const embedKeys = section.rows.length
    ? Object.keys(section.rows[0]!.values).filter((k) => !section.columns.includes(k))
    : []
  const headers = [...section.columns, ...embedKeys]

  return (
    <section className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium uppercase tracking-wide text-gray-500">{section.label}</h3>
        <div className="flex items-baseline gap-2">
          {/* THE BADGE THAT MATTERS. `not-narrowed` means this table names a
              person and was deliberately left unfiltered, so it holds every
              holder's rows — more than any one of them sees. Only the Owner
              Console's no-person-filter mode produces it. Saying so per section
              is the point: the mode-level banner tells you the mode, but only
              the section knows whether the mode actually changed anything, and
              docs/03 #18's worst failure is a section that shows rows the
              subject cannot see while looking like a person view. */}
          {section.personFilter === 'not-narrowed' && (
            <span className="rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-orange-800">
              all holders — not one person
            </span>
          )}
          <span className="font-mono text-[10px] text-gray-400">{section.table}</span>
        </div>
      </div>
      {section.caveat && <p className="mb-2 text-xs italic text-gray-500">{section.caveat}</p>}
      {section.error && (
        <p className="mb-2 rounded bg-red-50 p-2 text-xs text-red-700">
          This table could not be read: {section.error}. Under the keystone rule that is a gap in
          the ladder&rsquo;s RLS or a wrong surface declaration — never something view-as should bridge.
        </p>
      )}
      {section.rows.length === 0 && !section.error && (
        <p className="text-sm text-gray-400">Nothing here.</p>
      )}
      {section.rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-gray-400">
                {headers.map((c) => (
                  <th key={c} className="py-1 pr-3 font-medium">
                    {c}
                  </th>
                ))}
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, i) => (
                <tr key={i} className="border-b border-gray-100 last:border-0">
                  {headers.map((c) => (
                    <td key={c} className="py-1 pr-3 text-gray-700">
                      {formatCell(row.values[c])}
                    </td>
                  ))}
                  <td className="py-1">
                    {row.windowState === 'not-yet' && (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
                        not visible yet
                      </span>
                    )}
                    {row.windowState === 'expired' && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                        window closed
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
