# 35 — Public marketing page (hosted on the platform)

**Status: BUILT locally 2026-11-26, not yet deployed (founder reviews first).** No migration, no database, no RLS.

## Decision: a platform route, not a module and not a new concept
A module is per-client (tables with `org_id`, RLS, entitlement). This page has no data, no tenant, no entitlement. It is
one more unauthenticated **platform** route, like `/privacy`, `/report`, `/login` (and module 3's `/s/<org>`). No new
"public pages" concept is introduced.

## Where the copy lives — the master is NOT in this repo
The editable master is in the founder's private Customers folder (`D:\Solutions Platform - Customers\website`).
**This repo holds only a copy of two things** (that folder's `HANDOFF.md` is the contract):

| Here | Copied from there | Notes |
|---|---|---|
| `apps/web/site-source/template.html` | `website/template.html` | **Never edit wording here** — edit in the source folder, then sync |
| `apps/web/public/site-fonts/*.woff2`, `README.txt` | `website/fonts/` | OFL fonts, served from our own domain (no Google Fonts) |

Never copy anything else from that folder (`.env`, the built `index.html`, `personal/` photo, any `.md`): this repo is public.
**Pick up the latest:** `pnpm site:sync` (optionally a path) — an allowlist copier (`scripts/site-sync.mts`) that never
writes to the source folder and prints what changed; then review `git diff` and commit. If the contract (placeholders)
changes, `packages/db/src/marketing-site.test.ts` fails and `packages/platform/src/marketing-site.ts` is updated to match.

## How it is served
- **Signed-out `GET /`**: `proxy.ts` rewrites to `app/site/route.ts` (URL stays `/`) — UNLESS the browser carries the
  `sp_seen=1` marker, in which case the old behaviour stands (→ `/login`). **Signed-in `/`** → `/dashboard` as before.
- **`sp_seen`** (founder 2026-11-26: "people who have signed in before go to login; if we are not sure, the new page"):
  set by `proxy.ts` only when a request is actually signed in; httpOnly, 2 years, value `1`, no identity. The marketing page
  itself sets NO cookie (e2e asserts it). Cleared cookies / a new browser → marketing page (the "not sure" case).
- **The installed Home Screen app opens `/login`** (`manifest.ts` `start_url`).
- A route handler returns the whole HTML document, so the app's root layout (fonts, boot script) is not involved.
  `lib`-free fill logic: `packages/platform/src/marketing-site.ts` (a reimplementation of the source folder's `build.py`).

## Environment values (Vercel + `.env.local`; read per request, no rebuild)
`BUSINESS_NAME` (default "Software Solutions"), `CONTACT_PHONE`, `CONTACT_WHATSAPP`, `CONTACT_EMAIL`, `LINKEDIN_URL`.
An empty value renders nothing, not even a label. Deliberately separate from `NEXT_PUBLIC_PLATFORM_*` (privacy/report pages).
`{{SIGNIN_LINK}}` is built in code → `/login`. `{{PHOTO}}` is empty (founder 2026-11-26: launch without a photo; the NYU
faculty page photo was NOT used — hotlinking is an outside request and its rights are unclear; add a photo he owns later).

## No outside requests — enforced
No analytics, tracking, cookies, forms or third-party scripts/fonts (that is what keeps the page free of a privacy-policy
requirement — adding any of them needs the founder). The route sends a CSP allowing only the page's own inline `<style>` and
`<script>` (by SHA-256 hash, computed per response), `font-src 'self'`, `img-src 'self' data:`, `connect-src 'none'`,
`form-action 'none'`. `e2e/site.spec.ts` asserts zero outside requests and zero CSP violations.

## Tests
`packages/db/src/marketing-site.test.ts` (contract, escaping, empty values, no external loads) and `apps/web/e2e/site.spec.ts`
(page, tally, example arrows, phone width, dark mode, `/login` link, `sp_seen`).
