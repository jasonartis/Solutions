import { expect, test, type Page } from '@playwright/test'

// Visual-messaging fix batch (2026-10-14 brief in docs/modules/module-4-visual-
// messaging.md). The older `visual messaging:` tests live in platform.spec.ts;
// these cover the founder-walkthrough fixes. Requires seeded data (pnpm seed).

async function signIn(page: Page, email: string) {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible()
}

const SVG_400x300 =
  '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#cbd5e1"/></svg>'

// Alice starts a conversation from a picture and opens it.
async function startConversation(page: Page, title: string) {
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-visual/m/visual-messaging')
  await page.getByPlaceholder('Title').fill(title)
  await page.setInputFiles('input[name="image"]', {
    name: 'photo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(SVG_400x300),
  })
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
}

// Konva registers itself on window, which lets a test ask the stage what it is
// actually drawing (layer opacities, handle positions) instead of guessing from
// pixels.
async function layerOpacities(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const K = (window as any).Konva
    return K.stages[0].getLayers().map((l: any) => l.opacity())
  })
}

test('visual messaging: module styling reaches the browser (pen swatches have a size)', async ({ page }) => {
  // The platform-wide `@source` bug (2026-10-14): Tailwind classes used ONLY in
  // modules/*/ui were missing from the built CSS, so the six `h-8 w-8` pen
  // swatches rendered 0x0 and the founder saw no colour choices.
  await startConversation(page, 'Styling ' + Date.now())
  await page.getByRole('button', { name: 'Draw a reply' }).click()
  for (const c of ['#e11d48', '#2563eb', '#16a34a', '#f59e0b', '#111111', '#ffffff']) {
    const box = await page.getByLabel(`pen ${c}`).boundingBox()
    expect(box, `swatch ${c} rendered`).not.toBeNull()
    expect(box!.width).toBeGreaterThanOrEqual(24)
    expect(box!.height).toBeGreaterThanOrEqual(24)
  }
})

test('visual messaging: a fast stroke does not crash, X-ray fades the draft (mouse and touch), handles do not place stamps', async ({
  page,
}) => {
  test.slow()
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await startConversation(page, 'Gestures ' + Date.now())
  await page.getByRole('button', { name: 'Draw a reply' }).click()
  const canvas = page.locator('canvas').first()
  await expect(canvas).toBeVisible()
  const box = (await canvas.boundingBox())!

  // "K.current is not iterable": a pointer-up right behind the moves used to
  // null the live-stroke ref before React ran the queued state updater.
  await page.mouse.move(box.x + 40, box.y + 40)
  await page.mouse.down()
  await page.mouse.move(box.x + 200, box.y + 150, { steps: 40 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Send reply' })).toBeEnabled()
  expect(pageErrors).toEqual([])

  // X-ray, mouse: every layer above the photo fades — including the DRAFT
  // layer holding the stroke just drawn (it used to stay solid).
  const xray = page.getByRole('button', { name: 'Hold to X-ray' })
  expect(await layerOpacities(page)).toEqual([1, 1, 1, 1])
  const xb = (await xray.boundingBox())!
  await page.mouse.move(xb.x + xb.width / 2, xb.y + xb.height / 2)
  await page.mouse.down()
  await expect.poll(() => layerOpacities(page)).toEqual([1, 0.15, 0.15, 0.15])
  await page.mouse.up()
  await expect.poll(() => layerOpacities(page)).toEqual([1, 1, 1, 1])

  // X-ray, touch: only pointer events fire for a finger (mouse events never do).
  await xray.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true })
  await expect.poll(() => layerOpacities(page)).toEqual([1, 0.15, 0.15, 0.15])
  await xray.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true })
  await expect.poll(() => layerOpacities(page)).toEqual([1, 1, 1, 1])

  // Transformer handles: pressing one must NOT deselect the shape or drop a
  // second emoji under it. Place an emoji, select it, press a corner handle.
  await page.getByRole('button', { name: 'Emoji', exact: true }).click()
  await page.mouse.click(box.x + 300, box.y + 200)
  await page.mouse.click(box.x + 300, box.y + 200) // select it
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeVisible()
  const anchor = await page.evaluate(() => {
    const K = (window as any).Konva
    const a = K.stages[0].findOne('.bottom-right')
    const p = a.getAbsolutePosition()
    return { x: p.x, y: p.y }
  })
  await page.mouse.move(box.x + anchor.x, box.y + anchor.y)
  await page.mouse.down()
  await page.mouse.move(box.x + anchor.x + 30, box.y + anchor.y + 30, { steps: 5 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeVisible()
  const stamps = await page.evaluate(() => {
    const K = (window as any).Konva
    return K.stages[0].find('Text').length
  })
  expect(stamps).toBe(1)
  expect(pageErrors).toEqual([])
})

test('visual messaging: a refused send shows inline and keeps the draft (not a crashed page)', async ({ page }) => {
  test.slow()
  await startConversation(page, 'Refusal ' + Date.now())
  const url = page.url()

  // Alice opens the reply canvas and inks a stroke…
  await page.getByRole('button', { name: 'Draw a reply' }).click()
  const box = (await page.locator('canvas').first().boundingBox())!
  await page.mouse.move(box.x + 60, box.y + 60)
  await page.mouse.down()
  await page.mouse.move(box.x + 200, box.y + 160, { steps: 10 })
  await page.mouse.up()
  await expect(page.getByRole('button', { name: 'Send reply' })).toBeEnabled()

  // …while the same account freezes the branch in another tab. The reply guard
  // now refuses the insert.
  const other = await page.context().newPage()
  await other.goto(url)
  await other.getByRole('button', { name: 'Freeze this branch' }).click()
  await expect(other.getByRole('button', { name: 'Unfreeze this branch' })).toBeVisible()
  await other.close()

  await page.getByRole('button', { name: 'Send reply' }).click()
  // Inline, specific text (a thrown message would be redacted in production)…
  await expect(page.locator('p[role="alert"]')).toContainText('Send reply failed')
  // …and the page is still the canvas, with the draft still there to retry.
  await expect(page.getByText('Drawing mode — swipes are off')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send reply' })).toBeEnabled()
})

test('visual messaging: a refused form action shows inline and keeps what was typed', async ({ page }) => {
  await startConversation(page, 'Invite refusal ' + Date.now())
  await page.getByPlaceholder('member@email').fill('nobody-here@demo.local')
  await page.getByRole('button', { name: 'Invite member' }).click()
  await expect(page.locator('p[role="alert"]')).toContainText('No user found with email nobody-here@demo.local')
  await expect(page.getByPlaceholder('member@email')).toHaveValue('nobody-here@demo.local')
})
