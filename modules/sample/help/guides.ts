// TEMPLATE (module 0): the walkthrough set is part of module anatomy
// (docs/03 user-walkthrough decision). One guide per role; staff guides are
// hidden from members. UPDATE RULE: a UI change updates the matching steps
// in the same commit.
import type { ModuleHelp } from '@platform/core'

export const sampleHelp: ModuleHelp = {
  moduleKey: 'sample',
  guides: [
    {
      role: 'member',
      title: 'Member — add and complete items',
      body: `
1. From the Dashboard, click **Sample Module** on your organization's card.
2. Under any project, type into **Add an item…** and click **Add**.
3. Click **Done** next to an item to complete it (or **Reopen** to undo).
`,
    },
    {
      role: 'manager',
      title: 'Manager — create projects',
      staff: true,
      body: `
1. Open **Sample Module**. Managers see the **New project name** form at the
   top — type a name and click **Create project**.
2. Click **Delete project** next to a project's name to remove it (and its
   items) for good — there's no undo, so double-check the name first.
3. Everything members can do (add/toggle items) works for you too.
`,
    },
  ],
}
