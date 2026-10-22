'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import type { VideoConnectionOptions } from '@modules/speed-dating'
import { getVideoJoinToken } from '../../actions'

// The bare video surface behind the module's own chrome (timer, notepad,
// partner list — spec, decided 2026-07-06: "Embedded via lib-jitsi-meet so
// our chrome wraps a bare video surface"). Loaded from the CONFIGURED
// provider's own host at join time, never bundled — both self-hosted Jitsi
// and JaaS ship their own copy of the library at /libs/lib-jitsi-meet.min.js.
//
// Every provider-specific value (script host, MUC, focus, transport URL)
// arrives from the server in `connection` — this component must never learn
// which provider it is talking to. See VideoConnectionOptions' own header.
//
// ⚠ NOTHING IN THIS FILE HAS EVER RUN AGAINST A REAL SERVER. There is no Jitsi
// anywhere — not local, not CI, not prod — so every defect here has been found
// by READING, twice (2026-09-04 build, 2026-10-02 adversarial review), and a
// unit test cannot observe a silent <video> element. Treat it as unverified
// until a real two-browser call has been made.
declare global {
  interface Window {
    JitsiMeetJS?: JitsiMeetJSGlobal
  }
}

// Minimal shape of the parts of lib-jitsi-meet this component actually
// calls — there is no official/bundled TS package for it, and the real
// object is loaded at runtime from a <script> tag, not an npm import.
//
// The async signatures are load-bearing, not decoration: `addTrack`, `dispose`,
// `leave` and `disconnect` all return Promises in the real library, and typing
// them as `void` is what let an un-awaited rejection hide (review finding,
// 2026-10-02 — a rejected addTrack publishes nothing and the partner sees a
// black tile, with only an unhandled rejection in the console).
type JitsiTrack = {
  isLocal(): boolean
  getType(): 'audio' | 'video'
  isMuted(): boolean
  mute(): Promise<void>
  unmute(): Promise<void>
  attach(el: HTMLMediaElement): void
  detach(el: HTMLMediaElement): void
  dispose(): Promise<void>
}
type JitsiConference = {
  join(): void
  leave(): Promise<void>
  addTrack(track: JitsiTrack): Promise<void>
  on(event: string, handler: (...args: unknown[]) => void): void
}
type JitsiConnection = {
  connect(): void
  disconnect(): Promise<void>
  addEventListener(event: string, handler: (...args: unknown[]) => void): void
  initJitsiConference(room: string, options: Record<string, unknown>): JitsiConference
}
type JitsiMeetJSGlobal = {
  init(options: Record<string, unknown>): void
  createLocalTracks(options: { devices: string[] }): Promise<JitsiTrack[]>
  JitsiConnection: new (appId: string | null, token: string, options: Record<string, unknown>) => JitsiConnection
  events: {
    connection: { CONNECTION_ESTABLISHED: string; CONNECTION_FAILED: string }
    conference: {
      TRACK_ADDED: string
      TRACK_REMOVED: string
      TRACK_MUTE_CHANGED: string
      CONFERENCE_JOINED: string
      CONFERENCE_FAILED: string
    }
  }
}

type Status = 'idle' | 'joining' | 'in_call' | 'left' | 'error'

/** What we can tell about one of the PARTNER's media tracks. 'none' = no such
 *  track has arrived (not connected, or they never granted the device) — which
 *  is different from 'off' (they muted it), and that difference is exactly what
 *  two people debugging "I can't see/hear you" need to tell apart. */
type PartnerMedia = 'none' | 'on' | 'off'

type MediaElements = { audio: HTMLAudioElement | null; video: HTMLVideoElement | null }

type CallSession = {
  connection: JitsiConnection | null
  room: JitsiConference | null
  /** Our own camera/mic tracks — disposed on leave (releases the devices). */
  localTracks: JitsiTrack[]
  /** The partner's tracks — detached on leave, never disposed (not ours). */
  remoteTracks: JitsiTrack[]
}

/** Neither endpoint is guaranteed to answer. Without this the join promises can
 *  never settle (dead token, unreachable host, firewall) and the UI sits on
 *  "Connecting…" forever with no way out but a page reload — the Try-again
 *  button renders only in the 'error' state. */
