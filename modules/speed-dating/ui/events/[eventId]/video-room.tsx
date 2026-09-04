'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { getVideoJoinToken } from '../../actions'

// The bare video surface behind the module's own chrome (timer, notepad,
// partner list — spec, decided 2026-07-06: "Embedded via lib-jitsi-meet so
// our chrome wraps a bare video surface"). Loaded from the CONFIGURED
// provider's own domain at join time, never bundled — self-hosted Jitsi
// ships its own copy of the library at a fixed path.
declare global {
  interface Window {
    JitsiMeetJS?: JitsiMeetJSGlobal
  }
}

// Minimal shape of the parts of lib-jitsi-meet this component actually
// calls — there is no official/bundled TS package for it, and the real
// object is loaded at runtime from a <script> tag, not an npm import.
type JitsiTrack = {
  isLocal(): boolean
  getType(): 'audio' | 'video'
  attach(el: HTMLMediaElement): void
  dispose(): Promise<void> | void
}
type JitsiConference = {
  join(): void
  leave(): Promise<void> | void
  addTrack(track: JitsiTrack): void
  on(event: string, handler: (...args: unknown[]) => void): void
}
type JitsiConnection = {
  connect(): void
  disconnect(): Promise<void> | void
  addEventListener(event: string, handler: (...args: unknown[]) => void): void
  initJitsiConference(room: string, options: Record<string, unknown>): JitsiConference
}
type JitsiMeetJSGlobal = {
  init(options: Record<string, unknown>): void
  createLocalTracks(options: { devices: string[] }): Promise<JitsiTrack[]>
  JitsiConnection: new (appId: string | null, token: string, options: Record<string, unknown>) => JitsiConnection
  events: {
    connection: { CONNECTION_ESTABLISHED: string; CONNECTION_FAILED: string }
    conference: { TRACK_ADDED: string; CONFERENCE_JOINED: string; CONFERENCE_FAILED: string }
  }
}

type Status = 'idle' | 'joining' | 'in_call' | 'left' | 'error'

type CallSession = { connection: JitsiConnection; room: JitsiConference; tracks: JitsiTrack[] }

const scriptLoads = new Map<string, Promise<void>>()

function loadJitsiScript(domain: string): Promise<void> {
  if (window.JitsiMeetJS) return Promise.resolve()
  const existing = scriptLoads.get(domain)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://${domain}/libs/lib-jitsi-meet.min.js`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load the video library'))
    document.head.appendChild(script)
  })
  scriptLoads.set(domain, promise)
  return promise
}

// Round-scoped: keyed by pairingId at the call site (page.tsx) so a NEW
// pairing next round mounts a fresh instance rather than reusing stale
// connection state from the previous room.
export default function VideoRoom({
  orgSlug,
  eventId,
  pairingId,
  roundEndsAt,
}: {
  orgSlug: string
  eventId: string
  pairingId: string
  /** ISO timestamp, or null for a round with no tracked end (degrades to no auto-leave). */
  roundEndsAt: string | null
}) {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const sessionRef = useRef<CallSession | null>(null)

  const leave = () => {
    const session = sessionRef.current
    sessionRef.current = null
    if (!session) return
    for (const track of session.tracks) {
      try {
        track.dispose()
      } catch {
        // best-effort cleanup — nothing to recover from client-side
      }
    }
    try {
      session.room.leave()
    } catch {
      /* already gone */
    }
    try {
      session.connection.disconnect()
    } catch {
      /* already gone */
    }
    setStatus('left')
  }

  // Video off at round end — mirrors authorizeVideoJoin's own server-side
  // ends_at rule (src/video/authorize.ts) so the client never outlasts the
  // window the join token was actually valid for.
  useEffect(() => {
    if (!roundEndsAt || status !== 'in_call') return
    const msLeft = new Date(roundEndsAt).getTime() - Date.now()
    if (msLeft <= 0) {
      leave()
      return
    }
    const id = setTimeout(leave, msLeft)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundEndsAt, status])

  // Leave on unmount (next round starts, or the participant navigates away).
  useEffect(() => {
    return () => leave()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function join() {
    setError(null)
    setStatus('joining')
    // getVideoJoinToken returns a discriminated union rather than throwing
    // for an expected refusal (not seated, round ended, video not
    // configured) — a THROWN Server Action error gets its message REDACTED
    // in a production build (Next's own documented expected-vs-uncaught
    // split), so a refusal reason would never actually reach the user. Only
    // genuine client-side failures from here on (lib-jitsi-meet itself) are
    // real thrown exceptions, since they never cross the Server Action
    // boundary.
    const result = await getVideoJoinToken(orgSlug, eventId, pairingId)
    if (!result.ok) {
      setError(result.reason)
      setStatus('error')
      return
    }
    try {
      const { token, roomRef, domain } = result
      await loadJitsiScript(domain)
      const JitsiMeetJS = window.JitsiMeetJS
      if (!JitsiMeetJS) throw new Error('The video library did not load')
      JitsiMeetJS.init({ disableAudioLevels: true })

      const connection = new JitsiMeetJS.JitsiConnection(null, token, {
        hosts: { domain, muc: `conference.${domain}` },
        serviceUrl: `https://${domain}/http-bind`,
      })

      await new Promise<void>((resolve, reject) => {
        connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, () => resolve())
        connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, () =>
          reject(new Error('Could not connect to the video server')),
        )
        connection.connect()
      })

      const room = connection.initJitsiConference(roomRef, { openBridgeChannel: true })
      room.on(JitsiMeetJS.events.conference.TRACK_ADDED, (...args: unknown[]) => {
        const track = args[0] as JitsiTrack
        if (track.isLocal()) return
        if (track.getType() === 'video' && remoteVideoRef.current) track.attach(remoteVideoRef.current)
      })

      const tracks = await JitsiMeetJS.createLocalTracks({ devices: ['audio', 'video'] })
      for (const track of tracks) {
        if (track.getType() === 'video' && localVideoRef.current) track.attach(localVideoRef.current)
        room.addTrack(track)
      }
      sessionRef.current = { connection, room, tracks }

      await new Promise<void>((resolve, reject) => {
        room.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, () => resolve())
        room.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, (...args: unknown[]) =>
          reject(new Error(typeof args[0] === 'string' ? args[0] : 'Could not join the room')),
        )
        room.join()
      })

      setStatus('in_call')
    } catch (err) {
      leave()
      setError(err instanceof Error ? err.message : 'Could not start video')
      setStatus('error')
    }
  }

  if (status === 'left') {
    return <p className="mt-2 text-sm text-gray-500">You left the video room.</p>
  }

  return (
    <div className="mt-2 rounded border border-indigo-100 bg-white p-3">
      {status === 'idle' && (
        <button
          onClick={() => startTransition(join)}
          disabled={isPending}
          className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          Join video
        </button>
      )}
      {status === 'joining' && <p className="text-sm text-indigo-700">Connecting…</p>}
      {status === 'error' && (
        <div>
          <p className="text-sm text-red-600">{error}</p>
          <button onClick={() => startTransition(join)} className="mt-1 text-xs text-indigo-600 hover:underline">
            Try again
          </button>
        </div>
      )}
      {status === 'in_call' && (
        <div className="grid grid-cols-2 gap-2">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={localVideoRef} autoPlay muted playsInline className="aspect-video w-full rounded bg-black" />
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={remoteVideoRef} autoPlay playsInline className="aspect-video w-full rounded bg-black" />
          <button
            onClick={leave}
            className="col-span-2 mt-1 w-fit rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            Leave
          </button>
        </div>
      )}
    </div>
  )
}
