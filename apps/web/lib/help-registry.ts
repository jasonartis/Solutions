import type { ModuleHelp } from '@platform/core'
import { classroomHelp } from '@modules/classroom/help/guides'
import { matchmakingHelp } from '@modules/matchmaking/help/guides'
import { nailSalonHelp } from '@modules/nail-salon/help/guides'
import { sampleHelp } from '@modules/sample/help/guides'
import { speedDatingHelp } from '@modules/speed-dating/help/guides'
import { synagogueSchedulesHelp } from '@modules/synagogue-schedules/help/guides'

// Walkthrough guides by module key (docs/03 user-walkthrough decision).
// Every real module carries a set; module 4 gains one with its UI.
export const helpRegistry: Record<string, ModuleHelp> = {
  [classroomHelp.moduleKey]: classroomHelp,
  [matchmakingHelp.moduleKey]: matchmakingHelp,
  [nailSalonHelp.moduleKey]: nailSalonHelp,
  [sampleHelp.moduleKey]: sampleHelp,
  [speedDatingHelp.moduleKey]: speedDatingHelp,
  [synagogueSchedulesHelp.moduleKey]: synagogueSchedulesHelp,
}
