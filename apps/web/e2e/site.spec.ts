import { expect, test } from '@playwright/test'

// Public marketing page (docs/35). No sign-in needed: it is what a signed-out visitor who has
// never had an account session sees at `/`. SITE_E2E_BASE_URL lets a run point at another port.
test.use({ baseURL: process.env.SITE_E2E_BASE_URL || 'http://localhost:3000' })

test.describe('public marketing page', () => {
  test('signed-out / shows the page, makes no outside request, sets no cookie, breaks no CSP rule', async ({ page, context }) => {
    const origin = new URL(test.info().project.use.baseURL || process.env.SITE_E2E_BASE_URL || 'http://localhost:3000').origin
    const outside: string[] = []
    page.on('request', (r) => {
      const u = r.url()
      if (!u.startsWith(origin) && !u.startsWith('data:')) outside.push(u)
    })
    await page.addInitScript(() => {
      ;(window as unknown as { __csp: string[] }).__csp = []
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as unknown as { __csp: string[] }).__csp.push(e.violatedDirective + ' ' + e.blockedURI),
      )
    })
    await page.goto('/')
    await expect(page).toHaveURL(/\/$/) // the URL stays "/" (rewrite, not redirect)
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('#examples-grid > *').first()).toBeVisible() // the script ran under the CSP
    // Fonts really came from our own files.
    await page.evaluate(() => document.fonts.ready)
    expect(await page.evaluate(() => [...document.fonts].filter((f) => f.status === 'loaded').length)).toBeGreaterThan(0)
    expect(outside).toEqual([])
    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([])
    expect(await context.cookies()).toEqual([])
  })

  test('tick-box tally reacts, example arrows change the examples', async ({ page }) => {
    await page.goto('/')
    await expect(page.locator('#tally')).toHaveText('')
    await page.locator('label[for="s1"]').click()
    await expect(page.locator('#tally')).not.toHaveText('')
    const grid = page.locator('#examples-grid')
    const first = (await grid.textContent()) ?? ''
    await page.locator('#ex-next').click()
    await expect(grid).not.toHaveText(first)
    await page.locator('#ex-prev').click()
    await expect(grid).toHaveText(first)
  })

  test('"Client sign in" goes to /login — phone width shows the icon, not the words', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 })
    await page.goto('/')
    const link = page.locator('a.signin')
    await expect(link).toBeVisible()
    await expect(link.locator('.signin-icon')).toBeVisible()
    await expect(link.locator('.signin-text')).toBeHidden()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true) // no sideways scroll
    await link.click()
    await expect(page).toHaveURL(/\/login$/)
  })

  test('light and dark mode both render (background differs)', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    const light = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await page.emulateMedia({ colorScheme: 'dark' })
    const dark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(dark).not.toEqual(light)
  })

  test('a browser that has had an account session (sp_seen) goes straight to /login', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'sp_seen', value: '1', url: baseURL! }])
    await page.goto('/')
    await expect(page).toHaveURL(/\/login$/)
  })
})