const CONNECT_TIMEOUT_MS = 20_000

const scriptLoads = new Map<string, Promise<void>>()
let jitsiInitialised = false

function loadJitsiScript(scriptHost: string): Promise<void> {
  if (window.JitsiMeetJS) return Promise.resolve()
  const existing = scriptLoads.get(scriptHost)
  if (existing) return existing
  const promise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://${scriptHost}/libs/lib-jitsi-meet.min.js`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load the video library'))
    document.head.appendChild(script)
  }).catch((err) => {
    // Evict a FAILED load before rethrowing. Caching the rejected promise made
    // the "Try again" button structurally incapable of recovering: every retry
    // re-read the same settled rejection and never re-requested the script.
    scriptLoads.delete(scriptHost)
    throw err
  })
  scriptLoads.set(scriptHost, promise)
  return promise
}

/** Swallows BOTH a synchronous throw and a rejected promise. The teardown calls
 *  were previously wrapped in a plain try/catch around an UN-awaited promise,
 *  which catches neither — the "already gone" comments were false comfort and
 *  the rejections surfaced as unhandled. */
async function settle(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
  } catch {
    /* best-effort teardown — there is nothing to recover client-side */
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(id)
        resolve(value)
      },
      (err) => {
        clearTimeout(id)
        reject(err)
      },
    )
  })
}

/** The ONE teardown path, used by leave(), by the cancel-on-unmount check and
 *  by the failure catch. Three separate ad-hoc teardowns is how the camera came
 *  to stay on in three different ways. */
async function teardownCall(session: CallSession, els: MediaElements): Promise<void> {
  for (const track of session.remoteTracks) {
    const el = track.getType() === 'audio' ? els.audio : els.video
    if (!el) continue
    await settle(() => track.detach(el))
  }
  for (const track of session.localTracks) {
    // Releases the camera and microphone. If this does not run, the device
    // light stays on after the user has left.
    await settle(() => track.dispose())
  }
  if (session.room) await settle(() => session.room!.leave())
  if (session.connection) await settle(() => session.connection!.disconnect())
}

