import { describe, expect, it } from 'vitest'
import { getCheckInMode, parseEventFormat } from './event-format'

const form = (entries: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.set(k, v)
  return f
}

describe('check-in mode in the event format', () => {
  it('reads staff and self, and nothing else', () => {
    expect(parseEventFormat(form({ checkIn: 'staff' })).checkIn).toBe('staff')
    expect(parseEventFormat(form({ checkIn: 'self' })).checkIn).toBe('self')
    expect(parseEventFormat(form({ checkIn: '' })).checkIn).toBeUndefined()
    expect(parseEventFormat(form({ checkIn: 'everyone' })).checkIn).toBeUndefined()
    expect(parseEventFormat(form({})).checkIn).toBeUndefined()
  })
  it('getCheckInMode is null unless the stored format says staff or self', () => {
    expect(getCheckInMode({ checkIn: 'staff' })).toBe('staff')
    expect(getCheckInMode({ checkIn: 'self' })).toBe('self')
    expect(getCheckInMode({})).toBeNull()
    expect(getCheckInMode(null)).toBeNull()
    expect(getCheckInMode({ checkIn: 'bogus' })).toBeNull()
  })
  it('coexists with the other format settings', () => {
    const f = parseEventFormat(form({ checkIn: 'staff', shareContactOnMatch: 'on' }))
    expect(f.checkIn).toBe('staff')
    expect(f.shareContactOnMatch).toBe(true)
  })
})
