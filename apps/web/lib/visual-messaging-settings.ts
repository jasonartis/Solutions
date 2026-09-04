// Parses/resolves the visual-messaging image-stamp guards (spec: "default max
// stamp size relative to canvas (admin/org-tunable)" + "default slight
// transparency"). Mirrors synagogue-settings.ts: plain validation, no schema
// lib, since apps/web carries no zod dependency. Stored in org_modules.settings
// as fractions (0-1); the settings form works in the friendlier percent units.
export type VisualMessagingSettings = {
  imageStampMaxFraction?: number
  imageStampOpacity?: number
}

export const VM_STAMP_FRACTION_DEFAULT = 0.3
export const VM_STAMP_OPACITY_DEFAULT = 0.85
const FRACTION_RANGE = { min: 0.05, max: 1 }
const OPACITY_RANGE = { min: 0.1, max: 1 }

// Read site: docs/03 rule #7 (Zod-validated JSON parsed at every read site
// with safeParse + skip-on-invalid) — no zod here, but the same discipline:
// an out-of-range or missing value falls back to the default rather than
// breaking the canvas.
export function resolveVisualMessagingSettings(settings: VisualMessagingSettings | null | undefined) {
  const fraction = settings?.imageStampMaxFraction
  const opacity = settings?.imageStampOpacity
  return {
    imageStampMaxFraction:
      typeof fraction === 'number' && fraction >= FRACTION_RANGE.min && fraction <= FRACTION_RANGE.max
        ? fraction
        : VM_STAMP_FRACTION_DEFAULT,
    imageStampOpacity:
      typeof opacity === 'number' && opacity >= OPACITY_RANGE.min && opacity <= OPACITY_RANGE.max
        ? opacity
        : VM_STAMP_OPACITY_DEFAULT,
  }
}

export function parseVisualMessagingSettingsForm(formData: FormData): VisualMessagingSettings {
  const sizePercent = Number(formData.get('imageStampMaxSizePercent'))
  const opacityPercent = Number(formData.get('imageStampOpacityPercent'))
  const minSize = FRACTION_RANGE.min * 100
  const maxSize = FRACTION_RANGE.max * 100
  const minOpacity = OPACITY_RANGE.min * 100
  const maxOpacity = OPACITY_RANGE.max * 100
  if (Number.isNaN(sizePercent) || sizePercent < minSize || sizePercent > maxSize) {
    throw new Error(`Stamp size must be ${minSize}-${maxSize}%`)
  }
  if (Number.isNaN(opacityPercent) || opacityPercent < minOpacity || opacityPercent > maxOpacity) {
    throw new Error(`Stamp opacity must be ${minOpacity}-${maxOpacity}%`)
  }
  return { imageStampMaxFraction: sizePercent / 100, imageStampOpacity: opacityPercent / 100 }
}
