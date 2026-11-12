'use client'

import { useRef, useState, useTransition } from 'react'
import type { ActionResult } from '@/lib/org-members'

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const btnCls = 'rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700'

// Dependent module -> role select (mirrors modules/matchmaking/ui/manage/
// assign-matchmaker-form.tsx's pattern): the role dropdown only ever offers
// values from the CHOSEN module's own manifest vocabulary (ModuleManifest.
// roles), so an admin can't submit a role string that module doesn't
// understand. A client component because the dependency is genuinely
// reactive — a plain server-rendered pair of selects can't filter one based
// on the other's live value.
//
// 2026-11-12: Grant role asks first (a popup naming who gets what) and shows a
// refusal INSIDE the popup — the action returns {ok, reason} instead of
// throwing into the generic error page (docs/03 #22). Same shape as
// components/org-member-controls.tsx.
export default function ModuleRoleForm(props: {
  action: (formData: FormData) => Promise<ActionResult>
  modules: { key: string; name: string; roles: readonly string[] }[]
  members: { userId: string; label: string }[]
}) {
  const [moduleKey, setModuleKey] = useState(props.modules[0]?.key ?? '')
  const roles = props.modules.find((m) => m.key === moduleKey)?.roles ?? []
  const formRef = useRef<HTMLFormElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const [summary, setSummary] = useState<{ person: string; moduleName: string; role: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  if (props.modules.length === 0 || props.members.length === 0) return null

  // The browser has already enforced `required` by the time this runs.
  function openConfirm(form: HTMLFormElement) {
    const data = new FormData(form)
    const person = props.members.find((m) => m.userId === data.get('userId'))?.label ?? 'this person'
    const moduleName = props.modules.find((m) => m.key === data.get('moduleKey'))?.name ?? String(data.get('moduleKey'))
    setSummary({ person, moduleName, role: String(data.get('role')) })
    setError(null)
    dialog.current?.showModal()
  }

  function confirmGrant() {
    if (!formRef.current) return
    const data = new FormData(formRef.current)
    start(async () => {
      const result = await props.action(data)
      if (result.ok) {
        dialog.current?.close()
        formRef.current?.reset()
      } else {
        setError(result.reason)
      }
    })
  }

  return (
    <>
      <form
        ref={formRef}
        onSubmit={(e) => {
          e.preventDefault()
          openConfirm(e.currentTarget)
        }}
        className="flex flex-wrap items-center gap-2"
      >
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
      <dialog ref={dialog} className="m-auto w-full max-w-md rounded-lg p-0 shadow-xl backdrop:bg-black/40">
        <div className="p-5">
          <h4 className="text-base font-semibold text-gray-900">
            Give {summary?.person} the {summary?.moduleName} role “{summary?.role}”?
          </h4>
          <p className="mt-2 text-sm text-gray-600">
            They will be able to do whatever that role allows in {summary?.moduleName}. You can take it away again from the × on their
            row.
          </p>
          {error && (
            <p role="alert" className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => dialog.current?.close()}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button type="button" disabled={pending} onClick={confirmGrant} className={`${btnCls} disabled:opacity-60`}>
              {pending ? 'Granting…' : 'Yes, grant it'}
            </button>
          </div>
        </div>
      </dialog>
    </>
  )
}
