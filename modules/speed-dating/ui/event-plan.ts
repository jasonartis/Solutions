// Event timing: parsing the organizer's round/break settings and the "what will
// this take" preview. Pure (no React, no DB) so the create form, the edit form
// and the tests share one definition.
//
// The round count mirrors src/rotation.ts: a single pool uses the circle method
// (N-1 rounds for an even N, N for an odd N because someone sits out each
// round); two sides rotate B against A, so it takes as many rounds as the
// larger side has people. With repeats allowed there is no natural end, so no
// number is promised. Personal blocks can only REMOVE meetings, so the figure
// is an upper bound — the wording says "up to".

export const MAX_ROUND_MINUTES = 60
export const MAX_BREAK_SECONDS = 600

export type EventTimings = { roundSeconds: number; breakSeconds: number }

/** Reads `roundMinutes` and `breakSeconds`; returns an error string instead of throwing. */
export function parseTimings(formData: FormData): EventTimings | { error: string } {
  const roundMinutes = Number(String(formData.get('roundMinutes') ?? '').trim())
  const breakSeconds = Number(String(formData.get('breakSeconds') ?? '').trim())
  if (!Number.isInteger(roundMinutes) || roundMinutes < 1 || roundMinutes > MAX_ROUND_MINUTES) {
    return { error: `Round length must be a whole number of minutes from 1 to ${MAX_ROUND_MINUTES}.` }
  }
  if (!Number.isInteger(breakSeconds) || breakSeconds < 0 || breakSeconds > MAX_BREAK_SECONDS) {
    return { error: `Break length must be a whole number of seconds from 0 to ${MAX_BREAK_SECONDS}.` }
  }
  return { roundSeconds: roundMinutes * 60, breakSeconds }
}

export type EventPlan = { rounds: number | null; totalMinutes: number | null }

export function planEvent(opts: {
  people: number
  /** people per side when the event has two sides; omit for one pool */
  sides?: { a: number; b: number }
  roundSeconds: number
  breakSeconds: number
  allowRepeats: boolean
}): EventPlan {
  if (opts.allowRepeats) return { rounds: null, totalMinutes: null }
  let rounds = 0
  if (opts.sides) {
    rounds = opts.sides.a > 0 && opts.sides.b > 0 ? Math.max(opts.sides.a, opts.sides.b) : 0
  } else if (opts.people >= 2) {
    rounds = opts.people % 2 === 0 ? opts.people - 1 : opts.people
  }
  if (rounds === 0) return { rounds: 0, totalMinutes: 0 }
  const totalSeconds = rounds * opts.roundSeconds + (rounds - 1) * opts.breakSeconds
  return { rounds, totalMinutes: Math.ceil(totalSeconds / 60) }
}

export function describeDuration(totalMinutes: number): string {
  if (totalMinutes < 60) return `about ${totalMinutes} minutes`
  const hours = Math.round((totalMinutes / 60) * 2) / 2 // nearest half hour
  return `about ${hours === 1 ? '1 hour' : `${hours} hours`}`
}

export function describePlan(opts: Parameters<typeof planEvent>[0]): string {
  const people = opts.sides ? opts.sides.a + opts.sides.b : opts.people
  if (opts.allowRepeats) {
    return `${people} people. With repeat meetings allowed there is no natural end — you stop it when you want.`
  }
  const plan = planEvent(opts)
  if (!plan.rounds || plan.totalMinutes === null) {
    return 'Enter at least two people (or both sides) to see how long the event takes.'
  }
  return `${people} people, up to ${plan.rounds} rounds, ${describeDuration(plan.totalMinutes)} (fewer if people block each other).`
}
