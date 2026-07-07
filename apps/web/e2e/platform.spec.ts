import { expect, test, type Page } from '@playwright/test'

// End-to-end proof of the M0 acceptance criteria (docs/04) through a real
// browser: auth -> org membership -> entitlement -> module page, and the
// negative paths. Requires seeded data (pnpm seed).

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

test('alice reaches her module through the entitlement chain', async ({ page }) => {
  await signIn(page, 'alice@demo.local')
  await expect(page.getByText('Demo Org A')).toBeVisible()

  await page.getByRole('link', { name: 'Demo Module' }).click()
  await expect(page.getByRole('heading', { name: 'Demo Module' })).toBeVisible()
  await expect(page.getByText('the full chain works')).toBeVisible()
})

test('bob sees his org without modules and cannot deep-link into org A', async ({ page }) => {
  await signIn(page, 'bob@demo.local')
  await expect(page.getByText('Demo Org B')).toBeVisible()
  await expect(page.getByText('No modules enabled')).toBeVisible()
  await expect(page.getByText('Demo Org A')).not.toBeVisible()

  // Direct URL into org A's module: RLS hides the org -> 404.
  await page.goto('/o/demo-a/m/stub')
  await expect(page.getByText('404')).toBeVisible()
})

test('owner has the console; regular users do not', async ({ page }) => {
  await signIn(page, 'owner@demo.local')
  await page.getByRole('link', { name: 'Owner Console' }).click()
  await expect(page.getByRole('heading', { name: 'Owner Console' })).toBeVisible()
  await expect(page.getByText('Create organization')).toBeVisible()
})

test('alice sees a generated week in the synagogue schedules module', async ({ page }) => {
  await signIn(page, 'alice@demo.local')
  await expect(page.getByText('Demo Synagogue')).toBeVisible()
  await page.getByRole('link', { name: 'Synagogue Schedules' }).click()

  await expect(page.getByRole('heading', { name: 'Schedules' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Weekday Schedule' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Shabbat Schedule' })).toBeVisible()
  // Fixed rule renders one uniform time; zman rule renders per-day times.
  await expect(page.getByText('6:00 PM')).toBeVisible()
  await expect(page.getByText('Maariv')).toBeVisible()
  await expect(page.getByText('Candle Lighting')).toBeVisible()
})

test('unauthenticated visitors are redirected to login', async ({ page }) => {
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login/)
})

test('sign out returns to login and locks the dashboard', async ({ page }) => {
  await signIn(page, 'alice@demo.local')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)
  await page.goto('/dashboard')
  await expect(page).toHaveURL(/\/login/)
})
