import { expect, test, type Browser, type Page } from '@playwright/test'

// STAFF "VIEW AS" — the real screen for org staff, trimmed to their area
// (docs/13 "STAFF VIEW AS"; migration 20261127010000; founder answers 2026-11-26).
// It replaced the table-style in-module view-as (whose e2e tests were retired
// from platform.spec.ts the same day).
//
// The same no-drift rule as real-view-as.spec.ts: inside the viewer's area the
// SAME components render the person's screen, so <main> must be IDENTICAL to the
// person's own (each page re-taken up to 3 times, because other e2e files change
// the seed in parallel). The database proves the trimming row by row
// (packages/db/src/view-as-staff*.test.ts); this proves the screens and the frame.
//
// NEVER sign in as grace@demo.local here (the engagement e2e asserts she never has).

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

async function mainHtml(page: Page): Promise<string> {
  const html = await page.locator('main').innerHTML()
  return html
    .replace(/token=[^"&]+/g, 'token=X')
    .replace(/(?:<input type="hidden" name="\$ACTION_[^>]*>)+/g, (run) =>
      (run.match(/<input [^>]*>/g) ?? [])
        .map((i) => i.replace(/\$ACTION_REF_\d+/, '$ACTION_REF').replace(/\$ACTION_\d+:/, '$ACTION_:'))
        .sort()
        .join(''),
    )
}

function expectSameScreen(viewed: string, own: string, what: string) {
  if (viewed === own) return
  let i = 0
  while (i < viewed.length && viewed[i] === own[i]) i++
  const at = (s: string) => s.slice(Math.max(0, i - 120), i + 200)
  expect({ what, viewed: at(viewed) }).toEqual({ what, viewed: at(own) })
}

/** Renders `path` as the viewer, then at once as the person; equal within 3 tries. */
async function compare(viewer: Page, person: Page, path: string, mustContain: string) {
  let viewed = ''
  let own = ''
  for (let i = 0; i < 3; i++) {
    await viewer.goto(path)
    await expect(viewer.locator('main')).toContainText(mustContain)
    viewed = await mainHtml(viewer)
    await person.goto(path)
    own = await mainHtml(person)
    if (viewed === own) break
  }
  expectSameScreen(viewed, own, path)
}

async function context(browser: Browser, email: string) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await signIn(page, email)
  return { ctx, page }
}

const HOME = '/o/demo-a/m/classroom'

test('staff view as: a professor sees exactly what her student sees in her module, read-only, and nothing outside it', async ({ browser }) => {
  test.slow()
  const charlie = await context(browser, 'charlie@demo.local')
  await charlie.page.goto(HOME)
  await expect(charlie.page.locator('main')).toContainText('Statistics 101')
  // A student has no "View as" link, and the picker lists nobody for him.
  await expect(charlie.page.getByRole('link', { name: 'View as' })).toHaveCount(0)
  const homeworkHref = await charlie.page.locator(`main a[href^="${HOME}/homework/"]`).first().getAttribute('href')
  expect(homeworkHref).toBeTruthy()

  const alice = await context(browser, 'alice@demo.local')
  await alice.page.goto(HOME)
  await alice.page.getByRole('link', { name: 'View as' }).click()
  await expect(alice.page.getByRole('heading', { name: 'View as' })).toBeVisible()
  const targets = alice.page.getByTestId('view-as-targets')
  await expect(targets).toContainText('Charlie C')
  await targets.getByRole('button', { name: /View Charlie C/ }).click()
  await alice.page.waitForURL(`**${HOME}`)

  const banner = alice.page.getByTestId('view-as-banner')
  await expect(banner).toContainText('Charlie C')
  await expect(banner).toContainText('only the parts you oversee (Classroom)')
  // The header names the person, never shows his email address.
  await expect(alice.page.locator('header')).toContainText('Charlie C')
  await expect(alice.page.locator('header')).not.toContainText('charlie@demo.local')

  // No drift: the classroom home and a homework page are Charlie's own screens.
  await compare(alice.page, charlie.page, HOME, 'Statistics 101')
  await compare(alice.page, charlie.page, homeworkHref!, 'Your submission')

  // Another module of the same org: the placeholder, in the same frame.
  await alice.page.goto('/o/demo-a/m/sample')
  await expect(alice.page.getByTestId('view-as-outside-area')).toContainText('Sample Module · outside your area')
  await expect(alice.page.locator('main')).not.toContainText('Charlie')

  // An org-level page is the viewer's own (the banner says paused).
  await alice.page.goto('/o/demo-a/members')
  await expect(banner).toContainText('paused')

  // Back in scope, then Stop: lands on the picker, banner gone.
  await alice.page.goto(HOME)
  await expect(banner).toContainText('only the parts you oversee')
  await banner.getByRole('button', { name: 'Stop viewing' }).click()
  await alice.page.waitForURL(`**${HOME}/view-as`)
  await expect(alice.page.getByTestId('view-as-banner')).toHaveCount(0)
  await expect(alice.page.getByRole('heading', { name: 'View as' })).toBeVisible()

  await charlie.ctx.close()
  await alice.ctx.close()
})

test('staff view as: peers and people with no edge below them can view nobody', async ({ page }) => {
  // Gabe is the seeded GA: a peer of the students (same rank), so nobody is listed.
  await signIn(page, 'gabe@demo.local')
  await page.goto(`${HOME}/view-as`)
  await expect(page.getByRole('heading', { name: 'View as' })).toBeVisible()
  await expect(page.getByText('There is no one in Classroom whose screen you can view.')).toBeVisible()

  // Charlie is a student: nobody below him.
  await signIn(page, 'charlie@demo.local')
  await page.goto(`${HOME}/view-as`)
  await expect(page.getByText('There is no one in Classroom whose screen you can view.')).toBeVisible()

  // Eve is the seeded cashier: no edge below her, and no View as link.
  await signIn(page, 'eve@demo.local')
  await page.goto('/o/demo-salon/m/nail-salon')
  await expect(page.getByRole('heading', { name: /Nail Salon/ })).toBeVisible()
  await expect(page.getByRole('link', { name: 'View as' })).toHaveCount(0)
  await page.goto('/o/demo-salon/m/nail-salon/view-as')
  await expect(page.getByText('There is no one in Nail Salon whose screen you can view.')).toBeVisible()
})

test('staff view as: a salon manager sees exactly what her worker sees', async ({ browser }) => {
  test.slow()
  const SALON = '/o/demo-salon/m/nail-salon'
  const dana = await context(browser, 'dana@demo.local')
  const alice = await context(browser, 'alice@demo.local')
  await alice.page.goto(`${SALON}/view-as`)
  const targets = alice.page.getByTestId('view-as-targets')
  await expect(targets).toContainText('Dana D')
  // The cashier is not a person view (mode 2 off for manager -> cashier).
  await expect(targets).not.toContainText('Eve')
  await targets.getByRole('button', { name: /View Dana D/ }).click()
  await alice.page.waitForURL(`**${SALON}`)
  await expect(alice.page.getByTestId('view-as-banner')).toContainText('only the parts you oversee (Nail Salon)')
  await compare(alice.page, dana.page, SALON, 'Nail Salon')
  await alice.page.getByTestId('view-as-banner').getByRole('button', { name: 'Stop viewing' }).click()
  await alice.page.waitForURL(`**${SALON}/view-as`)
  await dana.ctx.close()
  await alice.ctx.close()
})
