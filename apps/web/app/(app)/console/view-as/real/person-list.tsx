'use client'

import { useState } from 'react'

export type Person = { id: string; name: string; email: string | null; orgs: string[] }

// A searchable list of every person on the platform, each with a "View as" button.
// Plain form POST to /view-as/start (a full page load, so the first screen is the person's).
export function PersonList({ people, disabled }: { people: Person[]; disabled: boolean }) {
  const [q, setQ] = useState('')
  const needle = q.trim().toLowerCase()
  const shown = needle
    ? people.filter((p) => [p.name, p.email ?? '', ...p.orgs].some((s) => s.toLowerCase().includes(needle)))
    : people
  return (
    <div>
      <label className="sr-only" htmlFor="view-as-search">
        Search people
      </label>
      <input
        id="view-as-search"
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by name, email or organization"
        className="mb-3 w-full rounded border border-gray-300 px-3 py-2 text-sm"
        data-testid="view-as-search"
      />
      {shown.length === 0 && <p className="text-sm text-gray-500">No one matches.</p>}
      <ul className="space-y-2">
        {shown.map((p) => (
          <li key={p.id} data-testid="view-as-person">
            <form
              action="/view-as/start"
              method="post"
              className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-white p-3"
            >
              <input type="hidden" name="target" value={p.id} />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-gray-900">{p.name}</div>
                <div className="truncate text-xs text-gray-500">
                  {p.orgs.length ? p.orgs.join(', ') : 'No organization'}
                  {p.email ? ` · ${p.email}` : ''}
                </div>
              </div>
              <button
                type="submit"
                disabled={disabled}
                className="rounded bg-gray-900 px-3 py-1 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
              >
                View as
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  )
}