// Round-scoped: keyed by pairingId at the call site (page.tsx) so a NEW
// pairing next round mounts a fresh instance rather than reusing stale
// connection state from the previous room.
export default function VideoRoom({
  orgSlug,
  eventId,
  pairingId,
  partnerName,
  roundEndsAt,
}: {
  orgSlug: string
  eventId: string
  pairingId: string
  /** The partner's display name, for the status line and captions ("Dana", not "Them"). */
  partnerName: string
  /** ISO timestamp, or null for a round with no tracked end (degrades to no auto-leave). */
  roundEndsAt: string | null
}) {
  const partnerFirstName = partnerName.trim().split(/\s+/)[0] || 'Partner'
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(true)
  const [partnerAudio, setPartnerAudio] = useState<PartnerMedia>('none')
  const [partnerVideo, setPartnerVideo] = useState<PartnerMedia>('none')
  const localVideoRef = useRef<HTMLVideoElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  // A SEPARATE element for the partner's microphone. A <video> element plays
  // only the track attached to it, so attaching just the remote VIDEO track —
  // which this component did until 2026-10-02 — produced a silent call: you
  // saw your partner and never heard them. One element is enough because
  // authorizeVideoJoin admits exactly the two seats in this pairing and
  // refuses every observer; if audience/mentor seats are ever built, this
  // becomes a list.
  const remoteAudioRef = useRef<HTMLAudioElement>(null)
  const sessionRef = useRef<CallSession | null>(null)
  /** Set by the unmount cleanup. page.tsx keys this component on the pairing
   *  id, so a round advancing unmounts it MID-JOIN — and an unmount that
   *  happens before sessionRef is populated used to leave the connection, the
   *  MUC presence and the camera running with nothing left to stop them. */
  const cancelledRef = useRef(false)

  const mediaElements = (): MediaElements => ({ audio: remoteAudioRef.current, video: remoteVideoRef.current })

  const leave = async () => {
    const session = sessionRef.current
    sessionRef.current = null
    if (!session) return
    await teardownCall(session, mediaElements())
    setPartnerAudio('none')
    setPartnerVideo('none')
    setStatus('left')
  }

  // Mute / camera toggles act on OUR OWN published track (mute() keeps the
  // device open and just stops sending; the partner's TRACK_MUTE_CHANGED shows
  // them the state). State is set from the track's own isMuted() afterwards
  // rather than flipped optimistically, so the button can never disagree with
  // what is actually being sent.
  const toggleLocal = async (type: 'audio' | 'video') => {
    const track = sessionRef.current?.localTracks.find((t) => t.getType() === type)
    if (!track) return
    try {
      if (track.isMuted()) await track.unmute()
      else await track.mute()
    } catch {
      /* the device vanished mid-call — the state below will say what is true */
    }
    if (type === 'audio') setMicOn(!track.isMuted())
    else setCamOn(!track.isMuted())
  }

  // Video off at round end — mirrors authorizeVideoJoin's own server-side
  // ends_at rule (src/video/authorize.ts) so the client never outlasts the
  // window the join token was actually valid for.
  useEffect(() => {
    if (!roundEndsAt || status !== 'in_call') return
    const msLeft = new Date(roundEndsAt).getTime() - Date.now()
    if (msLeft <= 0) {
      void leave()
      return
    }
    const id = setTimeout(() => void leave(), msLeft)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roundEndsAt, status])

  // Leave on unmount (next round starts, or the participant navigates away).
  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
      void leave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function join() {
    setError(null)
    setMicOn(true)
    setCamOn(true)
    setPartnerAudio('none')
    setPartnerVideo('none')
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

    // Accumulated as we go so that EVERY exit path below — cancellation,
    // timeout, a thrown getUserMedia — has something complete to tear down.
    // Previously `localTracks` was scoped inside the try, so the catch could
    // not dispose it and a failure after createLocalTracks left the camera on.
    const session: CallSession = { connection: null, room: null, localTracks: [], remoteTracks: [] }

    /** True if the component unmounted while we were awaiting. */
    const abandonIfCancelled = async (): Promise<boolean> => {
      if (!cancelledRef.current) return false
      await teardownCall(session, mediaElements())
      return true
    }

    try {
      const { token, roomRef, connection: conn } = result
      await loadJitsiScript(conn.scriptHost)
      if (await abandonIfCancelled()) return

      const JitsiMeetJS = window.JitsiMeetJS
      if (!JitsiMeetJS) throw new Error('The video library did not load')
      // Idempotency is undocumented, so call it once per page rather than once
      // per join attempt.
      if (!jitsiInitialised) {
        JitsiMeetJS.init({ disableAudioLevels: true })
        jitsiInitialised = true
      }

      const connection = new JitsiMeetJS.JitsiConnection(null, token, buildConnectionConfig(conn))
      session.connection = connection

      await withTimeout(
        new Promise<void>((resolve, reject) => {
          connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, () => resolve())
          connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, () =>
            reject(new Error('Could not connect to the video server')),
          )
          connection.connect()
        }),
        CONNECT_TIMEOUT_MS,
        'The video server did not respond. Please try again.',
      )
      if (await abandonIfCancelled()) return

      // p2p: a speed-dating round is always exactly two people, which is the
      // case peer-to-peer exists for — media goes browser-to-browser and never
      // touches the bridge, which is the whole basis of docs/02's "P2P mode for
      // 1:1 calls barely loads the server".
      // UNVERIFIED: the low-level API reference does not list this key, though
      // every option it DOES list is a config.js key, and P2P is on by default
      // for two participants anyway. Harmless if ignored — but do NOT cite the
      // low-server-load claim as measured until a real call has been inspected.
      const room = connection.initJitsiConference(roomRef, {
        openBridgeChannel: true,
        p2p: { enabled: true },
      })
      session.room = room

      room.on(JitsiMeetJS.events.conference.TRACK_ADDED, (...args: unknown[]) => {
        const track = args[0] as JitsiTrack
        if (track.isLocal()) return
        // RECORDED BEFORE the element check, always. When the push sat after
        // the null-ref guard, a track that arrived early was invisible to both
        // TRACK_REMOVED and teardown — so it could never be cleaned up either.
        session.remoteTracks.push(track)
        const state: PartnerMedia = track.isMuted() ? 'off' : 'on'
        if (track.getType() === 'audio') setPartnerAudio(state)
        else setPartnerVideo(state)
        const el = track.getType() === 'audio' ? remoteAudioRef.current : remoteVideoRef.current
        if (!el) return
        track.attach(el)
      })
      room.on(JitsiMeetJS.events.conference.TRACK_REMOVED, (...args: unknown[]) => {
        const track = args[0] as JitsiTrack
        const i = session.remoteTracks.indexOf(track)
        if (i === -1) return
        session.remoteTracks.splice(i, 1)
        if (track.getType() === 'audio') setPartnerAudio('none')
        else setPartnerVideo('none')
        // Without this, a partner who drops leaves their last frame frozen on
        // screen, which reads as a live call.
        const el = track.getType() === 'audio' ? remoteAudioRef.current : remoteVideoRef.current
        if (!el) return
        try {
          track.detach(el)
        } catch {
          /* already detached */
        }
      })

      // Optional on older library builds; without it the partner status line
      // simply keeps its arrival-time value instead of updating live.
      if (JitsiMeetJS.events.conference.TRACK_MUTE_CHANGED) {
        room.on(JitsiMeetJS.events.conference.TRACK_MUTE_CHANGED, (...args: unknown[]) => {
          const track = args[0] as JitsiTrack
          if (track.isLocal()) return
          const state: PartnerMedia = track.isMuted() ? 'off' : 'on'
          if (track.getType() === 'audio') setPartnerAudio(state)
          else setPartnerVideo(state)
        })
      }

      session.localTracks = await JitsiMeetJS.createLocalTracks({ devices: ['audio', 'video'] })
      if (await abandonIfCancelled()) return
      for (const track of session.localTracks) {
        if (track.getType() === 'video' && localVideoRef.current) track.attach(localVideoRef.current)
      }
      // AWAITED: addTrack returns a Promise and rejects (the library throws on
      // a second video stream, among others). Un-awaited, a rejection published
      // nothing and the partner saw a black tile with no error anywhere.
      // Tracks are added BEFORE join(), which ljm-getting-started states
      // explicitly.
      await Promise.all(session.localTracks.map((track) => room.addTrack(track)))
      if (await abandonIfCancelled()) return

      sessionRef.current = session

      await withTimeout(
        new Promise<void>((resolve, reject) => {
          room.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, () => resolve())
          room.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, (...args: unknown[]) =>
            reject(new Error(typeof args[0] === 'string' ? args[0] : 'Could not join the room')),
          )
          room.join()
        }),
        CONNECT_TIMEOUT_MS,
        'Could not join the room in time. Please try again.',
      )
      if (await abandonIfCancelled()) {
        sessionRef.current = null
        return
      }

      setStatus('in_call')
    } catch (err) {
      sessionRef.current = null
      await teardownCall(session, mediaElements())
      setError(toJoinErrorMessage(err))
      setStatus('error')
    }
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
      {status === 'left' && (
        <div className="flex items-center gap-3">
          <p className="text-sm text-gray-500">You left the video room.</p>
          <button
            onClick={() => startTransition(join)}
            disabled={isPending}
            className="rounded bg-indigo-600 px-3 py-1 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            Rejoin video
          </button>
        </div>
      )}
      {status === 'joining' && <p className="text-sm text-indigo-700">Connecting…</p>}
      {status === 'error' && (
        <div>
          <p className="text-sm text-red-600">{error}</p>
          <button
            onClick={() => startTransition(join)}
            // Without this a second click runs join() concurrently; the second
            // session assignment orphaned the first connection and its camera
            // tracks, and only the last was ever torn down.
            disabled={isPending}
            className="mt-1 text-xs text-indigo-600 hover:underline disabled:opacity-50"
          >
            Try again
          </button>
        </div>
      )}
      {/* MOUNTED UNCONDITIONALLY — never inside a status branch. TRACK_ADDED
          fires while room.join() is still in flight, and setStatus runs inside
          a transition, so its commit is DEFERRED and not ordered against the
          join at all. If the partner is already in the room (true for whichever
          dater joins second, every round) their tracks arrive against null refs
          and are dropped for the whole round: a black square and silence, with
          no error. Mounting these from first render removes the race rather
          than narrowing it. Collapsed with h-0 rather than `hidden` because
          display:none can stop a browser starting playback at all. */}
      <div className={status === 'in_call' ? 'grid grid-cols-2 gap-2' : 'h-0 overflow-hidden opacity-0'}>
        {/* Each tile is wrapped so a "camera is off" cover can sit on top. When a
            camera is muted the <video> keeps painting the LAST frame it had, which
            reads as a frozen call — so the tile is covered by a black panel with a
            crossed-out camera and a plain-words caption instead. The <video>
            elements themselves stay mounted (see the note above). */}
        <div className="relative">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={localVideoRef} autoPlay muted playsInline className="aspect-video w-full rounded bg-black" />
          {status === 'in_call' && !camOn && <CameraOffCover caption="Your camera is off" />}
        </div>
        <div className="relative">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video ref={remoteVideoRef} autoPlay playsInline className="aspect-video w-full rounded bg-black" />
          {status === 'in_call' && partnerVideo !== 'on' && (
            <CameraOffCover
              caption={partnerVideo === 'off' ? `${partnerFirstName}'s camera is off` : `Waiting for ${partnerFirstName}'s camera…`}
            />
          )}
        </div>
        {/* The partner's microphone. Deliberately NOT muted — this element is
            the only thing that makes the call audible. */}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio ref={remoteAudioRef} autoPlay />
        {status === 'in_call' && (
          <>
            {/* What each side is actually sending — the answer to "can you
                see/hear me?" without needing a chat. 'not connected' means no
                track from them has arrived at all (device blocked, or they have
                not joined); 'off' means they muted it on purpose. */}
            <p className="col-span-2 text-xs text-gray-600" data-testid="video-status">
              You: microphone {micOn ? 'on' : 'off'} · camera {camOn ? 'on' : 'off'}
              <br />
              {partnerFirstName}: microphone {mediaWord(partnerAudio)} · camera {mediaWord(partnerVideo)}
            </p>
            <div className="col-span-2 mt-1 flex flex-wrap gap-2">
              <button
                onClick={() => void toggleLocal('audio')}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              >
                {micOn ? 'Mute microphone' : 'Unmute microphone'}
              </button>
              <button
                onClick={() => void toggleLocal('video')}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              >
                {camOn ? 'Turn camera off' : 'Turn camera on'}
              </button>
              <button
                onClick={() => void leave()}
                className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
              >
                Leave
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CameraOffCover({ caption }: { caption: string }) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-1 rounded bg-black text-xs text-gray-300"
      role="img"
      aria-label={caption}
    >
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 7l5-3v14l-5-3" />
        <rect x="2" y="6" width="14" height="12" rx="2" />
        <path d="M3 3l18 18" />
      </svg>
      <span>{caption}</span>
    </div>
  )
}

