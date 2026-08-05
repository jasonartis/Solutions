import { defineConfig } from '@playwright/test'

// E2E tests need the seeded local stack (pnpm dev once, pnpm seed).
// Locally: reuses your running dev server on :3000, or starts one.
// CI: runs the production build (`next start`) that the build step produced.
//
// TIMEOUTS ARE ENVIRONMENT-DEPENDENT ON PURPOSE (founder decision 2026-08-04).
// Three clean-seed full runs that day each lost exactly ONE test, a DIFFERENT one
// every time, always to the same cause: the LOCAL dev server compiles a route on
// first visit, so a click can stall for seconds while `next dev` builds the page.
// The failure moves between tests, which is what proves it environmental rather
// than a set of test bugs — and why per-test `test.slow()` patches were
// whack-a-mole. Two sub-shapes needed two different remedies:
//
//   * the ASSERTION after a navigation times out (the link is in the DOM, the
//     page just has not changed yet) — the per-assertion default is what bites,
//     and `test.slow()` cannot help because it raises the TEST timeout only.
//     Fixed by `expect.timeout` below.
//   * the `.click()` ACTION itself stalls to the test timeout — needs a longer
//     TEST budget, which is what the scoped `test.slow()` calls in the spec do.
//
// CI is deliberately left STRICTER, because CI is the judge: it serves a PREBUILT
// app (`pnpm start`), so no route is ever compiled mid-test and a slow assertion
// there means something is genuinely slow. Keeping CI's 5s expect default is what
// stops this from becoming a blanket "wait longer everywhere" that hides a real
// regression; the local relaxation only papers over `next dev`.
const LOCAL_DEV_SERVER = !process.env.CI

export default defineConfig({
  testDir: './e2e',
  timeout: LOCAL_DEV_SERVER ? 45_000 : 30_000,
  retries: process.env.CI ? 1 : 0,
  expect: {
    // Playwright's default is 5_000. Local only — see the note above.
    timeout: LOCAL_DEV_SERVER ? 15_000 : 5_000,
  },
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  webServer: {
    command: process.env.CI ? 'pnpm start' : 'pnpm dev',
    url: 'http://localhost:3000/login',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
