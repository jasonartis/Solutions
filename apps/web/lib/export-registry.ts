import type { ModuleExport } from '@platform/core'
import { classroomExport } from '@modules/classroom/ui/export'
import { sampleExport } from '@modules/sample/ui/export'

// Export manifests by module key (data-export primitive, docs/03). A module
// without a manifest simply doesn't appear on the export page yet — modules
// gain them incrementally.
export const exportRegistry: Record<string, ModuleExport> = {
  [classroomExport.moduleKey]: classroomExport,
  [sampleExport.moduleKey]: sampleExport,
}