function mediaWord(state: PartnerMedia): string {
  return state === 'on' ? 'on' : state === 'off' ? 'off (they muted it)' : 'not connected'
}

// lib-jitsi-meet reads optional keys as ABSENT rather than undefined — an
// explicit `focus: undefined` entry is treated as a configured empty host on
// some paths, so the optional values are omitted instead of set to undefined.
function buildConnectionConfig(conn: VideoConnectionOptions): Record<string, unknown> {
  const hosts: Record<string, string> = { domain: conn.hosts.domain, muc: conn.hosts.muc }
  if (conn.hosts.focus) hosts.focus = conn.hosts.focus
  const config: Record<string, unknown> = { hosts, serviceUrl: conn.serviceUrl }
  if (conn.websocketKeepAliveUrl) config.websocketKeepAliveUrl = conn.websocketKeepAliveUrl
  return config
}

// getUserMedia's own errors are DOMExceptions whose message is unreadable to a
// dater ("Requested device not found"), and a denied camera is by far the most
// likely failure in a real round — so name the two recoverable cases plainly
// rather than surfacing the browser's string.
function toJoinErrorMessage(err: unknown): string {
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Your browser blocked camera or microphone access. Allow it in the address bar, then try again.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No camera or microphone was found. Connect one, then try again.'
  }
  return err instanceof Error ? err.message : 'Could not start video'
}
