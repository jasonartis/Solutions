'use client'

import { useFormStatus } from 'react-dom'

// A submit button that tells the person something is happening and refuses a
// second click while it is. Without it a slow server action looks like a dead
// button, people click again, and each click is a separate submit — founder's
// walkthrough 2026-10-21: six identical draft events from six clicks on
// "Create (draft)". Must be rendered INSIDE the <form> (useFormStatus reads its
// parent form's pending state).
export function SubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode
  pendingLabel: string
  className?: string
}) {
  const { pending } = useFormStatus()
  return (
    <button className={`${className ?? ''} disabled:cursor-wait disabled:opacity-60`} disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  )
}
