'use client'

import { createContext, useContext } from 'react'

// "Is a whole-account view open AND in scope for this page?" (docs/13 whole-account
// View as, revision 4/13). Provided by the (app) layout from getRealView(). Client code
// that would WRITE through the browser's own session (which is the superadmin's, not the
// person's) must check this and do nothing while viewing.
const ViewingContext = createContext(false)

export function ViewingProvider({ viewing, children }: { viewing: boolean; children: React.ReactNode }) {
  return <ViewingContext.Provider value={viewing}>{children}</ViewingContext.Provider>
}

export function useIsViewing(): boolean {
  return useContext(ViewingContext)
}

export const READ_ONLY_NOTICE_EVENT = 'view-as-readonly-notice'
export const READ_ONLY_NOTICE_TEXT =
  'Read-only view — this doesn’t do anything while you’re viewing someone’s screen.'

/** Shows the one read-only notice (rendered by ReadOnlyNotice, mounted with the banner). */
export function showReadOnlyNotice() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(READ_ONLY_NOTICE_EVENT))
}
