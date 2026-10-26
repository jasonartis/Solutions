'use client'

import { useEffect, useRef, useState } from 'react'
import { describePlan } from './event-plan'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

// Round length, break length, and a live "how long will this take" line. Rendered
// INSIDE the create/edit form: it reads the form's own side-capacity and
// repeat-meeting fields as they change, so the preview follows what the
// organizer is typing without a round trip. The expected-people box is a
// planning aid only (no `name`, never submitted).
export function TimingFields({
  defaultRoundMinutes = 7,
  defaultBreakSeconds = 30,
  defaultPeople = 14,
  defaultAllowRepeats = false,
}: {
  defaultRoundMinutes?: number
  defaultBreakSeconds?: number
  defaultPeople?: number
  defaultAllowRepeats?: boolean
}) {
  const root = useRef<HTMLDivElement>(null)
  const [roundMinutes, setRoundMinutes] = useState(String(defaultRoundMinutes))
  const [breakSeconds, setBreakSeconds] = useState(String(defaultBreakSeconds))
  const [people, setPeople] = useState(String(defaultPeople))
  const [sides, setSides] = useState<{ on: boolean; a: number; b: number }>({ on: false, a: 0, b: 0 })
  const [repeats, setRepeats] = useState(false)

  useEffect(() => {
    const form = root.current?.closest('form')
    if (!form) return
    const read = () => {
      const val = (n: string) => (form.elements.namedItem(n) as HTMLInputElement | null)
      setSides({
        on: Boolean(val('sidesEnabled')?.checked),
        a: Number(val('sideACapacity')?.value) || 0,
        b: Number(val('sideBCapacity')?.value) || 0,
      })
      setRepeats(Boolean(val('allowRepeats')?.checked))
    }
    read()
    // Deferred on purpose: this listener sits on the FORM, so it runs before React's
    // own handler for the same event. Calling setState synchronously here makes React
    // re-render the controlled inputs with their OLD values first, and the typed
    // character is lost (onChange never fires).
    const later = () => setTimeout(read, 0)
    form.addEventListener('input', later)
    return () => form.removeEventListener('input', later)
  }, [])

  const r = Number(roundMinutes)
  const b = Number(breakSeconds)
  const valid = Number.isInteger(r) && r >= 1 && Number.isInteger(b) && b >= 0
  // Two sides with a blank capacity means "unlimited", so fall back to the
  // expected-people box split evenly rather than showing nothing.
  const n = Math.max(0, Math.floor(Number(people) || 0))
  const sidePeople =
    sides.on ? { a: sides.a || Math.ceil(n / 2), b: sides.b || Math.floor(n / 2) } : undefined

  return (
    <div ref={root} className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
        <label className="flex items-center gap-1">
          Round length
          <input
            name="roundMinutes"
            type="number"
            min="1"
            max="60"
            required
            value={roundMinutes}
            onChange={(e) => setRoundMinutes(e.target.value)}
            className={`${inputCls} w-16`}
          />
          min
        </label>
        <label className="flex items-center gap-1">
          Break between rounds
          <input
            name="breakSeconds"
            type="number"
            min="0"
            max="600"
            required
            value={breakSeconds}
            onChange={(e) => setBreakSeconds(e.target.value)}
            className={`${inputCls} w-20`}
          />
          sec
        </label>
        <label className="flex items-center gap-1">
          People you expect
          <input
            type="number"
            min="2"
            value={people}
            onChange={(e) => setPeople(e.target.value)}
            className={`${inputCls} w-20`}
          />
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" name="allowRepeats" defaultChecked={defaultAllowRepeats} />
          Let people meet more than once
        </label>
      </div>
      <p className="text-sm text-blue-700" aria-live="polite">
        {valid
          ? describePlan({
              people: n,
              sides: sidePeople,
              roundSeconds: r * 60,
              breakSeconds: b,
              allowRepeats: repeats,
            })
          : 'Enter a round length (whole minutes) and a break (whole seconds) to see the plan.'}
      </p>
    </div>
  )
}
