// Data-export primitive (founder decision, docs/03): every user can export
// what they can see, choosing a "hat" (access level they hold). Modules
// declare a manifest of human-named data sets; the generic engine
// (/o/<slug>/export) renders hats + checkboxes and streams a zip of CSV+JSON.
//
// Framework-agnostic types only — fetch implementations live in each module's
// ui folder and receive the caller's RLS-scoped Supabase client, so an export
// can never contain more than the user can already read on screen.

/** Minimal structural view of the Supabase client (keeps this package free of the dependency). */
export type ExportDb = {
  from: (table: string) => any
  rpc: (fn: string, args?: Record<string, unknown>) => any
}

export type ExportContext = {
  orgId: string
  userId: string
}

export type ExportRow = Record<string, unknown>

export type ExportDataSet = {
  /** Stable key — becomes the file name inside the zip (<key>.csv / <key>.json). */
  key: string
  label: string
  description?: string
  /** Which hats include this set (hat keys from the module's ModuleExport.hats). */
  hats: readonly string[]
  /** Runs AS the user under RLS. Shape each row flat (CSV-friendly). */
  fetch: (db: ExportDb, ctx: ExportContext) => Promise<ExportRow[]>
}

export type ExportHat = {
  key: string
  label: string
}

export type ModuleExport = {
  moduleKey: string
  /** All hats this module knows, highest access first. */
  hats: readonly ExportHat[]
  /** Which of those hats the caller holds (highest first), computed via the module's rpc helpers. */
  myHats: (db: ExportDb, ctx: ExportContext) => Promise<string[]>
  dataSets: readonly ExportDataSet[]
}
