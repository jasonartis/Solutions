'use client'

import { useEffect } from 'react'

// Tells the early error script in the root layout that the app's JavaScript
// started and hydrated. useEffect only runs once React is up in the browser,
// so setting this flag here means "the scripts booted". If the flag is never
// set (for example an old browser choking on our code), the layout's script
// shows the captured errors on screen after a few seconds.
export function BootFlag() {
  useEffect(() => {
    ;(window as unknown as { __spBooted?: boolean }).__spBooted = true
  }, [])
  return null
}
