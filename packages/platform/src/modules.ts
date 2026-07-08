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

export const moduleRegistry: readonly ModuleManifest[] = [
  stubModule,
  synagogueSchedulesModule,
  classroomModule,
  matchmakingModule,
]

export function getModule(key: string): ModuleManifest | undefined {
  return moduleRegistry.find((m) => m.key === key)
}
