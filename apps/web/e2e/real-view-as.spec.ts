import { expect, test, type Browser, type Page } from '@playwright/test'

// REAL VIEW-AS — THE NO-DRIFT TEST (docs/13 "REAL VIEW-AS" → "THE DESIGN", Q7).
//
// The founder's hard requirement: the superadmin sees a person's screen rendered
// by the SAME components, with no second layout. So this renders the same pages
// both ways and compares them:
//   1. Charlie (a classroom student) signs in and opens his classroom home and a
//      homework page; each page's <main> HTML is kept.
//   2. The superadmin starts a real view of Charlie and opens the same paths;
//      each <main> must be IDENTICAL. The banner sits outside <main>.
// Then, still viewing, it proves the view cannot change anything (a server
// action and a plain form post are refused by the proxy; the database gate is
// proved in packages/db/src/real-view-as.test.ts) and that Stop ends it.
//
// Two normalisations, both for things that differ between two renders for the
// SAME person, so neither can hide a real difference in what the screen shows:
//   * signed file links carry a fresh token on every render: `token=...` is masked;
//   * React writes each server-action form's hidden inputs with a render-order
//     counter (`$ACTION_REF_1` vs `_2`) and in whichever order their bound values
//     finished serialising. The counters are stripped and the inputs sorted, but
//     their VALUES (which org, survey, class the form would act on) still compare.

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

/** Equal, or fail showing where the two screens first differ (a whole-page dump is unreadable). */
function expectSameScreen(viewed: string, own: string, what: string) {
  if (viewed === own) return
  let i = 0
  while (i < viewed.length && viewed[i] === own[i]) i++
  const at = (s: string) => s.slice(Math.max(0, i - 120), i + 200)
  expect({ what, viewed: at(viewed) }).toEqual({ what, viewed: at(own) })
}

const HOME = '/o/demo-a/m/classroom'

/** A person's own screens: <main> of each path, as they see it. */
async function ownScreens(browser: Browser, email: string, paths: string[]): Promise<Map<string, string>> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await signIn(page, email)
  const out = new Map<string, string>()
  for (const p of paths) {
    await page.goto(p)
    out.set(p, await mainHtml(page))
  }
  await ctx.close()
  return out
}

/** The superadmin opens a real view of `person` in Demo Org A from the console. */
async function startView(owner: Page, person: string) {
  await owner.goto('/console/view-as/real')
  const form = owner.getByTestId('real-view-org').filter({ hasText: 'Demo Org A' })
  const value = await form.locator('option', { hasText: person }).getAttribute('value')
  await form.locator('select').selectOption(value!)
  await form.getByRole('button', { name: 'See their screen' }).click()
  await owner.waitForURL(`**${HOME}`)
}

test('real view-as: the superadmin sees exactly what Charlie sees, read-only', async ({ browser }) => {
  // The student pages: home, a homework page, a peer-review page (hrefs read from his own home).
  const probe = await browser.newContext()
  const probePage = await probe.newPage()
  await signIn(probePage, 'charlie@demo.local')
  await probePage.goto(HOME)
  await expect(probePage.locator('main')).toContainText('Statistics 101')
  const homeworkHref = await probePage.locator(`main a[href^="${HOME}/homework/"]`).first().getAttribute('href')
  const reviewHref = await probePage.locator(`main a[href^="${HOME}/review/"]`).first().getAttribute('href')
  await probe.close()
  expect(homeworkHref && reviewHref).toBeTruthy()
  const paths = [HOME, homeworkHref!, reviewHref!]
  const charlie = await ownScreens(browser, 'charlie@demo.local', paths)

  const ownerCtx = await browser.newContext()
  const owner = await ownerCtx.newPage()
  await signIn(owner, 'owner@demo.local')
  await startView(owner, 'Charlie C')

  const banner = owner.getByTestId('view-as-banner')
  await expect(banner).toContainText('You are viewing Charlie C')
  await expect(banner).toContainText('Read-only')

  // NO DRIFT: the first screen after Start, then each path, the same <main> as Charlie's own.
  expectSameScreen(await mainHtml(owner), charlie.get(HOME)!, 'classroom home (first screen)')
  for (const p of paths) {
    await owner.goto(p)
    await expect(banner).toBeVisible()
    expectSameScreen(await mainHtml(owner), charlie.get(p)!, p)
  }
  // Not vacuous: the header names Charlie, not the superadmin.
  await expect(owner.locator('header')).toContainText('Charlie C')

  // Clicking links keeps banner and header true (every page is a full load while viewing):
  // into a homework page and back out to the dashboard, where the view is paused.
  await owner.goto(HOME)
  await owner.locator(`main a[href="${homeworkHref}"]`).click()
  await owner.waitForURL(`**${homeworkHref}`)
  await expect(banner).toContainText('You are viewing Charlie C')
  await owner.locator('header a[href="/dashboard"]').click()
  await owner.waitForURL('**/dashboard')
  await expect(banner).toContainText('is paused on this page')
  await expect(owner.locator('header')).not.toContainText('Charlie C')

  // Nothing can be sent while viewing: a server action and a plain form post are refused.
  const action = await owner.request.post(homeworkHref!, {
    headers: { 'Next-Action': 'any', 'Content-Type': 'text/plain;charset=UTF-8' },
    data: '[]',
  })
  expect(action.status()).toBe(403)
  const post = await owner.request.post('/console', { form: { anything: 'x' } })
  expect(post.status()).toBe(403)

  // Stop ends it: back on the console's page, no banner, Start available again.
  await owner.goto('/console')
  await expect(owner.getByRole('heading', { name: 'Owner Console' })).toBeVisible()
  await banner.getByRole('button', { name: 'Stop viewing' }).click()
  await owner.waitForURL('**/console/view-as/real')
  await expect(owner.getByTestId('view-as-banner')).toHaveCount(0)
  // The view is really over: no 'A view is open' notice, and Start can be pressed again.
  await expect(owner.getByText('A view is open.')).toHaveCount(0)
  await expect(owner.getByTestId('real-view-org').first().getByRole('button', { name: 'See their screen' })).toBeEnabled()
  await owner.goto(HOME)
  await expect(owner.getByTestId('view-as-banner')).toHaveCount(0)
  await ownerCtx.close()
})

test('real view-as: a professor’s manage page renders the same both ways', async ({ browser }) => {
  const paths = [HOME, `${HOME}/manage`]
  const alice = await ownScreens(browser, 'alice@demo.local', paths)
  expect(alice.get(`${HOME}/manage`)).toContain('Statistics 101') // the professor's own page has content

  const ownerCtx = await browser.newContext()
  const owner = await ownerCtx.newPage()
  await signIn(owner, 'owner@demo.local')
  await startView(owner, 'Alice')
  for (const p of paths) {
    await owner.goto(p)
    await expect(owner.getByTestId('view-as-banner')).toContainText('You are viewing Alice')
    expectSameScreen(await mainHtml(owner), alice.get(p)!, p)
  }
  await owner.getByTestId('view-as-banner').getByRole('button', { name: 'Stop viewing' }).click()
  await owner.waitForURL('**/console/view-as/real')
  await ownerCtx.close()
})
