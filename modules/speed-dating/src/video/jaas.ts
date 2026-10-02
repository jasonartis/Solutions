import { randomBytes } from 'node:crypto'
import { SignJWT, importPKCS8 } from 'jose'
import type {
  IssueTokenParams,
  IssuedToken,
  VideoConnectionOptions,
  VideoProvider,
  VideoRoomRef,
} from './provider'

// JaaS — 8x8-hosted Jitsi. Added 2026-10-02 after the hosting comparison
// (docs/02 "Video", module-6 decisions log): the free tier is 25 monthly
// active users, speed dating's own default event is 7v7 = 14 people, and a
// participant who attends twice in a billing cycle still counts once. So a
// monthly event costs nothing and needs no VPS, no TLS renewal, no coturn
// and no OS patching — 8x8 state plainly that self-hosted Jitsi carries "no
// commercial support, SLA or professional services".
//
// This is a SECOND provider beside jitsi.ts, not a replacement: self-hosting
// stays a live option (and is the cheaper one past ~32 MAU/month), which is
// exactly the swap the provider interface exists to make cheap.
//
// WHAT DIFFERS FROM SELF-HOSTED, all of it forced by 8x8's own docs
// (developer.8x8.com/jaas/docs/api-keys-jwt, jitsi/ljm-getting-started):
//   * RS256 with a key id, not HS256 with a shared secret.
//   * `aud` and `iss` are HARDCODED STRINGS ('jitsi' / 'chat') — they are not
//     our identifiers, and getting them "sensibly" wrong is rejected.
//   * `sub` is the AppID (self-hosted puts the domain there).
//   * `nbf` is required.
//   * The XMPP transport is a websocket carrying the AppID and room, not BOSH.

export type JaasConfig = {
  /** JaaS AppID from the console — the `vpaas-magic-cookie-…` tenant id. */
  appId: string
  /** API key id; becomes the JWT's `kid` header. NOT a secret. */
  keyId: string
  /** The RS256 PRIVATE key, PKCS#8 PEM. Secret — server-side only, never returned. */
  privateKeyPem: string
  /** Join-token lifetime. Default 900s (15 min), as jitsi.ts. */
  tokenTtlSeconds?: number
}

const JAAS_DOMAIN = '8x8.vc'
const DEFAULT_TTL_SECONDS = 900
/** Clock-skew tolerance on `nbf`. Our server and 8x8's are not synchronised,
 *  and a token rejected as not-yet-valid is indistinguishable to a dater from
 *  the room being broken. */
const NBF_SKEW_SECONDS = 10

export function createJaasProvider(config: JaasConfig): VideoProvider {
  const ttl = config.tokenTtlSeconds ?? DEFAULT_TTL_SECONDS

  // Imported once and reused: importPKCS8 parses the PEM, which we do not want
  // to repeat on every join. Kept as the PROMISE rather than an awaited value
  // so the factory itself stays synchronous (matching createJitsiProvider, so
  // config.ts does not need a second shape). A malformed key therefore surfaces
  // on first issueToken, not at construction — and that is the right place:
  // getVideoJoinToken already converts a provider throw into an {ok:false}
  // refusal the dater can actually read (docs/03 #22).
  // Typed by INFERENCE, not by naming CryptoKey: the worker's tsconfig does
  // not carry the DOM lib, so the global type is absent there (caught by
  // typecheck, 2026-10-02). This shape is correct in every workspace.
  type ImportedKey = Awaited<ReturnType<typeof importPKCS8>>
  let keyPromise: Promise<ImportedKey> | null = null
  const privateKey = () => {
    if (!keyPromise) {
      keyPromise = importPKCS8(config.privateKeyPem, 'RS256').catch((err) => {
        // Do not cache a rejection — a retry would otherwise replay it forever
        // (the same trap video-room.tsx's script loader shipped with).
        keyPromise = null
        throw err
      })
    }
    return keyPromise
  }

  return {
    name: 'jaas',
    domain: JAAS_DOMAIN,

    // Same lazy-room model as self-hosted: JaaS creates a room on first join,
    // so there is no provisioning call. The name is a random unguessable slug —
    // defence in depth beside the JWT gate, and `room` is pinned to this exact
    // slug in the token below rather than the '*' wildcard 8x8 permits.
    async createRoom(): Promise<VideoRoomRef> {
      return { roomRef: `sd-${randomBytes(16).toString('hex')}`, provider: 'jaas' }
    },

    async issueToken({ roomRef, userId, displayName, email, moderator }: IssueTokenParams): Promise<IssuedToken> {
      const now = Math.floor(Date.now() / 1000)
      const exp = now + ttl
      const token = await new SignJWT({
        context: {
          user: {
            id: userId,
            name: displayName,
            email: email ?? undefined,
            // BOOLEAN, and deliberately so — adversarial review (2026-10-02)
            // flagged that 8x8's own PHP sample emits the STRINGS "true"/
            // "false" and argued the reserved moderator:true path would
            // silently fail. Checked against the real Prosody plugins
            // (token_affiliation, token_owner_party): both compare
            // `== "true"` AND `== true` explicitly, so either type grants
            // correctly — and, more importantly, neither is a Lua TRUTHINESS
            // check, so the string "false" could not accidentally grant
            // moderator either. 8x8's docs say it should be a boolean. Do not
            // "fix" this to a string.
            moderator,
          },
          // JaaS exposes two capabilities self-hosted Jitsi does not, and both
          // are refused here for the same reason as recording: "no recording,
          // ever" (spec, Safety) is a promise about there being no durable
          // artefact of the conversation, and a TRANSCRIPT is exactly that.
          // outbound-call has no use in a paired dating round at all.
          features: {
            recording: false,
            livestreaming: false,
            transcription: false,
            'outbound-call': false,
          },
        },
        room: roomRef,
      })
        .setProtectedHeader({ alg: 'RS256', kid: config.keyId, typ: 'JWT' })
        // Hardcoded by 8x8, NOT our identifiers — see this file's header.
        .setAudience('jitsi')
        .setIssuer('chat')
        .setSubject(config.appId)
        .setIssuedAt(now)
        .setNotBefore(now - NBF_SKEW_SECONDS)
        .setExpirationTime(exp)
        .sign(await privateKey())
      return { token, expiresAt: new Date(exp * 1000) }
    },

    // Per jitsi/ljm-getting-started: the AppID lives in the websocket path and
    // the MUC host, never in the room name handed to initJitsiConference.
    connectionOptions(roomRef: string): VideoConnectionOptions {
      const room = encodeURIComponent(roomRef)
      return {
        scriptHost: JAAS_DOMAIN,
        hosts: {
          domain: JAAS_DOMAIN,
          muc: `conference.${config.appId}.${JAAS_DOMAIN}`,
          focus: `focus.${JAAS_DOMAIN}`,
        },
        serviceUrl: `wss://${JAAS_DOMAIN}/${config.appId}/xmpp-websocket?room=${room}`,
        websocketKeepAliveUrl: `https://${JAAS_DOMAIN}/${config.appId}/_unlock?room=${room}`,
      }
    },

    // Nothing to tear down — a JaaS room ceases to exist once everyone leaves,
    // exactly as self-hosted. No-op, kept async for a provider that does need
    // an explicit delete.
    async closeRoom(): Promise<void> {},
  }
}
