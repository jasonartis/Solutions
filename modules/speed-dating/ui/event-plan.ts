// Event timing: parsing the organizer's round/break/round-cap settings and the
// "what will this take" preview. Pure (no React, no DB) so the create form, the
// edit form, the event pages and the tests share one definition.
//
// ROUND COUNT. Without a cap the rotation (src/rotation.ts) runs until everyone
// has met everyone: a single pool uses the circle method (N-1 rounds for an even
// N, N for an odd N because someone sits out each round); two sides rotate B
// against A, so it takes as many rounds as the larger side has people. That
// natural count depends on who is registered, so it is only ever "up to".
// WITH a cap (`sd_events.rounds_planned`, founder 2026-10-28) the event stops
// after that many rounds, which makes the length exact: rounds * round +
// (rounds - 1) * break. A cap also makes an event with repeat meetings
// plannable, which it never was before (no natural end).

import { roundsToMeetEveryone } from '../src/plan'

export const MAX_ROUND_MINUTES = 60
export const MAX_BREAK_SECONDS = 600
export const MAX_ROUNDS = 99

export type EventTimings = { roundSeconds: number; breakSeconds: number; maxRounds: number }

/** Reads `roundMinutes`, `breakSeconds` and `maxRounds`; returns an error string instead of throwing. */
export function parseTimings(formData: FormData): EventTimings | { error: string } {
  const roundMinutes = Number(String(formData.get('roundMinutes') ?? '').trim())
  const breakSeconds = Number(String(formData.get('breakSeconds') ?? '').trim())
  const maxRounds = Number(String(formData.get('maxRounds') ?? '').trim())
  if (!Number.isInteger(roundMinutes) || roundMinutes < 1 || roundMinutes > MAX_ROUND_MINUTES) {
    return { error: `Round length must be a whole number of minutes from 1 to ${MAX_ROUND_MINUTES}.` }
  }
  if (!Number.isInteger(breakSeconds) || breakSeconds < 0 || breakSeconds > MAX_BREAK_SECONDS) {
    return { error: `Break length must be a whole number of seconds from 0 to ${MAX_BREAK_SECONDS}.` }
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > MAX_ROUNDS) {
    return { error: `Number of rounds must be a whole number from 1 to ${MAX_ROUNDS}.` }
  }
  return { roundSeconds: roundMinutes * 60, breakSeconds, maxRounds }
}

/** How many rounds the rotation would run with nobody capping it. */
export function naturalRounds(opts: { people: number; sides?: { a: number; b: number } }): number {
  return roundsToMeetEveryone(opts.people, opts.sides)
}

/** Total minutes for `rounds` rounds: a break between rounds, none after the last. */
export function totalMinutesFor(rounds: number, roundSeconds: number, breakSeconds: number): number {
  if (rounds <= 0) return 0
  return Math.ceil((rounds * roundSeconds + (rounds - 1) * breakSeconds) / 60)
}

/** The number of rounds that fit in `lengthMinutes` (the cap, entered as a length instead). */
export function roundsForLength(lengthMinutes: number, roundSeconds: number, breakSeconds: number): number {
  const fit = Math.floor((lengthMinutes * 60 + breakSeconds) / (roundSeconds + breakSeconds))
  return Math.max(0, fit)
}

export type EventPlan = {
  rounds: number | null
  totalMinutes: number | null
  /** true when the round count is the organizer's cap (an exact figure), false when it is the natural "up to" */
  capped: boolean
}

export function planEvent(opts: {
  people: number
  /** people per side when the event has two sides; omit for one pool */
  sides?: { a: number; b: number }
  roundSeconds: number
  breakSeconds: number
  allowRepeats: boolean
  /** the organizer's cap, `sd_events.rounds_planned`; null/undefined = no cap */
  maxRounds?: number | null
}): EventPlan {
  const natural = naturalRounds(opts)
  const cap = opts.maxRounds ?? null
  let rounds: number | null
  let capped = false
  if (opts.allowRepeats) {
    // No natural end: a cap is the only thing that makes this plannable.
    rounds = cap
    capped = cap !== null
  } else if (cap !== null && cap < natural) {
    rounds = cap
    capped = true
  } else {
    rounds = natural
  }
  if (rounds === null) return { rounds: null, totalMinutes: null, capped }
  return { rounds, totalMinutes: totalMinutesFor(rounds, opts.roundSeconds, opts.breakSeconds), capped }
}

export function describeDuration(totalMinutes: number): string {
  if (totalMinutes < 60) return `about ${totalMinutes} minutes`
  const hours = Math.round((totalMinutes / 60) * 2) / 2 // nearest half hour
  return `about ${hours === 1 ? '1 hour' : `${hours} hours`}`
}

export function describePlan(opts: Parameters<typeof planEvent>[0]): string {
  const people = opts.sides ? opts.sides.a + opts.sides.b : opts.people
  const plan = planEvent(opts)
  if (plan.rounds === null || plan.totalMinutes === null) {
    return `${people} people. With repeat meetings allowed there is no natural end — set a number of rounds to see the length.`
  }
  if (!plan.rounds) {
    return 'Enter at least two people (or both sides) to see how long the event takes.'
  }
  if (plan.capped) {
    return `${people} people, ${plan.rounds} ${plan.rounds === 1 ? 'round' : 'rounds'}, ${describeDuration(plan.totalMinutes)}.`
  }
  return `${people} people, up to ${plan.rounds} ${plan.rounds === 1 ? 'round' : 'rounds'}, ${describeDuration(plan.totalMinutes)} (fewer if people block each other).`
}

// ---- self check-in window (founder 2026-10-28/29) ---------------------------------------------------
// A person checking THEMSELVES in is only meaningful once the event is about to start: otherwise someone
// can tap "I'm here" a week early and never show up. The window opens when the lobby does — the spec's
// "~15 minutes early" before the scheduled start (or sd_events.lobby_opens_at where one is set), or
// the moment the organizer starts the event. App-level rule only (the database lets a person set their own
// checked_in at any time; that only affects their own pairing).
export const LOBBY_LEAD_MINUTES = 15

export function lobbyOpenFrom(scheduledAt: string | null, lobbyOpensAt: string | null): Date | null {
  if (lobbyOpensAt) return new Date(lobbyOpensAt)
  if (scheduledAt) return new Date(new Date(scheduledAt).getTime() - LOBBY_LEAD_MINUTES * 60_000)
  return null
}

export function selfCheckInOpen(opts: {
  state: string
  scheduledAt: string | null
  lobbyOpensAt: string | null
  now?: Date
}): boolean {
  if (opts.state === 'running') return true
  if (opts.state !== 'open' && opts.state !== 'closed') return false
  const from = lobbyOpenFrom(opts.scheduledAt, opts.lobbyOpensAt)
  return from !== null && (opts.now ?? new Date()).getTime() >= from.getTime()
}
