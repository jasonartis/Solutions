import {
  type VisualMessagingSettings,
  VM_STAMP_FRACTION_DEFAULT,
  VM_STAMP_OPACITY_DEFAULT,
} from '@/lib/visual-messaging-settings'

// Image-stamp guard fields, shared shape with synagogue-location-fields.tsx:
// render inside a <form> that supplies its own action + submit button.
// Percent units in the UI; the settings themselves store fractions (0-1).
const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

export default function VisualMessagingGuardFields({ settings }: { settings: VisualMessagingSettings | undefined }) {
  const sizePercent = Math.round((settings?.imageStampMaxFraction ?? VM_STAMP_FRACTION_DEFAULT) * 100)
  const opacityPercent = Math.round((settings?.imageStampOpacity ?? VM_STAMP_OPACITY_DEFAULT) * 100)
  return (
    <>
      <label className="text-xs text-gray-500">
        Max image-stamp size (% of picture width)
        <input
          name="imageStampMaxSizePercent"
          type="number"
          min={5}
          max={100}
          required
          defaultValue={sizePercent}
          className={`${inputCls} block w-24`}
        />
      </label>
      <label className="text-xs text-gray-500">
        Image-stamp opacity (%)
        <input
          name="imageStampOpacityPercent"
          type="number"
          min={10}
          max={100}
          required
          defaultValue={opacityPercent}
          className={`${inputCls} block w-24`}
        />
      </label>
    </>
  )
}
