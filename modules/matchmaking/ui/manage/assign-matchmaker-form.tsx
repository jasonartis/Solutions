'use client'

import { useState } from 'react'
import { assignMatchmaker } from './actions'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Founder feedback (2026-07-11): the individual-email and group fields were
// both always visible and fillable regardless of which target type was
// selected — confusing, and nothing stopped filling both. A small client
// component (the only way to make "only show the relevant field" truly
// reactive) shows exactly one target input at a time.
//
// THE PICKER PICKS A PERSON, NOT AN ADDRESS (docs/22 §7.2, §3 R6). It used to
// be a free-text <input type="email"> backed by a <datalist> of EVERY
// matchmaker's and single's email address — the one place in the app that
// rendered a bulk list of addresses straight into the page source. The email
// was being used as a PERSON PICKER, never as contact information, so the fix
// is not to find a new way to fetch the addresses: it is to pick the person
// directly, by id and display name, exactly as every other roster on the
// platform already does. docs/20 §22.3 reached the same conclusion for a
// different reason. Nobody-in-the-app can still GRANT these roles; that is a
// separate, bigger gap — see the module spec.
export default function AssignMatchmakerForm(props: {
  orgSlug: string
  groups: { id: string; name: string }[]
  matchmakers: { userId: string; name: string }[]
  singles: { userId: string; name: string }[]
}) {
  const [targetType, setTargetType] = useState<'individual' | 'group'>('individual')

  return (
    <form action={assignMatchmaker.bind(null, props.orgSlug)} className="flex flex-wrap items-center gap-2">
      <select name="matchmakerId" required className={`${inputCls} w-48`} defaultValue="">
        <option value="" disabled>
          — pick a matchmaker —
        </option>
        {props.matchmakers.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.name}
          </option>
        ))}
      </select>

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
          <select name="targetUserId" required className={`${inputCls} w-56`} defaultValue="">
            <option value="" disabled>
              — pick a single —
            </option>
            {props.singles.map((t) => (
              <option key={t.userId} value={t.userId}>
                {t.name}
              </option>
            ))}
          </select>
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
