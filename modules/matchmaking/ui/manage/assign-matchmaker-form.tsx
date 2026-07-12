'use client'

import { useState } from 'react'
import { assignMatchmaker } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Founder feedback (2026-07-11): the individual-email and group fields were
// both always visible and fillable regardless of which target type was
// selected — confusing, and nothing stopped filling both. A small client
// component (the only way to make "only show the relevant field" truly
// reactive) shows exactly one target input at a time, and suggests existing
// matchmakers/singles via <datalist> instead of a blind free-text email —
// so an admin isn't guessing at who's already been granted which role
// (still nobody-in-the-app can GRANT those roles; that's a separate,
// bigger gap — see the module spec).
export default function AssignMatchmakerForm(props: {
  orgSlug: string
  groups: { id: string; name: string }[]
  matchmakerEmails: string[]
  singleEmails: string[]
}) {
  const [targetType, setTargetType] = useState<'individual' | 'group'>('individual')

  return (
    <form action={assignMatchmaker.bind(null, props.orgSlug)} className="flex flex-wrap items-center gap-2">
      <input
        name="matchmakerEmail"
        type="email"
        required
        placeholder="matchmaker@email"
        list="mm-matchmaker-emails"
        className={`${inputCls} w-48`}
      />
      <datalist id="mm-matchmaker-emails">
        {props.matchmakerEmails.map((e) => (
          <option key={e} value={e} />
        ))}
      </datalist>

      <select
        name="targetType"
        required
        className={inputCls}
        value={targetType}
        onChange={(e) => setTargetType(e.target.value as 'individual' | 'group')}
      >
        <option value="individual">Individual single</option>
        <option value="group">Group</option>
      </select>

      {targetType === 'individual' ? (
        <>
          <input
            name="targetEmail"
            type="email"
            required
            placeholder="single@email"
            list="mm-single-emails"
            className={`${inputCls} w-56`}
          />
          <datalist id="mm-single-emails">
            {props.singleEmails.map((e) => (
              <option key={e} value={e} />
            ))}
          </datalist>
        </>
      ) : (
        <select name="targetGroupId" required className={inputCls} defaultValue="">
          <option value="" disabled>
            — pick a group —
          </option>
          {props.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      )}

      <button className={btnCls}>Assign</button>
    </form>
  )
}
