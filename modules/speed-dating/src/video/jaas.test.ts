import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from 'jose'
import { beforeAll, describe, expect, it } from 'vitest'
import { createJaasProvider } from './jaas'

// JaaS signs RS256 with a keypair generated in the 8x8 console, so these tests
// generate a throwaway pair and verify with its PUBLIC half — which is the
// only way to prove the token we mint is actually verifiable by 8x8 rather
// than merely well-shaped.
const APP_ID = 'vpaas-magic-cookie-0123456789abcdef'
const KEY_ID = 'vpaas-magic-cookie-0123456789abcdef/a1b2c3'

// Inferred rather than named — see jaas.ts on the worker's missing DOM lib.
type GeneratedPair = Awaited<ReturnType<typeof generateKeyPair>>

let privateKeyPem: string
let publicKey: GeneratedPair['publicKey']

beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true })
  privateKeyPem = await exportPKCS8(pair.privateKey)
  publicKey = pair.publicKey
})

const makeProvider = (overrides: Partial<Parameters<typeof createJaasProvider>[0]> = {}) =>
  createJaasProvider({ appId: APP_ID, keyId: KEY_ID, privateKeyPem, ...overrides })

describe('JaaS video provider', () => {
  it('creates rooms with no collisions and no network call', async () => {
    const provider = makeProvider()
    const refs = await Promise.all(
      Array.from({ length: 50 }, () => provider.createRoom({ eventId: 'e1', roundId: 'r1' })),
    )
    expect(new Set(refs.map((r) => r.roomRef)).size).toBe(50)
    for (const r of refs) {
      expect(r.provider).toBe('jaas')
      expect(r.roomRef.startsWith('sd-')).toBe(true)
    }
  })

  it('signs RS256 and carries the API key id in the header', async () => {
    const { token } = await makeProvider().issueToken({
      roomRef: 'sd-abc123',
      userId: 'user-1',
      displayName: 'Dana D',
      moderator: false,
    })
    // 8x8 reject a token whose `kid` does not name an uploaded key, and the
    // algorithm must be RS256 — HS256 (what the self-hosted provider signs) is
    // refused outright. Both are asserted from the real header, not the config.
    const header = decodeProtectedHeader(token)
    expect(header.alg).toBe('RS256')
    expect(header.kid).toBe(KEY_ID)
    expect(header.typ).toBe('JWT')
  })

  it("uses 8x8's hardcoded aud/iss and the AppID as sub — NOT our own identifiers", async () => {
    const { token, expiresAt } = await makeProvider().issueToken({
      roomRef: 'sd-abc123',
      userId: 'user-1',
      displayName: 'Dana D',
      email: 'dana@demo.local',
      moderator: false,
    })

    const { payload } = await jwtVerify(token, publicKey, { audience: 'jitsi', issuer: 'chat' })
    // The literal strings are the point of this test: the natural mistake is to
    // put our AppID in iss/aud the way the self-hosted provider does, which
    // 8x8 reject. Asserted as literals so a "tidy" refactor to config.appId
    // fails here rather than in production.
    expect(payload.aud).toBe('jitsi')
    expect(payload.iss).toBe('chat')
    expect(payload.sub).toBe(APP_ID)
    expect(payload.room).toBe('sd-abc123')

    const context = payload.context as { user: { id: string; name: string; email: string; moderator: boolean } }
    expect(context.user).toEqual({ id: 'user-1', name: 'Dana D', email: 'dana@demo.local', moderator: false })

    const ttlSeconds = (payload.exp as number) - (payload.iat as number)
    expect(ttlSeconds).toBeGreaterThan(0)
    expect(ttlSeconds).toBeLessThanOrEqual(15 * 60)
    expect(Math.abs(expiresAt.getTime() / 1000 - (payload.exp as number))).toBeLessThan(1)
  })

  it('sets nbf slightly in the past so clock skew cannot reject a fresh token', async () => {
    const { token } = await makeProvider().issueToken({
      roomRef: 'sd-abc',
      userId: 'u',
      displayName: 'U',
      moderator: false,
    })
    const { payload } = await jwtVerify(token, publicKey, { audience: 'jitsi', issuer: 'chat' })
    expect(payload.nbf).toBeDefined()
    // Strictly before iat — a token whose nbf equals iat is rejected by a
    // verifier whose clock is a second behind ours.
    expect(payload.nbf as number).toBeLessThan(payload.iat as number)
  })

  it('never grants moderator, and refuses every durable-artefact feature', async () => {
    const { token } = await makeProvider().issueToken({
      roomRef: 'sd-xyz',
      userId: 'user-2',
      displayName: 'Frank F',
      moderator: false,
    })
    const { payload } = await jwtVerify(token, publicKey, { audience: 'jitsi', issuer: 'chat' })
    const context = payload.context as {
      user: { moderator: boolean }
      features: Record<string, boolean>
    }
    expect(context.user.moderator).toBe(false)
    // transcription is the one JaaS adds over self-hosted, and "no recording,
    // ever" (spec, Safety) is a promise about durable artefacts — a transcript
    // is one.
    expect(context.features).toEqual({
      recording: false,
      livestreaming: false,
      transcription: false,
      'outbound-call': false,
    })
  })

  it('rejects a token verified against a different keypair', async () => {
    const other = await generateKeyPair('RS256', { extractable: true })
    const { token } = await makeProvider().issueToken({
      roomRef: 'sd-abc',
      userId: 'u',
      displayName: 'U',
      moderator: false,
    })
    await expect(jwtVerify(token, other.publicKey, { audience: 'jitsi', issuer: 'chat' })).rejects.toThrow()
  })

  it('pins the token to ONE room, never the wildcard 8x8 allows', async () => {
    const { token } = await makeProvider().issueToken({
      roomRef: 'sd-room-one',
      userId: 'u',
      displayName: 'U',
      moderator: false,
    })
    const { payload } = await jwtVerify(token, publicKey, { audience: 'jitsi', issuer: 'chat' })
    expect(payload.room).toBe('sd-room-one')
    expect(payload.room).not.toBe('*')
  })

  it('builds connection options carrying the AppID in the MUC host and transport, not the room name', () => {
    const options = makeProvider().connectionOptions('sd-abc123')
    expect(options.scriptHost).toBe('8x8.vc')
    expect(options.hosts.domain).toBe('8x8.vc')
    expect(options.hosts.muc).toBe(`conference.${APP_ID}.8x8.vc`)
    expect(options.hosts.focus).toBe('focus.8x8.vc')
    expect(options.serviceUrl).toBe(`wss://8x8.vc/${APP_ID}/xmpp-websocket?room=sd-abc123`)
    expect(options.websocketKeepAliveUrl).toBe(`https://8x8.vc/${APP_ID}/_unlock?room=sd-abc123`)
  })

  it('url-encodes the room in the transport URLs', () => {
    // Our own slugs are hex and need no encoding — this guards the generic
    // path, since a roomRef is only ever read back out of sd_pairings and the
    // column is plain text, not a constrained format.
    const options = makeProvider().connectionOptions('sd-a b&c')
    expect(options.serviceUrl).toContain('room=sd-a%20b%26c')
    expect(options.websocketKeepAliveUrl).toContain('room=sd-a%20b%26c')
  })

  it('does not cache a failed key import, so a retry really retries', async () => {
    const provider = makeProvider({ privateKeyPem: '-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----' })
    const params = { roomRef: 'sd-abc', userId: 'u', displayName: 'U', moderator: false }
    // Both attempts must REJECT rather than the second resolving from, or
    // hanging on, a cached rejection — the trap video-room.tsx's script loader
    // shipped with.
    await expect(provider.issueToken(params)).rejects.toThrow()
    await expect(provider.issueToken(params)).rejects.toThrow()
  })

  it('closeRoom never throws', async () => {
    await expect(makeProvider().closeRoom('sd-anything')).resolves.toBeUndefined()
  })
})
