import type { ModuleHelp } from '@platform/core'
import { classroomHelp } from '@modules/classroom/help/guides'
import { sampleHelp } from '@modules/sample/help/guides'

// Walkthrough guides by module key (docs/03 user-walkthrough decision).
// Modules gain guides incrementally; a module without an entry simply
// doesn't appear on the Help index yet.
export const helpRegistry: Record<string, ModuleHelp> = {
  [classroomHelp.moduleKey]: classroomHelp,
  [sampleHelp.moduleKey]: sampleHelp,
}
