// Cross-module tenancy conventions shared by the web app's server actions.
// Kept framework-agnostic (no supabase-js import) so packages/platform stays
// importable from both apps/web and apps/worker.

/**
 * Placeholder org_id sent on INSERT for any table whose org_id (and sometimes
 * location_id/class_id) is derived server-side by a scope-sync BEFORE trigger.
 * The column is NOT NULL, so a value must be present pre-trigger; the trigger
 * overwrites it with the real scope from the parent FK chain. Using one shared
 * constant means a mistyped UUID can't silently differ between modules.
 *
 * See the scope-sync trigger convention in docs/03 and any module migration
 * (e.g. cls_sync_from_class, sal_sync_from_location, mm_answers_before_write).
 */
export const DERIVED_SCOPE_PLACEHOLDER = '00000000-0000-0000-0000-000000000000'
