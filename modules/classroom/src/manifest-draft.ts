// DRAFT manifest for module 2 (classroom). At integration time this object is
// registered in packages/platform/src/modules.ts (added to `moduleRegistry`,
// same as `synagogueSchedulesModule`) — it satisfies the `ModuleManifest`
// shape defined there. Kept dependency-free here so the draft stands alone.

export const classroomModule = {
  key: 'classroom',
  name: 'Classroom',
  description:
    'Online classroom: courses published into term classes with homework submission, GA + anonymous peer review, structured gradebook, exams, announcements, and surveys.',
  roles: ['student', 'ga', 'professor'],
  nav: [
    { label: 'Classes', path: '' },
    { label: 'Manage', path: 'manage' },
  ],
} as const
