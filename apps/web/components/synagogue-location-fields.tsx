// Synagogue location fields (lat/long/timezone/israel/myzmanim id), shared by
// the superadmin Owner Console and the org-admin Settings page so a label or
// tooltip change updates both (founder reuse rule, 2026-07-12). Render inside
// a <form> that supplies its own action + submit button.
export type SynagogueSettings = {
  latitude?: number
  longitude?: number
  timezone?: string
  israel?: boolean
  myzmanimLocationId?: string | null
}

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'

export default function SynagogueLocationFields({ settings }: { settings: SynagogueSettings | undefined }) {
  return (
    <>
      <label className="text-xs text-gray-500">
        Latitude
        <input
          name="latitude"
          type="number"
          step="any"
          required
          defaultValue={settings?.latitude}
          className={`${inputCls} block w-28`}
        />
      </label>
      <label className="text-xs text-gray-500">
        Longitude
        <input
          name="longitude"
          type="number"
          step="any"
          required
          defaultValue={settings?.longitude}
          className={`${inputCls} block w-28`}
        />
      </label>
      <label className="text-xs text-gray-500">
        Timezone
        <input
          name="timezone"
          required
          defaultValue={settings?.timezone}
          placeholder="America/New_York"
          className={`${inputCls} block w-40`}
        />
      </label>
      <label className="text-xs text-gray-500">
        myzmanim location ID
        <input
          name="myzmanimLocationId"
          defaultValue={settings?.myzmanimLocationId ?? ''}
          placeholder="US11210"
          className={`${inputCls} block w-32`}
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-gray-500">
        <input type="checkbox" name="israel" defaultChecked={settings?.israel === true} />
        In Israel
      </label>
    </>
  )
}
