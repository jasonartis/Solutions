import { expect, test, type Page } from '@playwright/test'

// The Owner Console Overview shows real sizes (migration 20261115010000,
// platform_storage_usage()): database and file totals, a "≈" size beside each
// "records" count, and the note saying the sizes are an estimate. The size
// reading failing must SAY so, never show 0 — so the failure text must be absent.

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

test('the superadmin sees estimated sizes per organization and module', async ({ page }) => {
  await signIn(page, 'owner@demo.local')
  await page.goto('/console/overview')
  await expect(page.getByRole('heading', { name: 'Platform overview' })).toBeVisible()

  const totals = page.getByTestId('overview-storage-totals')
  await expect(totals).toContainText(/Database \d+(\.\d)? (KB|MB|GB) in all/)
  await expect(totals).toContainText('uploaded files')

  // Every org row and every module row carries a size chip (closed <details>
  // still render their summaries).
  const orgs = page.getByTestId('overview-org')
  const orgCount = await orgs.count()
  expect(orgCount).toBeGreaterThan(1)
  await expect(page.getByTestId('overview-by-org').locator('> details > summary [data-testid="overview-size"]')).toHaveCount(orgCount)
  const mods = await page.getByTestId('overview-module').count()
  await expect(page.getByTestId('overview-by-module').locator('> details > summary [data-testid="overview-size"]')).toHaveCount(mods)

  const note = page.getByTestId('overview-size-note')
  await expect(note).toContainText('Sizes (≈) are an estimate.')
  await expect(note).not.toContainText('The size reading failed')
})
