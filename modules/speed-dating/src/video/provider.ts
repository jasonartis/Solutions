// The video-provider interface (module 6 spec, decided 2026-07-06: Jitsi
// self-hosted, behind an interface so Daily/LiveKit/JaaS is a config swap,
// not a rewrite). Three operations only — create room / issue token / close
// room — matching the schema's own note on sd_pairings.room_ref/room_provider.
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

export interface VideoProvider {
  readonly name: string
  readonly domain: string
  createRoom(params: { eventId: string; roundId: string }): Promise<VideoRoomRef>
  issueToken(params: IssueTokenParams): Promise<IssuedToken>
  closeRoom(roomRef: string): Promise<void>
}
