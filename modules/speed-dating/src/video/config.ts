import { createJaasProvider } from './jaas'
import { createJitsiProvider } from './jitsi'
import type { VideoProvider, VideoRoomRef } from './provider'

// Video is genuinely not deployed anywhere yet — every env var here is
// expected to be ABSENT on this machine, in CI and on prod today. That split
// matters for who may throw vs. who must degrade:
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
// TWO PROVIDERS, and the DEFAULT IS JaaS (founder decision 2026-10-02 — the
// hosting comparison is in docs/02 "Video" and the module-6 decisions log).
// Self-hosted stays fully supported and becomes the cheaper option past
// ~32 monthly active users; selecting it is one env var.

export type VideoProviderName = 'jaas' | 'jitsi'

const DEFAULT_PROVIDER: VideoProviderName = 'jaas'

function selectedProviderName(): VideoProviderName {
  const raw = process.env.SPEED_DATING_VIDEO_PROVIDER
  if (!raw) return DEFAULT_PROVIDER
  if (raw !== 'jaas' && raw !== 'jitsi') {
    throw new Error(
      `Unknown speed-dating video provider "${raw}" — expected "jaas" or "jitsi" ` +
        '(see docs/modules/module-6-speed-dating.md)',
    )
  }
  return raw
}

// JAAS_PRIVATE_KEY holds a PKCS#8 PEM. Multi-line secrets survive a .env file
// and Vercel's dashboard badly, so an escaped-newline form is accepted too —
// this is the single most likely way a correct key still fails to load.
function readJaasConfig(): { appId: string; keyId: string; privateKeyPem: string } | null {
  const appId = process.env.JAAS_APP_ID
  const keyId = process.env.JAAS_API_KEY_ID
  const rawKey = process.env.JAAS_PRIVATE_KEY
  if (!appId || !keyId || !rawKey) return null
  return { appId, keyId, privateKeyPem: unescapeNewlines(rawKey) }
}

// Written with split/join rather than a regex literal ON PURPOSE. The regex
// form (`/\\n/g`) is one backslash away from a silent no-op that replaces real
// newlines with themselves, which is exactly what shipped here for twenty
// minutes on 2026-10-02 — and the test that was supposed to cover it asserted
// only `rejects.toThrow()`, which passes whether or not the conversion ran.
// The vacuity rule (docs/03) in its purest form. BACKSLASH_N is built from a
// char code so no escape sequence appears in this file at all.
const BACKSLASH_N = String.fromCharCode(92) + 'n'

function unescapeNewlines(raw: string): string {
  return raw.split(BACKSLASH_N).join('\n')
}

function readJitsiConfig(): { domain: string; appId: string; appSecret: string } | null {
  const domain = process.env.JITSI_DOMAIN
  const appId = process.env.JITSI_APP_ID
  const appSecret = process.env.JITSI_APP_SECRET
  if (!domain || !appId || !appSecret) return null
  return { domain, appId, appSecret }
}

export function isVideoConfigured(): boolean {
  try {
    return selectedProviderName() === 'jaas' ? readJaasConfig() !== null : readJitsiConfig() !== null
  } catch {
    // An unrecognised SPEED_DATING_VIDEO_PROVIDER is a misconfiguration, not a
    // configured provider — report it as "no video" here so the orchestrator
    // keeps running video-less rounds, and let getVideoProvider() be the one
    // that says why.
    return false
  }
}

export function getVideoProvider(): VideoProvider {
  const name = selectedProviderName()

  if (name === 'jaas') {
    const config = readJaasConfig()
    if (!config) {
      throw new Error(
        'JaaS video is not configured — set JAAS_APP_ID, JAAS_API_KEY_ID, JAAS_PRIVATE_KEY ' +
          '(or set SPEED_DATING_VIDEO_PROVIDER=jitsi to use a self-hosted server). ' +
          'See docs/modules/module-6-speed-dating.md',
      )
    }
    return createJaasProvider(config)
  }

  const config = readJitsiConfig()
  if (!config) {
    throw new Error(
      'Self-hosted Jitsi video is not configured — set JITSI_DOMAIN, JITSI_APP_ID, JITSI_APP_SECRET ' +
        '(see docs/modules/module-6-speed-dating.md)',
    )
  }
  return createJitsiProvider(config)
}

let warnedUnconfigured = false

export async function tryCreateVideoRoom(params: { eventId: string; roundId: string }): Promise<VideoRoomRef | null> {
  if (!isVideoConfigured()) {
    // Say so ONCE per process. This path returned null in total silence, which
    // matters more now the default is JaaS: an environment still carrying only
    // JITSI_* reads as "no video configured" and every round would quietly mint
    // a room-less pairing with nothing in any log to explain it (adversarial
    // review, 2026-10-02 — the `?? []` vacuity lesson in another costume).
    // Once, not per round: the orchestrator runs this for every pairing of
    // every round, and a video-less event is a SUPPORTED state, not an error.
    if (!warnedUnconfigured) {
      warnedUnconfigured = true
      console.warn(
        '[speed-dating] no video provider is configured — rounds will run without video. ' +
          'Set JAAS_APP_ID / JAAS_API_KEY_ID / JAAS_PRIVATE_KEY, or SPEED_DATING_VIDEO_PROVIDER=jitsi ' +
          'with the JITSI_* vars.',
      )
    }
    return null
  }
  try {
    return await getVideoProvider().createRoom(params)
  } catch (err) {
    console.error(`[speed-dating] video room creation failed: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
