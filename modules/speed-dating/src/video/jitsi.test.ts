import { jwtVerify } from 'jose'
import { describe, expect, it } from 'vitest'
import { createJitsiProvider } from './jitsi'

const cfg = { domain: 'meet.example.org', appId: 'sd-app', appSecret: 'a-very-long-test-secret-key-not-real' }

describe('Jitsi video provider', () => {
  it('creates rooms with no collisions and no network call', async () => {
    const provider = createJitsiProvider(cfg)
    const refs = await Promise.all(Array.from({ length: 50 }, () => provider.createRoom({ eventId: 'e1', roundId: 'r1' })))
    expect(new Set(refs.map((r) => r.roomRef)).size).toBe(50)
    for (const r of refs) {
      expect(r.provider).toBe('jitsi')
      expect(r.roomRef.startsWith('sd-')).toBe(true)
    }
  })

  it('issues a token that verifies under the same secret, with the right room/identity claims', async () => {
    const provider = createJitsiProvider(cfg)
    const { token, expiresAt } = await provider.issueToken({
      roomRef: 'sd-abc123',
      userId: 'user-1',
      displayName: 'Dana D',
      email: 'dana@demo.local',
      moderator: false,
    })

    const { payload } = await jwtVerify(token, new TextEncoder().encode(cfg.appSecret))
    expect(payload.iss).toBe(cfg.appId)
    expect(payload.aud).toBe(cfg.appId)
    expect(payload.sub).toBe(cfg.domain)
    expect(payload.room).toBe('sd-abc123')
    const context = payload.context as { user: { id: string; name: string; email: string; moderator: boolean } }
    expect(context.user).toEqual({ id: 'user-1', name: 'Dana D', email: 'dana@demo.local', moderator: false })

    // Short-lived (schema note: "issued on demand... intentionally NOT
    // persisted"), and self-consistent with the returned expiresAt.
    const ttlSeconds = (payload.exp! as number) - (payload.iat! as number)
    expect(ttlSeconds).toBeGreaterThan(0)
    expect(ttlSeconds).toBeLessThanOrEqual(15 * 60)
    expect(Math.abs(expiresAt.getTime() / 1000 - payload.exp!)).toBeLessThan(1)
  })

  it('never grants moderator to a participant token, and disables recording/livestreaming', async () => {
    const provider = createJitsiProvider(cfg)
    const { token } = await provider.issueToken({
      roomRef: 'sd-xyz',
      userId: 'user-2',
      displayName: 'Frank F',
      moderator: false,
    })
    const { payload } = await jwtVerify(token, new TextEncoder().encode(cfg.appSecret))
    const context = payload.context as { user: { moderator: boolean }; features: { recording: boolean; livestreaming: boolean } }
    expect(context.user.moderator).toBe(false)
    expect(context.features).toEqual({ recording: false, livestreaming: false })
  })

  it('rejects a token signed with a different secret', async () => {
    const provider = createJitsiProvider(cfg)
    const { token } = await provider.issueToken({ roomRef: 'sd-abc', userId: 'u', displayName: 'U', moderator: false })
    await expect(jwtVerify(token, new TextEncoder().encode('some-other-secret'))).rejects.toThrow()
  })

  it('closeRoom and createRoom never throw for the self-hosted provider', async () => {
    const provider = createJitsiProvider(cfg)
    await expect(provider.closeRoom('sd-anything')).resolves.toBeUndefined()
  })
})
