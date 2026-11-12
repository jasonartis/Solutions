import { expect, test } from '@playwright/test'
import { buildOverview, formatBytes, summarizeStorage } from '../lib/console-overview'

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

// SIZES (20261115010000): summarizeStorage attributes each table/bucket row to a module by prefix,
// to its org when it has one, and nothing is counted twice or dropped.
test('overview sizes: bytes land on the right org, module and pair, and add up', () => {
  const s = summarizeStorage([
    { kind: 'database', name: 'postgres', org_id: null, item_count: null, bytes: 10_000 },
    { kind: 'table', name: 'cls_grades', org_id: 'o1', item_count: 3, bytes: 300 },
    { kind: 'table', name: 'cls_grades', org_id: 'o2', item_count: 1, bytes: 100 },
    { kind: 'table', name: 'org_members', org_id: 'o1', item_count: 2, bytes: 50 }, // platform table, o1
    { kind: 'table', name: 'profiles', org_id: null, item_count: 9, bytes: 500 }, // platform, nobody's
    { kind: 'bucket', name: 'vm-images', org_id: 'o1', item_count: 2, bytes: 2_000 },
    { kind: 'bucket', name: 'vm-images', org_id: null, item_count: 1, bytes: 7 }, // outside an org folder
    { kind: 'bucket', name: 'new-bucket', org_id: 'o2', item_count: 1, bytes: 5 }, // not mapped yet
  ])
  expect(s.databaseBytes).toBe(10_000)
  expect(s.tableBytes).toBe(950)
  expect(s.systemBytes).toBe(9_050)
  expect(s.fileBytes).toBe(2_012)
  expect(s.byPair.get('o1|classroom')).toEqual({ db: 300, files: 0 })
  expect(s.byPair.get('o1|visual-messaging')).toEqual({ db: 0, files: 2_000 })
  expect(s.byOrg.get('o1')).toEqual({ db: 350, files: 2_000 }) // includes its share of org_members
  expect(s.byOrg.get('o2')).toEqual({ db: 100, files: 5 })
  expect(s.byModule.get('classroom')).toEqual({ db: 400, files: 0 })
  expect(s.platformOrgBytes).toBe(50)
  expect(s.unattributed).toEqual({ db: 500, files: 7 })
  expect(s.unmappedBuckets).toEqual(['new-bucket'])
  // Conservation: every table byte is in exactly one of org / unattributed.
  const orgDb = [...s.byOrg.values()].reduce((n, b) => n + b.db, 0)
  expect(orgDb + s.unattributed.db).toBe(s.tableBytes)

  const sized = buildOverview({
    orgs: [{ id: 'o1', name: 'Alpha', slug: 'a' }],
    members: [],
    entitlements: [{ org_id: 'o1', module_key: 'classroom', enabled: true }],
    moduleRoles: [],
    names: new Map(),
    modules: [{ key: 'classroom', name: 'Classroom' }, { key: 'visual-messaging', name: 'VM' }],
    storage: s,
  })
  // The org's own size counts visual-messaging even though that module is OFF for it.
  expect(sized.byOrg[0]!.bytes).toEqual({ db: 350, files: 2_000 })
  expect(sized.byOrg[0]!.modules.map((m) => m.bytes)).toEqual([{ db: 300, files: 0 }])
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(512)).toBe('512 bytes')
})
