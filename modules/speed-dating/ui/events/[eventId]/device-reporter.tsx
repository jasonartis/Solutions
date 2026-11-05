'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'

// Tells the organizer's Ready board whether THIS person's camera, microphone and connection are fine
// (module-6 spec 2026-11-05, "THE CLIENT CONTRACT"). Renders nothing. Mounted only for a person with a
// registered/waitlisted seat in an open/closed/running event; the database refuses everyone else.
//
// What is sent is three words, never a device label or id. A muted mic is still 'ok' (muting is a choice).
// Outside a call the camera/mic words come from the Permissions API + enumerateDevices (no device is opened);
// inside a call VideoRoom announces what it knows through the 'sd-call-state' window event below, which wins.

export type DeviceWord = 'ok' | 'missing' | 'blocked' | 'unknown'
type Device = DeviceWord
type Connection = 'connected' | 'reconnecting' | 'not_in_call'
type Report = { camera: Device; mic: Device; connection: Connection }

/** What VideoRoom tells this component. camera/mic are optional: absent means "not known from the call". */
export type CallState = { connection: Connection; camera?: Device; mic?: Device }
export const CALL_STATE_EVENT = 'sd-call-state'

/** Called by VideoRoom. A plain window event keeps the two components decoupled (no shared context needed). */
export function announceCallState(state: CallState) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<CallState>(CALL_STATE_EVENT, { detail: state }))
}

const HEARTBEAT_MS = 30_000
const THROTTLE_RETRY_MS = 5_000

async function probeKind(kind: 'camera' | 'microphone', deviceKind: MediaDeviceKind, devices: MediaDeviceInfo[] | null): Promise<Device> {
  let permission: PermissionState | null = null
  try {
    permission = (await navigator.permissions.query({ name: kind as PermissionName })).state
  } catch {
    /* Permissions API (or this name) unsupported — fall through to the device list */
  }
  if (permission === 'denied') return 'blocked'
  if (devices && !devices.some((d) => d.kind === deviceKind)) return 'missing'
  if (permission === 'granted' && devices) return 'ok'
  return 'unknown'
}

async function probeDevices(): Promise<Pick<Report, 'camera' | 'mic'>> {
  let devices: MediaDeviceInfo[] | null = null
  try {
    devices = await navigator.mediaDevices.enumerateDevices()
  } catch {
    /* no device list available */
  }
  return {
    camera: await probeKind('camera', 'videoinput', devices),
    mic: await probeKind('microphone', 'audioinput', devices),
  }
}

export default function DeviceReporter({ eventId }: { eventId: string }) {
  useEffect(() => {
    const supabase = createClient()
    let stopped = false
    let probed: Pick<Report, 'camera' | 'mic'> = { camera: 'unknown', mic: 'unknown' }
    let call: CallState = { connection: 'not_in_call' }
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const current = (): Report => ({
      camera: call.camera ?? probed.camera,
      mic: call.mic ?? probed.mic,
      connection: call.connection,
    })

    // changed = this send is for a state change (worth one retry if throttled); a heartbeat is not.
    async function send(changed: boolean) {
      if (stopped) return
      const r = current()
      const { data } = await supabase.rpc('sd_report_device_status', {
        p_event_id: eventId,
        p_camera: r.camera,
        p_mic: r.mic,
        p_connection: r.connection,
      })
      if (stopped) return
      if (data === 'refused') {
        stopped = true // not seated / event not live: stop for good
      } else if (data === 'throttled' && changed) {
        if (retryTimer) clearTimeout(retryTimer)
        retryTimer = setTimeout(() => void send(false), THROTTLE_RETRY_MS)
      }
    }

    async function reprobe() {
      probed = await probeDevices()
      void send(true)
    }

    const onCall = (e: Event) => {
      call = (e as CustomEvent<CallState>).detail
      void send(true)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void send(false)
    }

    window.addEventListener(CALL_STATE_EVENT, onCall)
    document.addEventListener('visibilitychange', onVisible)
    navigator.mediaDevices?.addEventListener?.('devicechange', reprobe)
    const heartbeat = setInterval(() => {
      if (document.visibilityState === 'visible') void send(false)
    }, HEARTBEAT_MS)

    // A permission flipping (allow/block in the address bar) is a change too.
    const permissionStatuses: PermissionStatus[] = []
    for (const name of ['camera', 'microphone']) {
      navigator.permissions
        ?.query({ name: name as PermissionName })
        .then((s) => {
          if (stopped) return
          s.onchange = () => void reprobe()
          permissionStatuses.push(s)
        })
        .catch(() => {})
    }

    void reprobe()

    return () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      clearInterval(heartbeat)
      window.removeEventListener(CALL_STATE_EVENT, onCall)
      document.removeEventListener('visibilitychange', onVisible)
      navigator.mediaDevices?.removeEventListener?.('devicechange', reprobe)
      for (const s of permissionStatuses) s.onchange = null
    }
  }, [eventId])

  return null
}
