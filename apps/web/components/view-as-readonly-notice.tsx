'use client'

import { useEffect, useState } from 'react'
import { READ_ONLY_NOTICE_EVENT, READ_ONLY_NOTICE_TEXT } from '@/components/view-as-context'

// Mounted with the banner while a view is open (whole-account revision 4). Every form
// submission except the banner's Stop form is stopped here and answered with ONE plain
// notice, instead of the proxy's raw 403 page. Capture phase, so it runs before React's
// own handlers and before a server action can start. The proxy's 403 stays as the backstop.
export function ReadOnlyNotice() {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const show = () => {
      setShown(true)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setShown(false), 6000)
    }
    const onSubmit = (e: Event) => {
      const form = e.target as HTMLElement | null
      if (form?.closest?.('[data-view-as-stop]')) return
      // A plain GET form (search, filter) changes nothing: let it through. A form is GET
      // only when its method is get AND no submitter overrides it to post / another action.
      const sub = (e as SubmitEvent).submitter as HTMLButtonElement | HTMLInputElement | null
      if (form instanceof HTMLFormElement) {
        const method = (sub?.getAttribute?.('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
        const overridesAction = !!sub?.hasAttribute?.('formaction')
        // A server-action form has a javascript: action in React 19 and is never a real GET.
        if (method === 'get' && !overridesAction && !form.action.startsWith('javascript:')) return
      }
      e.preventDefault()
      e.stopPropagation()
      show()
    }
    document.addEventListener('submit', onSubmit, true)
    window.addEventListener(READ_ONLY_NOTICE_EVENT, show)
    return () => {
      document.removeEventListener('submit', onSubmit, true)
      window.removeEventListener(READ_ONLY_NOTICE_EVENT, show)
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (!shown) return null
  return (
    <div
      role="status"
      data-testid="view-as-readonly-notice"
      className="fixed bottom-4 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded border border-amber-400 bg-amber-100 px-4 py-3 text-sm text-amber-950 shadow-lg"
    >
      {READ_ONLY_NOTICE_TEXT}
    </div>
  )
}
