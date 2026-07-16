// Parses the shared synagogue-location form (synagogue-location-fields.tsx)
// into the org_modules.settings shape. Used by both the superadmin console
// action and the org-admin settings action so validation stays identical.
export function parseSynagogueSettingsForm(formData: FormData) {
  const latitude = Number(formData.get('latitude'))
  const longitude = Number(formData.get('longitude'))
  const timezone = String(formData.get('timezone') ?? '').trim()
  const myzmanimLocationId = String(formData.get('myzmanimLocationId') ?? '').trim()
  const israel = formData.get('israel') === 'on'
  if (!timezone || Number.isNaN(latitude) || Number.isNaN(longitude)) {
    throw new Error('Latitude, longitude, and timezone are required')
  }
  return { latitude, longitude, timezone, israel, myzmanimLocationId: myzmanimLocationId || null }
}
