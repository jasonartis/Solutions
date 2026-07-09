// Module registry (docs/03). Every module package exports a manifest and is
// registered here. apps/web mounts nav/routes from this list, filtered by the
// org's entitlements (org_modules) and the user's module_roles.

export type ModuleManifest = {
  /** Stable key — matches org_modules.module_key and the mm_/cls_/… table prefix docs. */
  key: string
  name: string
  description: string
  /** Role vocabulary this module understands (module_roles.role values). */
  roles: readonly string[]
  /** Base path under /m/<key>; nav entries are relative to it. */
  nav: readonly { label: string; path: string }[]
}

export const stubModule: ModuleManifest = {
  key: 'stub',
  name: 'Demo Module',
  description: 'Proves entitlements end-to-end. Replaced by real modules.',
  roles: ['user', 'admin'],
  nav: [{ label: 'Home', path: '' }],
}

export const synagogueSchedulesModule: ModuleManifest = {
  key: 'synagogue-schedules',
  name: 'Synagogue Schedules',
  description: 'Zmanim-driven schedule builder with rules, overrides, and multi-format export.',
  roles: ['maker', 'viewer'],
  nav: [
    { label: 'Schedules', path: '' },
    { label: 'Setup', path: 'setup' },
  ],
}

export const classroomModule: ModuleManifest = {
  key: 'classroom',
  name: 'Classroom',
  description:
    'Course management: materials with timed visibility, homework submissions, peer review, structured gradebook.',
  roles: ['student', 'ga', 'professor'],
  nav: [
    { label: 'Classes', path: '' },
    { label: 'Manage', path: 'manage' },
  ],
}

export const matchmakingModule: ModuleManifest = {
  key: 'matchmaking',
  name: 'Make-a-Match',
  description:
    'Matchmaking via admin-defined weighted questions: care-weighted pair scoring, matchmaker-assisted introductions, and an approval workflow for new questions.',
  roles: ['single', 'matchmaker', 'admin'],
  nav: [{ label: 'Questions', path: '' }],
}

export const nailSalonModule: ModuleManifest = {
  key: 'nail-salon',
  name: 'Nail Salon',
  description:
    'Salon management: booking, in-appointment workflow, billing/receipts (record-keeping), promotions, and light bookkeeping (earnings, expenses, shopping lists). Org → locations from day one.',
  roles: ['admin', 'manager', 'cashier', 'worker', 'customer'],
  nav: [{ label: 'Salon', path: '' }],
}

export const speedDatingModule: ModuleManifest = {
  key: 'speed-dating',
  name: 'Speed Dating',
  description:
    'Live speed-dating events: timed video rounds with rotation, directional interest with privacy-preserving mutual reveal, safety reports, personal blocks.',
  roles: ['admin', 'organizer', 'host', 'participant'],
  nav: [{ label: 'Events', path: '' }],
}

// Module 0 — the living template (docs/03, modules/sample/SPEC.md). Kept in
// the registry so its e2e proves the copy-me path stays green.
export const sampleModule: ModuleManifest = {
  key: 'sample',
  name: 'Sample Module',
  description: 'The living template for new modules — copy modules/sample to start module 7+.',
  roles: ['manager', 'member'],
  nav: [{ label: 'Sample', path: '' }],
}

export const visualMessagingModule: ModuleManifest = {
  key: 'visual-messaging',
  name: 'Visual Messaging',
  description:
    'Visual conversations: a thread starts with a picture; every reply is a drawn layer on the layer it answers. Tree navigation, moderation with tombstones, org or ad-hoc groups.',
  roles: ['admin', 'moderator', 'member'],
  nav: [{ label: 'Conversations', path: '' }],
}

const allModules: readonly ModuleManifest[] = [
  stubModule,
  synagogueSchedulesModule,
  classroomModule,
  matchmakingModule,
  nailSalonModule,
  speedDatingModule,
  sampleModule,
  visualMessagingModule,
]

// Plug-and-play composition (founder decision, docs/03): the MODULES env var
// (comma-separated keys) filters which modules a deployment contains — for a
// future isolated white-label instance ("an app with only module 3") without
// forking the codebase. Unset = all modules (the normal platform deployment).
// Unknown keys fail loudly: a typo must not silently ship an empty app.
function filterByEnv(modules: readonly ModuleManifest[]): readonly ModuleManifest[] {
  const raw = process.env.MODULES ?? process.env.NEXT_PUBLIC_MODULES
  if (!raw || raw.trim() === '') return modules
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const known = new Set(modules.map((m) => m.key))
  for (const key of wanted) {
    if (!known.has(key)) throw new Error(`MODULES lists unknown module key: ${key}`)
  }
  return modules.filter((m) => wanted.includes(m.key))
}

export const moduleRegistry: readonly ModuleManifest[] = filterByEnv(allModules)

export function getModule(key: string): ModuleManifest | undefined {
  return moduleRegistry.find((m) => m.key === key)
}
