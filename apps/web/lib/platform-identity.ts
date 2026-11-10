// Platform identity — the ONE place the app reads who runs the platform and how
// to reach them. Every page and check imports from here; nothing else reads the
// environment variables.
//
// The VALUES live outside the repo (the repo is public): on Vercel as
// NEXT_PUBLIC_PLATFORM_CONTACT_EMAIL / NEXT_PUBLIC_PLATFORM_COMPANY_NAME, and
// locally in .env.deploy as PLATFORM_CONTACT_EMAIL / PLATFORM_COMPANY_NAME
// (scripts/dev.ts copies them into apps/web/.env.local).
//
// TO CHANGE ONE: edit the variable on Vercel (Project → Settings → Environment
// Variables) and redeploy. NEXT_PUBLIC_ values are baked in at build time, so the
// change shows up after the next deploy, everywhere at once.

/** The address people are told to write to (privacy page, Report content page). Null when unset. */
export const PLATFORM_CONTACT_EMAIL: string | null = process.env.NEXT_PUBLIC_PLATFORM_CONTACT_EMAIL || null

/** The company that provides the platform (terms). Null when unset. */
export const PLATFORM_COMPANY_NAME: string | null = process.env.NEXT_PUBLIC_PLATFORM_COMPANY_NAME || null
