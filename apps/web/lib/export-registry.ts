import type { ModuleExport } from '@platform/core'
import { classroomExport } from '@modules/classroom/ui/export'
import { matchmakingExport } from '@modules/matchmaking/ui/export'
import { nailSalonExport } from '@modules/nail-salon/ui/export'
import { sampleExport } from '@modules/sample/ui/export'
import { speedDatingExport } from '@modules/speed-dating/ui/export'
import { synagogueSchedulesExport } from '@modules/synagogue-schedules/ui/export'

// Export manifests by module key (data-export primitive, docs/03). Every
// real module carries one; the sample module's doubles as the template.
export const exportRegistry: Record<string, ModuleExport> = {
  [classroomExport.moduleKey]: classroomExport,
  [matchmakingExport.moduleKey]: matchmakingExport,
  [nailSalonExport.moduleKey]: nailSalonExport,
  [sampleExport.moduleKey]: sampleExport,
  [speedDatingExport.moduleKey]: speedDatingExport,
  [synagogueSchedulesExport.moduleKey]: synagogueSchedulesExport,
}
