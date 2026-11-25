import { expect, test, type Browser, type Page } from '@playwright/test'

// REAL VIEW-AS — THE NO-DRIFT TEST (docs/13 "REAL VIEW-AS" → "THE DESIGN", Q7; whole-account since 2026-11-23).
//
// The founder's hard requirement: the superadmin sees a person's screen rendered
// by the SAME components, with no second layout. So this renders the same pages
// both ways and compares them:
//   1. The superadmin starts a real view of Charlie and renders his pages (the first
//      screen after Start is kept under its own key, then each path).
//   2. Charlie signs in himself and renders the same paths; each <main> must be
//      IDENTICAL to the viewed one. The banner sits outside <main>.
// NOTE this does not by itself prove the dashboard's own writers stay quiet during a view:
// the probe signs Charlie in FIRST, so any first-sign-in side effect has already happened
// to him. The db tests (packages/db/src/real-view-as.test.ts, view-as-whole-account.test.ts)
// are the proof of that.
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

async function mainHtml(page: Page, maskNotes = false): Promise<string> {
  const html = await page.locator('main').innerHTML()
  return (maskNotes ? maskPrivateNotes(html) : html)
    .replace(/token=[^"&]+/g, 'token=X')
    .replace(/(?:<input type="hidden" name="\$ACTION_[^>]*>)+/g, (run) =>
      (run.match(/<input [^>]*>/g) ?? [])
        .map((i) => i.replace(/\$ACTION_REF_\d+/, '$ACTION_REF').replace(/\$ACTION_\d+:/, '$ACTION_:'))
        .sort()
        .join(''),
    )
}

/**
 * The speed-dating event page's "Private note" <details> is the ONE thing allowed to differ: the viewer sees
 * `‹private note · N characters›` where the person sees their own text. Everything else compares exactly.
 */
function maskPrivateNotes(html: string): string {
  return html.replace(/<details[^>]*>(?:(?!<\/details>)[\s\S])*?Private note[\s\S]*?<\/details>/g, '<details>PRIVATE-NOTE</details>')
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

/**
 * Migration A (20261125010000) opens the WHOLE ACCOUNT but leaves every non-classroom module table dark to a view;
 * migration B (20261126010000, kept in supabase/pending/ until A and the app are live) opens them. CI applies only
 * what is in supabase/migrations, so this is false until the commit that moves B there — flip it IN THAT COMMIT.
 */
const MODULES_WIDENED = false

/** A person's own screens: <main> of each path, as they see it. */
async function ownScreens(
  browser: Browser,
  email: string,
  paths: string[],
  maskNotes: (p: string) => boolean = () => false,
): Promise<Map<string, string>> {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await signIn(page, email)
  const out = new Map<string, string>()
  for (const p of paths) {
    await page.goto(p)
    out.set(p, await mainHtml(page, maskNotes(p)))
  }
  await ctx.close()
  return out
}

/** The superadmin opens a whole-account view of `person` from the console's searchable list. */
async function startView(owner: Page, person: string) {
  await owner.goto('/console/view-as/real')
  await owner.getByTestId('view-as-search').fill(person)
  const row = owner.getByTestId('view-as-person').filter({ hasText: person }).first()
  await row.getByRole('button', { name: 'View as' }).click()
  await owner.waitForURL('**/dashboard')
}

async function stopView(owner: Page) {
  await owner.getByTestId('view-as-banner').getByRole('button', { name: 'Stop viewing' }).click()
  await owner.waitForURL('**/console/view-as/real')
  await expect(owner.getByTestId('view-as-banner')).toHaveCount(0)
}

test('real view-as: the superadmin sees exactly what Charlie sees on every module, read-only', async ({ browser }) => {
  // Three sign-ins and ~15 page loads: past the 30 s default under CI's prebuilt server (measured 2026-11-25).
  test.slow()
  const HOME = '/o/demo-a/m/classroom'
  // Hrefs only a signed-in Charlie can read: a homework page, and the speed-dating event page.
  const probe = await browser.newContext()
  const probePage = await probe.newPage()
  await signIn(probePage, 'charlie@demo.local')
  await probePage.goto(HOME)
  await expect(probePage.locator('main')).toContainText('Statistics 101')
  const homeworkHref = await probePage.locator(`main a[href^="${HOME}/homework/"]`).first().getAttribute('href')
  await probePage.goto('/o/demo-dating/m/speed-dating')
  const eventHref = await probePage.getByRole('link', { name: 'Friday Night Mixer' }).getAttribute('href')
  await probe.close()
  expect(homeworkHref && eventHref).toBeTruthy()

  // Dashboard, a classroom page, /account — and, once migration B (20261126010000) has opened the other
  // modules to a whole-account view, a matchmaking page, a speed-dating event page and a visual-messaging page.
  const paths = [
    '/dashboard',
    '/feedback',
    ...(MODULES_WIDENED ? ['/o/demo-match/m/matchmaking', eventHref!, '/o/demo-visual/m/visual-messaging'] : []),
    homeworkHref!,
    '/account',
  ]
  // A "has content" control per page, so an empty or error page can never compare equal to itself.
  const content: Record<string, string> = {
    '/dashboard': 'Demo Org A',
    '/o/demo-match/m/matchmaking': 'Demo Match',
    [eventHref!]: 'Friday Night Mixer',
    '/o/demo-visual/m/visual-messaging': 'Demo Visual',
    [homeworkHref!]: 'Your submission', // a homework page names its section, not the course
    '/account': 'charlie@demo.local',
    // A fresh seed has no tickets, so the stable text is the page's own heading.
    '/feedback': 'My feedback',
  }
  const maskNotes = (p: string) => p === eventHref

  // 1. AS THE VIEWER FIRST: the superadmin starts a view of Charlie and renders each page.
  const ownerCtx = await browser.newContext()
  const owner = await ownerCtx.newPage()
  await signIn(owner, 'owner@demo.local')
  await startView(owner, 'Charlie C')
  const banner = owner.getByTestId('view-as-banner')
  await expect(banner).toContainText('Viewing Charlie C')
  await expect(banner).toContainText('read-only')
  await expect(banner.locator('a[href*="/o/null"]')).toHaveCount(0)

  const viewed = new Map<string, string>()
  viewed.set('first-after-start', await mainHtml(owner)) // the first screen after Start, its own render
  for (const p of paths) {
    await owner.goto(p)
    await expect(banner).toBeVisible()
    viewed.set(p, await mainHtml(owner, maskNotes(p)))
  }
  // Not vacuous: the header names Charlie, not the superadmin.
  await expect(owner.locator('header')).toContainText('Charlie C')

  // Read-only: a form submit while viewing shows the one notice and sends nothing.
  await owner.goto('/account')
  const posts: string[] = []
  owner.on('request', (r) => {
    if (r.method() !== 'GET' && r.method() !== 'HEAD') posts.push(r.url())
  })
  const submit = owner.locator('main form button[type="submit"]').first()
  await expect(submit).toBeVisible()
  await submit.click()
  await expect(owner.getByTestId('view-as-readonly-notice')).toContainText('Read-only view')
  expect(posts).toEqual([])
  expect(new URL(owner.url()).pathname).toBe('/account')
  // The proxy's refusal is still the backstop for a request that bypasses the page.
  const raw = await owner.request.post('/account', { form: { anything: 'x' } })
  expect(raw.status()).toBe(403)
  const action = await owner.request.post(homeworkHref!, {
    headers: { 'Next-Action': 'any', 'Content-Type': 'text/plain;charset=UTF-8' },
    data: '[]',
  })
  expect(action.status()).toBe(403)

  // Leaving the in-scope pages pauses the view (the superadmin is themselves on /console)...
  await owner.goto('/console')
  await expect(owner.getByRole('heading', { name: 'Owner Console' })).toBeVisible()
  await expect(banner).toContainText('paused')
  await expect(owner.locator('header')).not.toContainText('Charlie C')
  await banner.getByRole('button', { name: 'Stop viewing' }).click()
  await owner.waitForURL('**/console/view-as/real')
  await expect(owner.getByTestId('view-as-banner')).toHaveCount(0)
  await expect(owner.getByText('A view is open.')).toHaveCount(0)
  await owner.goto('/dashboard')
  await expect(owner.getByTestId('view-as-banner')).toHaveCount(0)
  await ownerCtx.close()

  // 2. THEN AS THE PERSON: NO DRIFT, each <main> identical (notes element masked on the event page only).
  const charlie = await ownScreens(browser, 'charlie@demo.local', paths, maskNotes)
  for (const p of paths) {
    expect(charlie.get(p)!, `${p} (the person's own screen has content)`).toContain(content[p])
    expect(viewed.get(p)!, `${p} (the viewed screen has content)`).toContain(content[p])
    expectSameScreen(viewed.get(p)!, charlie.get(p)!, p)
  }
  expect(viewed.get('first-after-start')!).toContain(content['/dashboard'])
  expectSameScreen(viewed.get('first-after-start')!, charlie.get('/dashboard')!, 'first screen after Start')
})

test('real view-as: a professor’s manage page renders the same both ways', async ({ browser }) => {
  const HOME = '/o/demo-a/m/classroom'
  const paths = [HOME, `${HOME}/manage`]
  const ownerCtx = await browser.newContext()
  const owner = await ownerCtx.newPage()
  await signIn(owner, 'owner@demo.local')
  await startView(owner, 'Alice')
  const viewed = new Map<string, string>()
  for (const p of paths) {
    await owner.goto(p)
    await expect(owner.getByTestId('view-as-banner')).toContainText('Viewing Alice')
    viewed.set(p, await mainHtml(owner))
  }
  // Content controls (both ways below): the professor's home shows the Classroom heading, manage shows the course.
  const profContent: Record<string, string> = { [HOME]: 'Classroom', [`${HOME}/manage`]: 'Statistics 101' }
  for (const p of paths) expect(viewed.get(p)!, `${p} (the viewed screen has content)`).toContain(profContent[p])
  await stopView(owner)
  await ownerCtx.close()

  const alice = await ownScreens(browser, 'alice@demo.local', paths)
  for (const p of paths) expect(alice.get(p)!, `${p} (the person's own screen has content)`).toContain(profContent[p])
  for (const p of paths) expectSameScreen(viewed.get(p)!, alice.get(p)!, p)
})
