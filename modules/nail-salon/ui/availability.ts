// Worker availability: weekly_schedule + time-off, checked at booking time.
// Pure functions (no supabase-js dependency) so the logic is testable and
// reused identically by every booking entry point (operator, walk-in,
// customer self-book). RLS/migration already exist (sal_worker_profiles /
// sal_worker_time_off, 20260709030000) — this closes the app-logic gap that
// migration's own INTEGRATION NOTE flagged ("slot-availability enforcement is
// module logic to add at integration").

export type DayKey = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'
export type DayRange = [string, string]
export type WeeklySchedule = Partial<Record<DayKey, DayRange[]>>

const DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const DAY_LABELS: Record<DayKey, string> = {
  sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
  thu: 'Thursday', fri: 'Friday', sat: 'Saturday',
}
export const ORDERED_DAYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// An empty/unset schedule ({}) means "not configured yet" -> unrestricted, so
// existing workers and demo data don't suddenly become unbookable the moment
// this feature ships. Once a manager sets ANY day, days left blank mean
// "not working that day" (the natural reading of a weekly schedule).
export function isWithinWeeklySchedule(schedule: WeeklySchedule | null | undefined, start: Date, end: Date): boolean {
  if (!schedule || Object.keys(schedule).length === 0) return true
  if (start.toDateString() !== end.toDateString()) return false // no overnight services

  const ranges = schedule[DAY_KEYS[start.getDay()]] ?? []
  const startMin = start.getHours() * 60 + start.getMinutes()
  const endMin = end.getHours() * 60 + end.getMinutes()
  return ranges.some(([rs, re]) => startMin >= minutesOf(rs) && endMin <= minutesOf(re))
}

// Weekly-schedule half of the availability check. The TIME-OFF half is NOT
// here: a customer's RLS scope can't read sal_worker_time_off (its `reason`
// may be sensitive), so all booking paths check time off through the
// sal_worker_has_time_off definer RPC instead — one code path, one source of
// truth (see 20260716010000_salon_worker_availability_check.sql). Weekly
// schedule stays in TS because every org member can already read
// sal_worker_profiles.weekly_schedule, so there's no RLS reason to move it,
// and the day/time-window math is far simpler here than in SQL.
export function weeklyScheduleError(
  schedule: WeeklySchedule | null | undefined,
  start: Date,
  end: Date,
): string | null {
  if (!isWithinWeeklySchedule(schedule, start, end)) {
    return `This worker isn't scheduled to work on ${DAY_LABELS[DAY_KEYS[start.getDay()]]} at that time.`
  }
  return null
}

// "09:00-17:00, 13:30-18:00" -> [["09:00","17:00"],["13:30","18:00"]]. Blank
// input -> [] (day off). Mirrors the exam problem-structure text-parsing
// convention (module 2) rather than a heavier structured-input component.
const TIME_RANGE_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/

export function parseDayRangesInput(text: string): DayRange[] {
  const trimmed = text.trim()
  if (!trimmed) return []
  return trimmed.split(',').map((part) => {
    const piece = part.trim()
    const m = TIME_RANGE_RE.exec(piece)
    if (!m) throw new Error(`Invalid time range "${piece}" — use HH:MM-HH:MM, e.g. 09:00-17:00`)
    const [, sh, sm, eh, em] = m
    const range: DayRange = [`${sh}:${sm}`, `${eh}:${em}`]
    if (minutesOf(range[1]) <= minutesOf(range[0])) throw new Error(`Time range "${piece}" must end after it starts`)
    return range
  })
}

export function formatDayRangesForInput(ranges: DayRange[] | undefined): string {
  return (ranges ?? []).map(([s, e]) => `${s}-${e}`).join(', ')
}
