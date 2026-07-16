'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

// Polls the server (router.refresh() re-renders this Server Component page)
// while a round is live, so a participant's countdown/partner updates without
// a manual reload. Matches the platform's existing poll-not-push rhythm
// (matchmaking rescore 30s, this module's own orchestrator 10s) rather than
// wiring up Supabase Realtime for one panel.
export default function LiveRoundRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(id)
  }, [router, intervalMs])
  return null
}
