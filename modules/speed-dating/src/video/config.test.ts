import { exportPKCS8, generateKeyPair, jwtVerify } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getVideoProvider, isVideoConfigured, tryCreateVideoRoom } from './config'

// Provider SELECTION, which is the part that can silently point production at
// the wrong server. Every env var these touch is expected to be absent on this
// machine, in CI and on prod today — so the unconfigured cases below are the
// REAL current state, not hypotheticals.

const VIDEO_ENV = [
  'SPEED_DATING_VIDEO_PROVIDER',
  'JAAS_APP_ID',
  'JAAS_API_KEY_ID',
  'JAAS_PRIVATE_KEY',
  'JITSI_DOMAIN',
  'JITSI_APP_ID',
  'JITSI_APP_SECRET',
] as const

let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(VIDEO_ENV.map((k) => [k, process.env[k]]))
  for (const k of VIDEO_ENV) delete process.env[k]
})

afterEach(() => {
  for (const k of VIDEO_ENV) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

// A syntactically valid PKCS#8 PEM is not needed here: the key is parsed
// lazily on first issueToken, never at construction, so selection can be
// tested without generating a keypair.
const setJaasEnv = () => {
  process.env.JAAS_APP_ID = 'vpaas-magic-cookie-test'
  process.env.JAAS_API_KEY_ID = 'vpaas-magic-cookie-test/abc123'
  process.env.JAAS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----'
}

const setJitsiEnv = () => {
  process.env.JITSI_DOMAIN = 'meet.example.org'
  process.env.JITSI_APP_ID = 'sd-app'
  process.env.JITSI_APP_SECRET = 'a-very-long-test-secret-key-not-real'
}

describe('video provider selection', () => {
  it('defaults to JaaS — the founder decision of 2026-10-02', () => {
    setJaasEnv()
    expect(process.env.SPEED_DATING_VIDEO_PROVIDER).toBeUndefined()
    expect(getVideoProvider().name).toBe('jaas')
  })

  it('does NOT fall back to self-hosted when only the JITSI_* vars are set', () => {
    // The default is a real decision, not a search: a half-migrated env that
    // still carries JITSI_* must fail loudly rather than quietly pointing at a
    // server nobody meant to use.
    setJitsiEnv()
    expect(isVideoConfigured()).toBe(false)
    expect(() => getVideoProvider()).toThrow(/JaaS video is not configured/)
  })

  it('selects self-hosted only when asked explicitly', () => {
    setJitsiEnv()
    process.env.SPEED_DATING_VIDEO_PROVIDER = 'jitsi'
    expect(isVideoConfigured()).toBe(true)
    const provider = getVideoProvider()
    expect(provider.name).toBe('jitsi')
    expect(provider.domain).toBe('meet.example.org')
  })

  it('reports unconfigured when nothing is set, and names the vars it wants', () => {
    expect(isVideoConfigured()).toBe(false)
    expect(() => getVideoProvider()).toThrow(/JAAS_APP_ID, JAAS_API_KEY_ID, JAAS_PRIVATE_KEY/)
  })

  it('treats a partial JaaS config as unconfigured', () => {
    setJaasEnv()
    delete process.env.JAAS_PRIVATE_KEY
    expect(isVideoConfigured()).toBe(false)
  })

  it('accepts an escaped-newline private key, the usual .env / Vercel mangling', async () => {
    // THIS TEST IS WRITTEN AGAINST A REAL KEYPAIR ON PURPOSE. Its first version
    // used a stub PEM and asserted `rejects.toThrow()` — which passes whether
    // or not the unescaping ran, and so sat green over a no-op `replace` that
    // would have failed EVERY join in production (found by adversarial review,
    // 2026-10-02). The only non-vacuous proof is that a token is actually
    // MINTED from the mangled form.
    const pair = await generateKeyPair('RS256', { extractable: true })
    const realPem = await exportPKCS8(pair.privateKey)

    setJaasEnv()
    process.env.JAAS_PRIVATE_KEY = realPem.split('\n').join(String.fromCharCode(92) + 'n')
    expect(process.env.JAAS_PRIVATE_KEY).not.toContain('\n') // control: genuinely one line

    const { token } = await getVideoProvider().issueToken({
      roomRef: 'sd-x',
      userId: 'u',
      displayName: 'U',
      moderator: false,
    })
    const { payload } = await jwtVerify(token, pair.publicKey, { audience: 'jitsi', issuer: 'chat' })
    expect(payload.room).toBe('sd-x')
  })

  it('leaves a normal multi-line private key untouched', async () => {
    // Control for the test above: the unescaping must not corrupt the ordinary
    // form, which is what a local .env file holding a real PEM looks like.
    const pair = await generateKeyPair('RS256', { extractable: true })
    setJaasEnv()
    process.env.JAAS_PRIVATE_KEY = await exportPKCS8(pair.privateKey)

    const { token } = await getVideoProvider().issueToken({
      roomRef: 'sd-y',
      userId: 'u',
      displayName: 'U',
      moderator: false,
    })
    await expect(jwtVerify(token, pair.publicKey, { audience: 'jitsi', issuer: 'chat' })).resolves.toBeDefined()
  })

  // Each of these mints a REAL token from the pasted form and verifies it against
  // the matching public key — a `rejects.toThrow()` would be vacuous (see above).
  const mintFrom = async (mangle: (pkcs8: string, pkcs1: string) => string) => {
    const { generateKeyPairSync } = await import('node:crypto')
    const nodePair = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pkcs8 = nodePair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const pkcs1 = nodePair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    setJaasEnv()
    process.env.JAAS_PRIVATE_KEY = mangle(pkcs8, pkcs1)
    const { token } = await getVideoProvider().issueToken({
      roomRef: 'sd-z',
      userId: 'u',
      displayName: 'U',
      moderator: false,
    })
    const { importSPKI } = await import('jose')
    const spki = nodePair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const { payload } = await jwtVerify(token, await importSPKI(spki, 'RS256'), { audience: 'jitsi', issuer: 'chat' })
    expect(payload.room).toBe('sd-z')
  }

  it('accepts a PKCS#1 ("BEGIN RSA PRIVATE KEY") key, which importPKCS8 alone rejects', async () => {
    await mintFrom((_p8, p1) => {
      expect(p1).toContain('BEGIN RSA PRIVATE KEY') // control: really the other container
      return p1
    })
  })

  it('accepts PKCS#1 pasted as one escaped line', async () => {
    await mintFrom((_p8, p1) => p1.split('\n').join(String.fromCharCode(92) + 'n'))
  })

  it('accepts CRLF line endings and wrapping quotes', async () => {
    await mintFrom((p8) => {
      const crlf = p8.split('\n').join('\r\n')
      expect(crlf).toContain('\r\n') // control
      return `"${crlf}"`
    })
  })

  it('rejects an unknown provider name loudly, but still lets rounds run', async () => {
    setJaasEnv()
    process.env.SPEED_DATING_VIDEO_PROVIDER = 'daily'
    expect(() => getVideoProvider()).toThrow(/Unknown speed-dating video provider "daily"/)
    // The rotation engine must never break on a video misconfiguration — a
    // video-less round is the already-shipped behaviour.
    expect(isVideoConfigured()).toBe(false)
    await expect(tryCreateVideoRoom({ eventId: 'e1', roundId: 'r1' })).resolves.toBeNull()
  })

  it('tryCreateVideoRoom returns null rather than throwing when video is absent', async () => {
    await expect(tryCreateVideoRoom({ eventId: 'e1', roundId: 'r1' })).resolves.toBeNull()
  })

  it('tryCreateVideoRoom mints a room once a provider IS configured', async () => {
    setJaasEnv()
    const room = await tryCreateVideoRoom({ eventId: 'e1', roundId: 'r1' })
    expect(room?.provider).toBe('jaas')
    expect(room?.roomRef.startsWith('sd-')).toBe(true)
  })
})
