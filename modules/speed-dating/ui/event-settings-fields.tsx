import { TimingFields } from './timing-fields'
import { getEventSides, getShareContactOnMatch } from './event-format'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

export type EventSettingsDefaults = {
  resumeReview?: boolean
  format?: unknown
  roundSeconds?: number
  breakSeconds?: number
  allowRepeats?: boolean
  people?: number
}

// The settings shared by the create form and the edit form: timing (with the
// live preview), the two switches, and the optional two sides. Field names are
// what createEvent/updateEvent read (parseTimings, parseEventFormat).
export function EventSettingsFields({ defaults = {} }: { defaults?: EventSettingsDefaults }) {
  const sides = getEventSides(defaults.format)
  return (
    <>
      <TimingFields
        defaultRoundMinutes={defaults.roundSeconds ? Math.round(defaults.roundSeconds / 60) : undefined}
        defaultBreakSeconds={defaults.breakSeconds}
        defaultAllowRepeats={defaults.allowRepeats}
        defaultPeople={defaults.people}
      />
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1 text-sm text-gray-600">
          <input type="checkbox" name="resumeReview" defaultChecked={defaults.resumeReview} />
          Resume-review (participants see profile cards)
        </label>
        <label className="flex items-center gap-1 text-sm text-gray-600">
          <input type="checkbox" name="shareContactOnMatch" defaultChecked={getShareContactOnMatch(defaults.format)} />
          Share contact info on mutual match
        </label>
      </div>
      <details className="rounded border border-gray-100 p-2" open={Boolean(sides)}>
        <summary className="cursor-pointer text-sm text-gray-600">
          Two sides (e.g. Men/Women) — optional, sets a capacity + waitlist per side
        </summary>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1 text-sm text-gray-600">
            <input type="checkbox" name="sidesEnabled" defaultChecked={Boolean(sides)} />
            Enable two sides
          </label>
          <input name="sideALabel" defaultValue={sides?.a.label} placeholder="Side A label (e.g. Men)" className={`${inputCls} w-40`} />
          <input name="sideACapacity" type="number" min="1" defaultValue={sides?.a.capacity ?? undefined} placeholder="Side A capacity (blank = unlimited)" className={`${inputCls} w-56`} />
          <input name="sideBLabel" defaultValue={sides?.b.label} placeholder="Side B label (e.g. Women)" className={`${inputCls} w-40`} />
          <input name="sideBCapacity" type="number" min="1" defaultValue={sides?.b.capacity ?? undefined} placeholder="Side B capacity (blank = unlimited)" className={`${inputCls} w-56`} />
        </div>
      </details>
    </>
  )
}
