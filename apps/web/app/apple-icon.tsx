import { ImageResponse } from 'next/og'

// The Home Screen icon on iPhones/iPads ("Add to Home Screen"), 2026-11-18.
// Drawn in code so there is no image file to keep: a blue square with "SP".
// iOS rounds the corners itself, so the square is drawn edge to edge.
// To change the look, edit the colours/text below; app/icon.tsx is the same
// picture at the larger size Android and the manifest use.
export const size = { width: 180, height: 180 }
export const contentType = 'image/png'

export default function AppleIcon() {
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
          fontSize: 84,
          fontWeight: 700,
          letterSpacing: -2,
        }}
      >
        SP
      </div>
    ),
    size,
  )
}
