import { randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'
import type { IssueTokenParams, IssuedToken, VideoProvider, VideoRoomRef } from './provider'

export type JitsiConfig = {
  domain: string
  appId: string
  appSecret: string
  /** Join-token lifetime. Default 900s (15 min) comfortably covers one round
   *  (spec default 7 min) plus its break, without living any longer than it
   *  has to — tokens are never persisted (provider.ts header note). */
  tokenTtlSeconds?: number
}

const DEFAULT_TTL_SECONDS = 900

// Self-hosted Jitsi (jitsi/docker-jitsi-meet locally — spec, decided
// 2026-07-06), driven via lib-jitsi-meet on the client and JWT auth here.
export function createJitsiProvider(config: JitsiConfig): VideoProvider {
  const ttl = config.tokenTtlSeconds ?? DEFAULT_TTL_SECONDS
  const secretKey = new TextEncoder().encode(config.appSecret)

  return {
    name: 'jitsi',
    domain: config.domain,

    // Self-hosted Jitsi creates rooms lazily on first join — there is no
    // server-side "create" call to make. The room name is a random,
    // unguessable slug (defense in depth alongside the JWT gate: even if
    // ENABLE_GUESTS were ever misconfigured on, a stranger cannot guess a
    // live room). Kept async so a provider that DOES need a real
    // provisioning call (Daily/LiveKit) fits the same interface unchanged.
    async createRoom(): Promise<VideoRoomRef> {
      return { roomRef: `sd-${randomBytes(16).toString('hex')}`, provider: 'jitsi' }
    },

    // Jitsi's JWT auth shape (https://jitsi.github.io/handbook, JWT tokens):
    // context.user carries identity; context.user.moderator grants in-call
    // moderator UI. context.features explicitly disables recording/
    // livestreaming per-token — belt and suspenders alongside the product
    // promise, not a substitute for the server-side Jibri config.
    async issueToken({ roomRef, userId, displayName, email, moderator }: IssueTokenParams): Promise<IssuedToken> {
      const now = Math.floor(Date.now() / 1000)
      const exp = now + ttl
      const token = await new SignJWT({
        context: {
          user: {
            id: userId,
            name: displayName,
            email: email ?? undefined,
            moderator,
          },
          features: { recording: false, livestreaming: false },
        },
        room: roomRef,
      })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuer(config.appId)
        .setAudience(config.appId)
        .setSubject(config.domain)
        .setIssuedAt(now)
        .setExpirationTime(exp)
        .sign(secretKey)
      return { token, expiresAt: new Date(exp * 1000) }
    },

    // Self-hosted Jitsi has no persistent room object to tear down — a room
    // simply ceases to exist once everyone leaves. No-op, kept async so a
    // provider that DOES provision rooms can delete them on this same call.
    async closeRoom(): Promise<void> {},
  }
}
