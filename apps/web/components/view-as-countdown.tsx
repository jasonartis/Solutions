'use client'

import { useEffect, useState } from 'react'

// "Ends 3:42 PM (12 min left)" in the VIEWER's own clock and time zone (the server's
// clock/zone is not the founder's). Renders nothing until mounted, so there is no
// server/client text mismatch.
export function ViewAsCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(t)
  }, [])
  if (now === null) return null
  const end = Date.parse(expiresAt)
  const ends = new Date(end).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const minutes = Math.max(0, Math.ceil((end - now) / 60000))
  return (
    <>
      Ends {ends} ({minutes} min left).
    </>
  )
}
