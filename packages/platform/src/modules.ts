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

export const moduleRegistry: readonly ModuleManifest[] = [stubModule]

export function getModule(key: string): ModuleManifest | undefined {
  return moduleRegistry.find((m) => m.key === key)
}
