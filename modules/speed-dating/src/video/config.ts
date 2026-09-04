import { createJitsiProvider } from './jitsi'
import type { VideoProvider, VideoRoomRef } from './provider'

// Video is genuinely not deployed anywhere yet — the self-hosted Jitsi VPS
// is a paused go-live item (CLAUDE.md), so every env var here is expected to
// be ABSENT on this machine and in CI today. That split matters for who may
// throw vs. who must degrade:
//   * getVideoProvider() THROWS when unconfigured — a call site that only
//     runs when a participant is actively trying to join video (the
//     join-token action) should surface a real, visible error, not fail
//     silently.
//   * tryCreateVideoRoom() SWALLOWS the "not configured" case — the
//     orchestrator and the manual "run next round" action run on every
//     event regardless of whether video exists yet, so they must not break
//     the (already-shipped, video-less) rotation engine. A genuine
//     provider error (misconfigured but present) is still logged loudly,
//     never swallowed silently — see the docs/03 vacuity-rule lesson this
//     module's own orchestrator already carries for `?? []`.
//
// Local dev target (spec): `jitsi/docker-jitsi-meet`, configured for JWT
// auth (ENABLE_AUTH=1, ENABLE_GUESTS=0, AUTH_TYPE=jwt) with JWT_APP_ID /
// JWT_APP_SECRET matching JITSI_APP_ID / JITSI_APP_SECRET below. Standing
// up that container is a separate, later step — not done by this pass.

function readJitsiConfig(): { domain: string; appId: string; appSecret: string } | null {
  const domain = process.env.JITSI_DOMAIN
  const appId = process.env.JITSI_APP_ID
  const appSecret = process.env.JITSI_APP_SECRET
  if (!domain || !appId || !appSecret) return null
  return { domain, appId, appSecret }
}

export function isVideoConfigured(): boolean {
  return readJitsiConfig() !== null
}

export function getVideoProvider(): VideoProvider {
  const providerName = process.env.SPEED_DATING_VIDEO_PROVIDER ?? 'jitsi'
  if (providerName !== 'jitsi') {
    throw new Error(`Unknown speed-dating video provider "${providerName}"`)
  }
  const config = readJitsiConfig()
  if (!config) {
    throw new Error(
      'Jitsi video is not configured — set JITSI_DOMAIN, JITSI_APP_ID, JITSI_APP_SECRET ' +
        '(see docs/modules/module-6-speed-dating.md)',
    )
  }
  return createJitsiProvider(config)
}

export async function tryCreateVideoRoom(params: { eventId: string; roundId: string }): Promise<VideoRoomRef | null> {
  if (!isVideoConfigured()) return null
  try {
    return await getVideoProvider().createRoom(params)
  } catch (err) {
    console.error(`[speed-dating] video room creation failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
