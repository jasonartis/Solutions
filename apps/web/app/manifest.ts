import type { MetadataRoute } from 'next'

// Web app manifest (2026-11-18): what a phone uses when the site is added to
// the Home Screen. display 'standalone' = it opens full-screen like an app,
// without the browser's address bar. Icons are drawn in app/icon.tsx and
// app/apple-icon.tsx.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Solutions Platform',
    short_name: 'Solutions',
    // /login, not /: signed-out visitors to / see the public marketing page (docs/35);
    // the installed app is for people who already have an account.
    start_url: '/login',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icon', sizes: '512x512', type: 'image/png' },
      { src: '/apple-icon', sizes: '180x180', type: 'image/png' },
    ],
  }
}
