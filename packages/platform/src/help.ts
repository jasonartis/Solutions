// In-app walkthroughs (founder decision, docs/03): every module ships
// role-level, numbered, click-by-click guides a user can follow to learn
// their level of the platform. Rendered at /o/<slug>/help; each module's
// guides live in modules/<key>/help/guides.ts (typed strings, not fs reads —
// deployment-safe on Vercel and type-checked).
//
// Visibility rule ("each level sees their level and below"): module staff
// (module_can_manage) see every guide including staff guides; everyone else
// sees only the non-staff guides.
//
// UPDATE RULE (docs/03): a UI change updates the module's walkthrough in the
// same commit — stale user docs are bugs.

export type HelpGuide = {
  /** module role this guide teaches (display only) */
  role: string
  title: string
  /** staff guides are hidden from non-staff members */
  staff?: boolean
  /** markdown: numbered click-by-click steps */
  body: string
}

export type ModuleHelp = {
  moduleKey: string
  guides: readonly HelpGuide[]
}
