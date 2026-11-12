import { expect, test } from '@playwright/test'
import { buildOverview } from '../lib/console-overview'

// The Owner Console Overview's COUNTING RULES (`lib/console-overview.ts`, founder 2026-11-10),
// checked on a tiny made-up platform with no database or browser. Kept as a test because the
// numbers are easy to get subtly wrong and the page cannot tell you they are:
//   - only ACTIVE members count; pending invitations are counted apart, never in a headcount;
//   - a person in two orgs is ONE person platform-wide and ONE person in a module both orgs use,
//     but appears under each org;
//   - a module counts only for orgs that have it ON;
//   - a role holder who is not an active member does not count as a role holder;
//   - a null membership status means active; no display name reads "Unnamed member".
// (Playwright runs it with the e2e suite; it needs no page.)
const overview = buildOverview({
  orgs: [
    { id: 'o1', name: 'Alpha', slug: 'a' },
    { id: 'o2', name: 'Beta', slug: 'b' },
  ],
  members: [
    { org_id: 'o1', user_id: 'u1', status: 'active' },
    { org_id: 'o1', user_id: 'u2', status: 'active' },
    { org_id: 'o1', user_id: 'u3', status: 'pending' },
    { org_id: 'o2', user_id: 'u1', status: 'active' }, // u1 is in BOTH orgs
    { org_id: 'o2', user_id: 'u4', status: null }, // null status = active
  ],
  entitlements: [
    { org_id: 'o1', module_key: 'm', enabled: true },
    { org_id: 'o2', module_key: 'm', enabled: true },
    { org_id: 'o2', module_key: 'x', enabled: false },
  ],
  moduleRoles: [
    { org_id: 'o1', user_id: 'u1', module_key: 'm' },
    { org_id: 'o1', user_id: 'u3', module_key: 'm' }, // pending: must not count as a role holder
  ],
  names: new Map([['u1', 'Una']]),
  modules: [
    { key: 'm', name: 'Mod' },
    { key: 'x', name: 'Off' },
  ],
  records: new Map([['o1|m', 7]]),
})

test('overview counting: totals count each active person once and keep pending apart', () => {
  expect(overview.orgCount).toBe(2)
  expect(overview.distinctPeople).toBe(3) // u1, u2, u4 — u1 once, u3 pending
  expect(overview.pendingInvites).toBe(1)
})

test('overview counting: a module counts distinct people across the orgs that have it on', () => {
  const m = overview.byModule.find((x) => x.key === 'm')!
  expect(m.distinctPeople).toBe(3) // u1 in two orgs counts once
  expect(m.orgs.map((o) => `${o.orgName}:${o.people.length}`)).toEqual(['Alpha:2', 'Beta:2']) // but appears under both
  expect(m.orgs[0]!.roleHolders).toBe(1) // u3 holds a role but is pending
  expect(overview.byModule.find((x) => x.key === 'x')!.orgs).toHaveLength(0) // off everywhere
})

test('overview counting: an org lists only the modules switched on; unnamed people read as such', () => {
  const beta = overview.byOrg.find((o) => o.name === 'Beta')!
  expect(beta.modules.map((x) => x.moduleKey)).toEqual(['m'])
  expect(beta.people.some((p) => p.name === 'Unnamed member')).toBe(true)
})

test('overview counting: records are summed per org and per module, and are 0 when not scanned', () => {
  expect(overview.byOrg.find((o) => o.name === 'Alpha')!.records).toBe(7)
  expect(overview.byModule.find((x) => x.key === 'm')!.records).toBe(7)
  const unscanned = buildOverview({
    orgs: [{ id: 'o1', name: 'Alpha', slug: 'a' }],
    members: [],
    entitlements: [{ org_id: 'o1', module_key: 'm', enabled: true }],
    moduleRoles: [],
    names: new Map(),
    modules: [{ key: 'm', name: 'Mod' }],
  })
  expect(unscanned.recordsScan.included).toBe(false)
  expect(unscanned.byOrg[0]!.records).toBe(0)
})
