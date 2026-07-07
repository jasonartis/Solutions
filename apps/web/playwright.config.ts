import { defineConfig } from '@playwright/test'

// E2E tests need the seeded local stack (pnpm dev once, pnpm seed).
// Locally: reuses your running dev server on :3000, or starts one.
// CI: runs the production build (`next start`) that the build step produced.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
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
