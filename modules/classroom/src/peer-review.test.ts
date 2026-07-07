import { describe, expect, it } from 'vitest'
import { assignPeerReviews, type PeerReviewAssignment, type ReviewHistoryEntry } from './peer-review'

function roster(n: number): string[] {
  // s01, s02, … — sortable, stable ids.
  return Array.from({ length: n }, (_, i) => `s${String(i + 1).padStart(2, '0')}`)
}

function submissionsFor(students: string[]) {
  return students.map((studentId) => ({ studentId }))
}

function receivedCounts(assignments: PeerReviewAssignment[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const a of assignments) {
    counts.set(a.submissionStudentId, (counts.get(a.submissionStudentId) ?? 0) + 1)
  }
  return counts
}

function givenCounts(assignments: PeerReviewAssignment[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const a of assignments) {
    counts.set(a.reviewerId, (counts.get(a.reviewerId) ?? 0) + 1)
  }
  return counts
}

function toHistory(assignments: PeerReviewAssignment[]): ReviewHistoryEntry[] {
  return assignments.map((a) => ({ reviewerId: a.reviewerId, revieweeId: a.submissionStudentId }))
}

describe('assignPeerReviews', () => {
  it('never assigns a student their own submission', () => {
    for (const n of [3, 5, 8, 20]) {
      const students = roster(n)
      const assignments = assignPeerReviews(students, submissionsFor(students), 3, [], 0)
      for (const a of assignments) {
        expect(a.reviewerId).not.toBe(a.submissionStudentId)
      }
    }
  })

  it('gives every reviewer exactly N assignments when feasible', () => {
    const students = roster(10)
    const assignments = assignPeerReviews(students, submissionsFor(students), 3, [], 0)
    expect(assignments).toHaveLength(30)
    const given = givenCounts(assignments)
    for (const s of students) {
      expect(given.get(s)).toBe(3)
    }
  })

  it('never assigns the same submission to a reviewer twice in one round', () => {
    const students = roster(6)
    const assignments = assignPeerReviews(students, submissionsFor(students), 4, [], 2)
    const seen = new Set<string>()
    for (const a of assignments) {
      const key = `${a.reviewerId}->${a.submissionStudentId}`
      expect(seen.has(key)).toBe(false)
      seen.add(key)
    }
  })

  it('balances reviews-received exactly when everyone submits', () => {
    const students = roster(7)
    const assignments = assignPeerReviews(students, submissionsFor(students), 3, [], 1)
    const counts = receivedCounts(assignments)
    for (const s of students) {
      expect(counts.get(s)).toBe(3)
    }
  })

  it('balances reviews-received within 1 when only some students submitted', () => {
    const students = roster(6)
    // Only 4 of 6 submitted; all 6 still review.
    const submissions = submissionsFor(students.slice(0, 4))
    const assignments = assignPeerReviews(students, submissions, 2, [], 0)

    // Everyone still performs 2 reviews (4 eligible submissions each, minus self for submitters).
    const given = givenCounts(assignments)
    for (const s of students) {
      expect(given.get(s)).toBe(2)
    }

    const counts = receivedCounts(assignments)
    const values = [...counts.values()]
    // Non-submitters must receive nothing (they have no submission).
    expect(counts.has('s05')).toBe(false)
    expect(counts.has('s06')).toBe(false)
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1)
  })

  it('caps assignments at the eligible submission count when the class is tiny', () => {
    const students = roster(3)
    // Only 2 eligible submissions per reviewer (can't review self) but 3 requested.
    const assignments = assignPeerReviews(students, submissionsFor(students), 3, [], 0)
    const given = givenCounts(assignments)
    for (const s of students) {
      expect(given.get(s)).toBe(2)
    }
    for (const a of assignments) {
      expect(a.reviewerId).not.toBe(a.submissionStudentId)
    }
  })

  it('avoids repeat pairings across rounds when the class is large enough', () => {
    const students = roster(8)
    const round0 = assignPeerReviews(students, submissionsFor(students), 2, [], 0)
    const history = toHistory(round0)
    const round1 = assignPeerReviews(students, submissionsFor(students), 2, history, 1)

    const previousPairs = new Set(history.map((h) => `${h.reviewerId}->${h.revieweeId}`))
    const repeats = round1.filter((a) => previousPairs.has(`${a.reviewerId}->${a.submissionStudentId}`))
    expect(repeats).toHaveLength(0)
  })

  it('still produces balanced assignments when repeats are unavoidable', () => {
    const students = roster(3)
    // With 3 students at 2 reviews each, every possible pair is used every
    // round — round 2 must repeat, but must stay valid and balanced.
    const round0 = assignPeerReviews(students, submissionsFor(students), 2, [], 0)
    const round1 = assignPeerReviews(students, submissionsFor(students), 2, toHistory(round0), 1)
    expect(round1).toHaveLength(6)
    const counts = receivedCounts(round1)
    for (const s of students) {
      expect(counts.get(s)).toBe(2)
    }
    for (const a of round1) {
      expect(a.reviewerId).not.toBe(a.submissionStudentId)
    }
  })

  it('is deterministic for identical inputs', () => {
    const students = roster(9)
    const history = toHistory(assignPeerReviews(students, submissionsFor(students), 3, [], 0))
    const a = assignPeerReviews(students, submissionsFor(students), 3, history, 4)
    const b = assignPeerReviews(students, submissionsFor(students), 3, history, 4)
    expect(a).toEqual(b)
    // Input order must not matter either.
    const shuffled = [...students].reverse()
    const c = assignPeerReviews(shuffled, submissionsFor(students).reverse(), 3, history, 4)
    expect(c).toEqual(a)
  })

  it('varies pairings by round even with identical inputs', () => {
    const students = roster(6)
    const round0 = assignPeerReviews(students, submissionsFor(students), 1, [], 0)
    const round1 = assignPeerReviews(students, submissionsFor(students), 1, [], 1)
    expect(round0).not.toEqual(round1)
  })

  it('returns empty for degenerate inputs', () => {
    expect(assignPeerReviews([], [], 3, [], 0)).toEqual([])
    expect(assignPeerReviews(roster(4), [], 3, [], 0)).toEqual([])
    expect(assignPeerReviews(roster(4), submissionsFor(roster(4)), 0, [], 0)).toEqual([])
    // A single submitter reviewing alone has nothing eligible.
    expect(assignPeerReviews(['s01'], [{ studentId: 's01' }], 3, [], 0)).toEqual([])
  })
})
