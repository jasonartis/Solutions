'use client'

import { useState, useTransition } from 'react'
import type { ActionResult } from '@/lib/org-members'

// The Owner Console's "which modules does this organization have" control.
// Founder, 2026-11-10: a click must not switch a module on or off by itself.
//
//   green  = ON,  saved        grey = OFF, saved
//   amber  = you flipped it and have NOT applied it — nothing has happened yet
//
// Click a module to stage a change (click again, or Undo, to put it back to what
// is saved). One Update applies every staged change together.
export default function OrgModuleToggles(props: {
  orgName: string
  modules: { key: string; name: string; enabled: boolean }[]
  action: (changes: { moduleKey: string; enable: boolean }[]) => Promise<ActionResult>
}) {
  // Modules whose WANTED state differs from the saved one: key -> wanted.
  const [staged, setStaged] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const saved = new Map(props.modules.map((m) => [m.key, m.enabled]))
  const changes = props.modules.filter((m) => m.key in staged)

  function flip(key: string) {
    setError(null)
    setStaged((cur) => {
      const next = { ...cur }
      const wanted = !(key in cur ? cur[key]! : saved.get(key) === true)
      if (wanted === (saved.get(key) === true)) delete next[key]
      else next[key] = wanted
      return next
    })
  }

  function apply() {
    start(async () => {
      const result = await props.action(changes.map((m) => ({ moduleKey: m.key, enable: staged[m.key]! })))
      if (result.ok) {
        setStaged({})
        setError(null)
      } else {
        setError(result.reason)
      }
    })
  }

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-2">
        {props.modules.map((m) => {
          const isStaged = m.key in staged
          const wanted = isStaged ? staged[m.key]! : m.enabled
          return (
            <li key={m.key}>
              <button
                type="button"
                onClick={() => flip(m.key)}
                disabled={pending}
                data-state={isStaged ? 'unsaved' : m.enabled ? 'on' : 'off'}
                title={isStaged ? 'Not applied yet — click to put it back' : m.enabled ? 'On — click to stage turning it off' : 'Off — click to stage turning it on'}
                className={`rounded border px-3 py-1 text-sm ${
                  isStaged
                    ? 'border-amber-400 bg-amber-50 text-amber-900 ring-2 ring-amber-200'
                    : m.enabled
                      ? 'border-green-300 bg-green-50 text-green-700'
                      : 'border-gray-300 bg-gray-50 text-gray-500'
                }`}
              >
                {m.name}: {isStaged ? `${m.enabled ? 'on' : 'off'} → ${wanted ? 'ON' : 'OFF'}` : m.enabled ? 'on' : 'off'}
              </button>
            </li>
          )
        })}
      </ul>

      {changes.length > 0 && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">
          <p className="font-medium">
            {changes.length} change{changes.length === 1 ? '' : 's'} not applied yet for {props.orgName}:
          </p>
          <ul className="mt-1 list-disc pl-5">
            {changes.map((m) => (
              <li key={m.key}>
                Turn {staged[m.key] ? 'ON' : 'OFF'} <span className="font-medium">{m.name}</span>{' '}
                <button type="button" onClick={() => flip(m.key)} className="text-xs text-amber-800 underline">
                  Undo
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-amber-800">
            Turning a module off hides it from the organization; nothing is deleted. Turning it back on brings it back.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={apply}
              disabled={pending}
              className="rounded bg-amber-500 px-3 py-1 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-60"
            >
              {pending ? 'Updating…' : 'Update modules'}
            </button>
            <button
              type="button"
              onClick={() => {
                setStaged({})
                setError(null)
              }}
              disabled={pending}
              className="rounded border border-gray-300 bg-white px-3 py-1 text-sm text-gray-700 hover:bg-gray-50"
            >
              Undo all
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600">
          {error}
        </p>
      )}
    </div>
  )
}
