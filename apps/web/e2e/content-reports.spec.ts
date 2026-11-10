import { expect, test, type Page } from '@playwright/test'

// The public Report content route end to end (module-9 spec §B1/§H(c)):
// a visitor who is NOT signed in sends an intimate-image report (signature and
// good-faith statement required), and the superadmin finds it in the console
// queue and closes it. Requires seeded data and the local intake token
// (scripts/set-content-report-token.mts --local; CI runs it after the seed).

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

test('a signed-out visitor reports content and the superadmin closes it', async ({ page }) => {
  const where = `e2e report ${Date.now()}`

  await page.goto('/')
  await page.getByRole('link', { name: 'Report content' }).click()
  await expect(page.getByRole('heading', { name: 'Report content' })).toBeVisible()

  await page.getByLabel('Where did you see it?').fill(where)
  await page.getByLabel('Reason').selectOption('intimate')
  await page.getByLabel('Your email').fill('e2e-reporter@example.test')
  await page.getByLabel("The information I've given is accurate").check()

  // Unsigned: the browser's own required-field check stops it, so nothing is sent.
  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(page.getByText('Thank you. We review every report.')).toHaveCount(0)

  await page.getByLabel('Signature').fill('Erin Example')
  await expect(page.getByText(/Signed electronically/)).toBeVisible()
  await page.getByLabel(/I believe in good faith/).check()
  await page.getByRole('button', { name: 'Send report' }).click()
  await expect(page.getByText('Thank you. We review every report.')).toBeVisible({ timeout: 15000 })

  await signIn(page, 'owner@demo.local')
  await page.goto('/console/reports')
  const card = page.locator('li').filter({ hasText: where })
  await expect(card).toBeVisible()
  await expect(card.getByText('Intimate or sexual image')).toBeVisible()
  await expect(card.getByText('Erin Example')).toBeVisible()
  await card.getByLabel('Status').selectOption('actioned')
  await card.getByRole('button', { name: 'Save' }).click()
  // Closing it moves it off the Open list as the page refreshes.
  await expect(page.locator('li').filter({ hasText: where })).toHaveCount(0, { timeout: 15000 })
  await page.getByRole('link', { name: 'Closed' }).click()
  await expect(page.locator('li').filter({ hasText: where })).toBeVisible()
})
