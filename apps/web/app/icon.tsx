import { ImageResponse } from 'next/og'

// The same "SP" icon as app/apple-icon.tsx, at 512 px for Android's
// "Install app" / Home Screen and the web app manifest (app/manifest.ts).
// Browsers may also pick it over app/favicon.ico for the tab icon.
export const size = { width: 512, height: 512 }
export const contentType = 'image/png'

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#2563eb',
          color: 'white',
          fontSize: 240,
          fontWeight: 700,
          letterSpacing: -6,
        }}
      >
        SP
      </div>
    ),
    size,
  )
}
