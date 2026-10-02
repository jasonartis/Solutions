// The video-provider interface (module 6 spec, decided 2026-07-06: Jitsi
// self-hosted, behind an interface so Daily/LiveKit/JaaS is a config swap,
// not a rewrite). Four operations — create room / issue token / connection
// options / close room — matching the schema's own note on
// sd_pairings.room_ref/room_provider.
//
// Per-user JOIN TOKENS are short-lived and issued ON DEMAND at join time —
// deliberately NOT persisted anywhere (schema header note). Nothing in this
// interface stores or references a recording — "no recording, ever" is an
// explicit product promise (spec, Safety section).

export type VideoRoomRef = {
  roomRef: string
  /** Matches sd_pairings.room_provider. */
  provider: string
}

export type IssueTokenParams = {
  roomRef: string
  userId: string
  displayName: string
  email?: string | null
  /**
   * Jitsi moderator rights (mute-all/kick/recording controls). NEVER true for
   * a participant — the organizer console is a separate surface ("connection
   * status only, never video feeds", spec) and no dater should hold in-call
   * moderator controls. Kept as a parameter rather than hardcoded so the
   * interface can express a future staff use case explicitly, not by
   * omission.
   */
  moderator: boolean
}

export type IssuedToken = {
  token: string
  expiresAt: Date
}

/**
 * Everything the BROWSER needs to open a connection to this provider, beyond
 * the token itself. Returned by getVideoJoinToken and handed straight to
 * lib-jitsi-meet, so the client never branches on provider name — which is
 * what makes docs/02's "swapping to managed is config, not rewrite" actually
 * true rather than aspirational. Added 2026-10-02 with the JaaS provider,
 * because self-hosted and JaaS differ in all four of these values and the
 * client had the self-hosted ones hardcoded.
 *
 * NOTHING HERE IS SECRET — these are public endpoints, and the JaaS AppID
 * appears in the browser's own network requests regardless. The token is the
 * secret, and it already crosses this same boundary.
 */
export type VideoConnectionOptions = {
  /** Host serving lib-jitsi-meet: `https://<scriptHost>/libs/lib-jitsi-meet.min.js`. */
  scriptHost: string
  hosts: { domain: string; muc: string; focus?: string }
  /** BOSH (`https://…/http-bind`) self-hosted; XMPP websocket on JaaS. */
  serviceUrl: string
  websocketKeepAliveUrl?: string
}

export interface VideoProvider {
  readonly name: string
  readonly domain: string
  createRoom(params: { eventId: string; roundId: string }): Promise<VideoRoomRef>
  issueToken(params: IssueTokenParams): Promise<IssuedToken>
  connectionOptions(roomRef: string): VideoConnectionOptions
  closeRoom(roomRef: string): Promise<void>
}
