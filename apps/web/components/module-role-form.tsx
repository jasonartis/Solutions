'use client'

import { useState } from 'react'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Dependent module -> role select (mirrors modules/matchmaking/ui/manage/
// assign-matchmaker-form.tsx's pattern): the role dropdown only ever offers
// values from the CHOSEN module's own manifest vocabulary (ModuleManifest.
// roles), so an admin can't submit a role string that module doesn't
// understand. A client component because the dependency is genuinely
// reactive — a plain server-rendered pair of selects can't filter one based
// on the other's live value.
export default function ModuleRoleForm(props: {
  action: (formData: FormData) => Promise<void>
  modules: { key: string; name: string; roles: readonly string[] }[]
  members: { userId: string; label: string }[]
}) {
  const [moduleKey, setModuleKey] = useState(props.modules[0]?.key ?? '')
  const roles = props.modules.find((m) => m.key === moduleKey)?.roles ?? []

  if (props.modules.length === 0 || props.members.length === 0) return null

  return (
    <form action={props.action} className="flex flex-wrap items-center gap-2">
      <select name="userId" required className={inputCls} defaultValue="">
        <option value="" disabled>
          — pick a member —
        </option>
        {props.members.map((m) => (
          <option key={m.userId} value={m.userId}>
            {m.label}
          </option>
        ))}
      </select>
      <select
        name="moduleKey"
        required
        className={inputCls}
        value={moduleKey}
        onChange={(e) => setModuleKey(e.target.value)}
      >
        {props.modules.map((m) => (
          <option key={m.key} value={m.key}>
            {m.name}
          </option>
        ))}
      </select>
      <select name="role" required className={inputCls} defaultValue="">
        <option value="" disabled>
          — pick a role —
        </option>
        {roles.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <button className={btnCls}>Grant role</button>
    </form>
  )
}
