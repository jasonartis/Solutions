'use client'

import { useActionState } from 'react'
import { REPORT_STATUSES } from '@/lib/content-reports'
import { setReportStatus } from './actions'

type State = { ok: true } | { ok: false; reason: string } | null

export function ReportStatusForm({ id, status }: { id: string; status: string }) {
  const [state, formAction, pending] = useActionState<State, FormData>(async (_prev, fd) => setReportStatus(fd), null)
  return (
    <form action={formAction} className="flex flex-col gap-2 text-sm">
      <input type="hidden" name="id" value={id} />
      <label>
        <span className="mr-2 font-medium">Status</span>
        <select name="status" defaultValue={status} className="rounded border border-gray-300 px-2 py-1">
          {REPORT_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="mb-1 block font-medium">Private note (only you see it; leave empty to keep the current one)</span>
        <textarea name="note" rows={2} maxLength={4000} className="w-full rounded border border-gray-300 px-2 py-1" />
      </label>
      <label className="text-xs text-gray-600">
        <input type="checkbox" name="clearNote" className="mr-1" />
        Erase the current note
      </label>
      <div>
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-gray-300 bg-white px-3 py-1 hover:bg-gray-50 disabled:opacity-50"
        >
          Save
        </button>
        {state?.ok === false && <span className="ml-2 text-red-600">{state.reason}</span>}
        {state?.ok === true && <span className="ml-2 text-green-700">Saved</span>}
      </div>
    </form>
  )
}
