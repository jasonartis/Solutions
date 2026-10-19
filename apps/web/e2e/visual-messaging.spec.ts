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

// Alice (or `who`) starts a conversation from a picture and opens it.
async function startConversation(page: Page, title: string, who = 'alice@demo.local') {
  await signIn(page, who)
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

test('visual messaging: a fast stroke does not crash, X-ray fades what is below the draft in three levels, handles do not place stamps', async ({
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

  // X-ray is a three-level toggle (off -> 50% -> full -> off). While DRAWING it
  // fades everything BELOW the reply (photo + the layers under it) and never the
  // draft itself. Layers: [photo, ancestors, this layer, draft].
  const xray = page.getByRole('button', { name: /^X-ray/ })
  expect(await layerOpacities(page)).toEqual([1, 1, 1, 1])
  await xray.click()
  await expect.poll(() => layerOpacities(page)).toEqual([0.5, 0.5, 0.5, 1])
  await expect(xray).toHaveAttribute('aria-label', 'X-ray: 50%')
  await xray.click()
  await expect.poll(() => layerOpacities(page)).toEqual([0.15, 0.15, 0.15, 1])
  // A touch tap arrives as a click too.
  await xray.dispatchEvent('click')
  await expect.poll(() => layerOpacities(page)).toEqual([1, 1, 1, 1])
  await expect(xray).toHaveAttribute('aria-label', 'X-ray: off')

  // Transformer handles: pressing one must NOT deselect the shape or drop a
  // second emoji under it. Place an emoji, select it, press a corner handle.
  await page.getByRole('button', { name: 'Emoji', exact: true }).click()
  await page.mouse.click(box.x + 300, box.y + 200)
  // Wait for the placement to mount, or the select tap lands on empty canvas.
  await expect
    .poll(() => page.evaluate(() => (window as any).Konva.stages[0].find('Text').length))
    .toBe(1)
  // Konva redraws its hit-detection canvas on the next animation frame; a tap
  // before that still misses the shape. Two frames is the settled state.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
  await page.mouse.click(box.x + 300, box.y + 200) // select it
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeEnabled()
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
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeEnabled()
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
  // Since docs/25 §12 an invitation is never refused because of WHO the
  // address belongs to, so the refusal used here is about the input: an
  // address the browser accepts but longer than the 320 characters allowed.
  // 60 + 1 + 60 + 1 + (4 × 61) + 7 = 373 characters.
  const tooLong = `${'a'.repeat(60)}.${'b'.repeat(60)}@${['c', 'd', 'e', 'f'].map((ch) => ch.repeat(60)).join('.')}.example`
  expect(tooLong.length).toBeGreaterThan(320)
  await page.getByPlaceholder('member@email').fill(tooLong)
  await page.getByRole('button', { name: 'Invite member' }).click()
  await expect(page.locator('p[role="alert"]')).toContainText('Enter a valid email address')
  await expect(page.getByPlaceholder('member@email')).toHaveValue(tooLong)
})

test('pending invites, chat (docs/25 scenario 1): org invite with the Visual Messaging role + a chat invite from a non-admin, then sign up and accept twice', async ({
  page,
}) => {
  const stamp = Date.now()
  const email = `e2e-family-${stamp}@demo.local`
  const title = `Family sketch ${stamp}`

  // 1. The org owner invites the address with the module role.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-visual/members')
  await page.getByPlaceholder('email@example.com').fill(email)
  await page.getByLabel('Also give a module role').selectOption({ label: 'Visual Messaging: member' })
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Invitation saved')
  await expect(page.getByText('Visual Messaging: member, given when they accept')).toBeVisible()

  // 2. Dana — a plain member, NOT an org admin — invites the same address to her chat.
  await startConversation(page, title, 'dana@demo.local')
  await page.getByPlaceholder('member@email').fill(email)
  await page.getByRole('button', { name: 'Invite member' }).click()
  await expect(page.getByRole('button', { name: 'Invited ✓' })).toBeVisible()
  const danaRow = page.locator('li', { hasText: email })
  // An ordinary inviter sees only "Pending", never what it is waiting for.
  await expect(danaRow.getByText('Pending', { exact: true })).toBeVisible()
  await expect(danaRow.getByText(/join the organization|Visual Messaging role|ready/)).toHaveCount(0)

  // 3. The org owner sees the same chat invitation with its reason.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-visual/members')
  const aliceRow = page.locator('li', { hasText: `to the conversation “${title}”` })
  await expect(aliceRow.getByText('waiting for them to join the organization')).toBeVisible()

  // 4. They sign up: the org invitation is there; the chat one is not, yet.
  await page.goto('/login')
  await page.getByRole('button', { name: 'Create account' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Display name').fill(`E2E Family ${stamp}`)
  await page.getByLabel('Password').fill('password123')
  await page.getByRole('button', { name: 'Sign up' }).click()
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(/been invited to join/)).toContainText('Demo Visual')
  const accepted = page.waitForResponse((r) => r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Accept' }).click()
  await accepted

  // 5. Nothing manual in between: the role was given, and the chat invitation is waiting.
  await page.goto('/o/demo-visual/m/visual-messaging')
  const invitation = page.locator('li', { hasText: title })
  await expect(invitation).toBeVisible()
  await invitation.getByRole('button', { name: 'Accept' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()

  // Cleanup: remove the new member so Demo Visual keeps its seeded roster.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-visual/members')
  const row = page.locator('li', { has: page.getByText(email, { exact: true }) })
  const removed = page.waitForResponse((r) => r.request().method() === 'POST')
  await row.getByRole('button', { name: 'Remove', exact: true }).click()
  await removed
})

test('visual messaging: inviting an address with NO account and an existing member reads exactly the same (no oracle)', async ({
  page,
}) => {
  await startConversation(page, 'Invite parity ' + Date.now())
  const answers: string[] = []
  for (const email of ['nobody-here@demo.local', 'charlie@demo.local']) {
    await page.getByPlaceholder('member@email').fill(email)
    await page.getByRole('button', { name: 'Invite member' }).click()
    await expect(page.getByRole('button', { name: 'Invited ✓' })).toBeVisible()
    answers.push((await page.locator('p[role="status"]').textContent()) ?? '')
  }
  expect(answers[0]).toContain('Invitation saved')
  expect(answers[1], 'the inviter must not be able to tell the two apart').toBe(answers[0])
  // Both appear in the admin's waiting list with the same plain status.
  await expect(page.getByText('nobody-here@demo.local')).toBeVisible()
})

// A noisy picture compresses badly, so it stays large however it is saved —
// exactly what a phone photo does to a 1 MB request-body cap. Built in the
// browser (no image library in Node) and handed back as bytes.
async function noisyPicture(page: Page, side: number, mime: 'image/jpeg' | 'image/png', alpha: number) {
  const base64 = await page.evaluate(
    async ({ side, mime, alpha }) => {
      const c = document.createElement('canvas')
      c.width = c.height = side
      const ctx = c.getContext('2d')!
      const img = ctx.createImageData(side, side)
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = Math.random() * 255
        img.data[i + 1] = Math.random() * 255
        img.data[i + 2] = Math.random() * 255
        img.data[i + 3] = alpha
      }
      ctx.putImageData(img, 0, 0)
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), mime, 1))
      const buf = new Uint8Array(await blob.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      return btoa(s)
    },
    { side, mime, alpha },
  )
  return Buffer.from(base64, 'base64')
}

test('visual messaging: a multi-megabyte picture is shrunk in the browser and uploads (root and stamp)', async ({
  page,
}) => {
  test.slow()
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-visual/m/visual-messaging')
  const title = 'Big photo ' + Date.now()
  const big = await noisyPicture(page, 3000, 'image/jpeg', 255)
  expect(big.length).toBeGreaterThan(4_500_000) // over BOTH the 1 MB default and Vercel's ceiling

  await page.getByPlaceholder('Title').fill(title)
  await page.setInputFiles('input[name="image"]', { name: 'big.jpg', mimeType: 'image/jpeg', buffer: big })
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()

  // A big picture WITH transparency as an image stamp: shrunk, and still a PNG.
  const sticker = await noisyPicture(page, 1400, 'image/png', 128)
  expect(sticker.length).toBeGreaterThan(4_000_000)
  await page.getByRole('button', { name: 'Draw a reply' }).click()
  await page.getByRole('button', { name: 'Image', exact: true }).click()
  await page.setInputFiles('input[aria-label="upload image"]', { name: 'sticker.png', mimeType: 'image/png', buffer: sticker })
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeEnabled({ timeout: 30_000 })
  await expect(page.locator('p[role="alert"]')).toHaveCount(0)
})

// ---- the draft model: undo/redo, keys, paste, select + live handles --------

// What the stage holds in its DRAFT layer (index 3: photo, base, current, draft).
const draftCount = (page: Page, className: 'Line' | 'Text' | 'Image') =>
  page.evaluate((c) => (window as any).Konva.stages[0].getLayers()[3].find(c).length, className)

async function openDrawing(page: Page, title: string) {
  await startConversation(page, title)
  await page.getByRole('button', { name: 'Draw a reply' }).click()
  const canvas = page.locator('canvas').first()
  await expect(canvas).toBeVisible()
  return (await canvas.boundingBox())!
}

async function inkStroke(page: Page, box: { x: number; y: number }, from: [number, number], to: [number, number]) {
  await page.mouse.move(box.x + from[0], box.y + from[1])
  await page.mouse.down()
  await page.mouse.move(box.x + to[0], box.y + to[1], { steps: 10 })
  await page.mouse.up()
}

// Konva redraws its hit canvas on the next animation frame; a press before that
// still misses the shape.
const settle = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))

test('visual messaging: undo/redo (buttons and keys), Delete key, and typing keeps its own keys', async ({ page }) => {
  test.slow()
  const box = await openDrawing(page, 'Undo ' + Date.now())
  const undo = page.getByRole('button', { name: 'Undo' })
  const redo = page.getByRole('button', { name: 'Redo' })
  await expect(undo).toBeDisabled()
  await expect(redo).toBeDisabled()

  await inkStroke(page, box, [40, 40], [200, 60])
  await inkStroke(page, box, [40, 120], [200, 140])
  await expect.poll(() => draftCount(page, 'Line')).toBe(2)

  // Button, then Ctrl+Z / Ctrl+Shift+Z.
  await undo.click()
  await expect.poll(() => draftCount(page, 'Line')).toBe(1)
  await expect(redo).toBeEnabled()
  await redo.click()
  await expect.poll(() => draftCount(page, 'Line')).toBe(2)
  await page.keyboard.press('Control+z')
  await expect.poll(() => draftCount(page, 'Line')).toBe(1)
  await page.keyboard.press('Control+Shift+z')
  await expect.poll(() => draftCount(page, 'Line')).toBe(2)

  // A new action after an undo clears the redo stack.
  await page.keyboard.press('Control+z')
  await inkStroke(page, box, [40, 200], [200, 220])
  await expect(redo).toBeDisabled()

  // Delete key removes the selected emoji; Ctrl+Z brings it back.
  await page.getByRole('button', { name: 'Emoji', exact: true }).click()
  await page.mouse.click(box.x + 300, box.y + 60)
  await expect.poll(() => draftCount(page, 'Text')).toBe(1)
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeEnabled()
  await page.keyboard.press('Delete')
  await expect.poll(() => draftCount(page, 'Text')).toBe(0)
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeDisabled()
  await page.keyboard.press('Control+z')
  await expect.poll(() => draftCount(page, 'Text')).toBe(1)

  // While typing in the text box, Backspace edits the text — it must NOT also
  // delete the selected item.
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByLabel('text content').fill('abc')
  await page.mouse.click(box.x + 100, box.y + 250)
  await expect.poll(() => draftCount(page, 'Text')).toBe(2)
  // Placing returned to Select; reopen the Text tool (the selection stays) to type.
  await page.getByRole('button', { name: 'Text', exact: true }).click()
  await page.getByLabel('text content').press('End')
  await page.getByLabel('text content').press('Backspace')
  await expect(page.getByLabel('text content')).toHaveValue('ab')
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeEnabled()
  expect(await draftCount(page, 'Text')).toBe(2)
})

test('visual messaging: Ctrl+V pastes a picture, placed in the middle with handles', async ({ page }) => {
  test.slow()
  await openDrawing(page, 'Paste ' + Date.now())
  await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 80
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#16a34a'
    ctx.fillRect(0, 0, 80, 80)
    return new Promise<void>((resolve) =>
      c.toBlob((b) => {
        const dt = new DataTransfer()
        dt.items.add(new File([b!], 'pasted.png', { type: 'image/png' }))
        window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        resolve()
      }, 'image/png'),
    )
  })
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeEnabled({ timeout: 30_000 })
  await expect.poll(() => draftCount(page, 'Image')).toBe(1)
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeEnabled()
})

test('visual messaging: select, move and delete a pen stroke; resize + rotate an emoji live and it is sent that way', async ({
  page,
}) => {
  test.slow()
  const box = await openDrawing(page, 'Handles ' + Date.now())

  // A stroke can be inked across, but is only grabbed in the Select tool.
  await inkStroke(page, box, [60, 100], [220, 100])
  await expect.poll(() => draftCount(page, 'Line')).toBe(1)
  const strokeX = () =>
    page.evaluate(() => (window as any).Konva.stages[0].getLayers()[3].findOne('Line').points()[0] as number)
  const x0 = await strokeX()
  await page.getByRole('button', { name: 'Select', exact: true }).click()
  await settle(page)
  await page.mouse.move(box.x + 140, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(box.x + 190, box.y + 130, { steps: 6 })
  await page.mouse.up()
  // The move is baked into the points (a stored stroke stays plain points).
  await expect.poll(strokeX).toBeGreaterThan(x0 + 30)
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeEnabled()
  await page.keyboard.press('Delete')
  await expect.poll(() => draftCount(page, 'Line')).toBe(0)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect.poll(() => draftCount(page, 'Line')).toBe(1)

  // Emoji: placed, selected at once, then resized and rotated with the handles.
  await page.getByRole('button', { name: 'Emoji', exact: true }).click()
  await page.mouse.click(box.x + 300, box.y + 200)
  await expect.poll(() => draftCount(page, 'Text')).toBe(1)
  await settle(page)
  const point = (name: string) =>
    page.evaluate((n) => {
      const p = (window as any).Konva.stages[0].findOne(n).getAbsolutePosition()
      return { x: p.x as number, y: p.y as number }
    }, name)
  const fontSize = () =>
    page.evaluate(() => (window as any).Konva.stages[0].getLayers()[3].findOne('Text').fontSize() as number)
  const rotation = () =>
    page.evaluate(() => (window as any).Konva.stages[0].getLayers()[3].findOne('Text').rotation() as number)
  const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(box.x + from.x, box.y + from.y)
    await page.mouse.down()
    await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 })
    await page.mouse.up()
  }
  const size0 = await fontSize()
  const br = await point('.bottom-right')
  await drag(br, { x: br.x + 40, y: br.y + 40 })
  await expect.poll(fontSize).toBeGreaterThan(size0 + 8)

  await settle(page)
  const rot = await point('.rotater')
  const centre = await page.evaluate(() => {
    const p = (window as any).Konva.stages[0].getLayers()[3].findOne('Text').getAbsolutePosition()
    return { x: p.x as number, y: p.y as number }
  })
  // Swing the rotation handle from straight above the emoji to straight right of it: ~90 degrees.
  await drag(rot, { x: centre.x + 90, y: centre.y })
  await expect.poll(async () => Math.abs(await rotation())).toBeGreaterThan(45)
  const sentSize = await fontSize()
  const sentAngle = await rotation()

  // Send it: the stored reply carries the live size and angle.
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('1.1', { exact: true })).toBeVisible()
  const saved = await page.evaluate(() => {
    const t = (window as any).Konva.stages[0].getLayers()[2].findOne('Text')
    return { fontSize: t.fontSize() as number, rotation: t.rotation() as number }
  })
  expect(Math.abs(saved.fontSize - sentSize)).toBeLessThan(0.5)
  expect(Math.abs(saved.rotation - sentAngle)).toBeLessThan(0.5)
})

test('visual messaging: the conversation admin can rename it', async ({ page }) => {
  const title = 'Before ' + Date.now()
  const renamed = 'After ' + Date.now()
  await startConversation(page, title)
  await page.getByText('Rename this conversation').click()
  await page.getByLabel('conversation name').fill(renamed)
  await page.getByRole('button', { name: 'Save name' }).click()
  await expect(page.getByRole('heading', { name: renamed })).toBeVisible()
  // The list shows the new name too (and no longer the old one).
  await page.goto('/o/demo-visual/m/visual-messaging')
  await expect(page.getByRole('link', { name: renamed })).toBeVisible()
  await expect(page.getByRole('link', { name: title })).toHaveCount(0)
})

test('visual messaging: swipe back slides THIS layer\'s ink away, leaving the picture below; short of halfway snaps back', async ({
  page,
}) => {
  test.slow()
  const box = await openDrawing(page, 'Swipe back ' + Date.now())
  await inkStroke(page, box, [60, 60], [220, 140])
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('1.1', { exact: true })).toBeVisible() // now on the reply
  await expect(page.getByText('Replies to this layer (0)')).toBeVisible()

  const layers = () =>
    page.evaluate(() => {
      const ls = (window as any).Konva.stages[0].getLayers()
      return { count: ls.length as number, ownX: ls[2].x() as number, ownOpacity: ls[2].opacity() as number }
    })
  const b = (await page.locator('canvas').first().boundingBox())!

  // Drag RIGHT ~30% and hold: the reply's own ink (layer index 2) rides the
  // pointer and fades a little; the photo (0) and ancestors (1) stay put, and no
  // extra sheet is added.
  await page.mouse.move(b.x + 80, b.y + 120)
  await page.mouse.down()
  await page.mouse.move(b.x + 80 + 120, b.y + 122, { steps: 6 })
  await expect.poll(async () => (await layers()).ownX).toBeGreaterThan(80)
  const mid = await layers()
  expect(Math.abs(mid.ownX - 120)).toBeLessThan(40) // photo is 400px wide at scale 1
  expect(mid.ownOpacity).toBeLessThan(1)
  expect(mid.ownOpacity).toBeGreaterThan(0.5)
  expect(mid.count).toBe(4)

  // Let go short of halfway, slowly (no flick): back in place, no navigation.
  await page.waitForTimeout(300)
  await page.mouse.up()
  await expect.poll(async () => (await layers()).ownX).toBe(0)
  await expect(page.getByText('Replies to this layer (0)')).toBeVisible()

  // ~70%, slowly: completes, landing on the root.
  await page.mouse.move(b.x + 40, b.y + 120)
  await page.mouse.down()
  await page.mouse.move(b.x + 40 + 280, b.y + 122, { steps: 8 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await expect(page.getByText('Replies to this layer (1)')).toBeVisible()
})

test('visual messaging: swipe forward brings in ONLY what the reply added (no picture), see-through; scroll position is kept', async ({
  page,
}) => {
  test.slow()
  const box = await openDrawing(page, 'Swipe fwd ' + Date.now())
  await inkStroke(page, box, [60, 60], [220, 140])
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('1.1', { exact: true })).toBeVisible()
  // Back to the root (button), so the reply is one swipe away.
  await page.getByRole('button', { name: /swipe right/ }).click()
  await expect(page.getByText('Replies to this layer (1)')).toBeVisible()

  const sheet = () =>
    page.evaluate(() => {
      const ls = (window as any).Konva.stages[0].getLayers()
      const last = ls[ls.length - 1]
      return {
        count: ls.length as number,
        opacity: last.opacity() as number,
        x: last.findOne('Group')?.x() as number,
        images: last.find('Image').length as number,
        lines: last.find('Line').length as number,
      }
    })
  const b = (await page.locator('canvas').first().boundingBox())!

  // Make the page tall and scroll a little, as when the picture is partly off-screen.
  await page.evaluate(() => {
    document.body.style.minHeight = '3000px'
    window.scrollTo(0, 120)
  })
  const scrolled = await page.evaluate(() => window.scrollY)
  expect(scrolled).toBeGreaterThan(50)
  const b2 = (await page.locator('canvas').first().boundingBox())!

  // Drag LEFT ~30% and hold: a see-through sheet holding just the reply's stroke
  // (no photo node) rides in from the right.
  await page.mouse.move(b2.x + 300, b2.y + 120)
  await page.mouse.down()
  await page.mouse.move(b2.x + 300 - 120, b2.y + 122, { steps: 6 })
  await expect.poll(async () => (await sheet()).count).toBe(5)
  const mid = await sheet()
  expect(mid.images).toBe(0)
  expect(mid.lines).toBe(1)
  expect(mid.opacity).toBeGreaterThan(0.5)
  expect(mid.opacity).toBeLessThan(0.8)
  expect(Math.abs(mid.x - (400 - 120))).toBeLessThan(40)
  await page.waitForTimeout(300)
  await page.mouse.up()
  await expect.poll(async () => (await sheet()).count).toBe(4) // snapped back

  // Complete it (~70%): the soft navigation must NOT jump to the top of the page.
  await page.mouse.move(b2.x + 340, b2.y + 120)
  await page.mouse.down()
  await page.mouse.move(b2.x + 340 - 280, b2.y + 122, { steps: 8 })
  await page.waitForTimeout(300)
  await page.mouse.up()
  await expect(page.getByText('Replies to this layer (0)')).toBeVisible() // on the reply
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(50)
  void b
})

test('visual messaging: the layer-count markers sit on the side the layers come from', async ({ page }) => {
  test.slow()
  const box = await openDrawing(page, 'Markers ' + Date.now())
  await inkStroke(page, box, [60, 60], [220, 140])
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('1.1', { exact: true })).toBeVisible()
  const canvasBox = (await page.locator('canvas').first().boundingBox())!
  const centreX = canvasBox.x + canvasBox.width / 2

  // On the reply, the way up is back to the parent: pulled in from the LEFT.
  const back = page.getByRole('button', { name: /swipe right: 1 back up/ })
  await expect(back).toContainText('←')
  expect((await back.boundingBox())!.x).toBeLessThan(centreX)

  await back.click()
  await expect(page.getByText('Replies to this layer (1)')).toBeVisible()
  // On the root, the reply is pulled in from the RIGHT.
  const deeper = page.getByRole('button', { name: /swipe left: 1 deeper/ })
  await expect(deeper).toContainText('→')
  expect((await deeper.boundingBox())!.x).toBeGreaterThan(centreX)
})

test('visual messaging: after placing an item the next press selects instead of stamping another; Select stands apart', async ({
  page,
}) => {
  test.slow()
  const box = await openDrawing(page, 'Select after ' + Date.now())
  await page.getByRole('button', { name: 'Emoji', exact: true }).click()
  await page.mouse.click(box.x + 300, box.y + 200)
  await expect.poll(() => draftCount(page, 'Text')).toBe(1)
  await settle(page)
  // Empty canvas: deselects, adds nothing (the tool went back to Select).
  await page.mouse.click(box.x + 60, box.y + 60)
  await expect.poll(() => draftCount(page, 'Text')).toBe(1)
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeDisabled()
  // Press on the emoji: selects it, still one emoji.
  await page.mouse.click(box.x + 300, box.y + 200)
  await expect(page.getByRole('button', { name: 'Delete selected' })).toBeEnabled()
  expect(await draftCount(page, 'Text')).toBe(1)
  // Choosing Emoji again lets the next press stamp a second one.
  await page.getByRole('button', { name: 'Emoji', exact: true }).click()
  await page.mouse.click(box.x + 60, box.y + 60)
  await expect.poll(() => draftCount(page, 'Text')).toBe(2)
})

test('visual messaging: inviting confirms, and the button stays done until the email changes', async ({ page }) => {
  await startConversation(page, 'Invite confirm ' + Date.now())
  await page.getByPlaceholder('member@email').fill('charlie@demo.local')
  await page.getByRole('button', { name: 'Invite member' }).click()
  const done = page.getByRole('button', { name: 'Invited ✓' })
  await expect(done).toBeDisabled()
  await expect(page.locator('p[role="status"]')).toContainText('Invitation saved')
  // Changing the address re-arms it.
  await page.getByPlaceholder('member@email').fill('dana@demo.local')
  await expect(page.getByRole('button', { name: 'Invite member' })).toBeEnabled()
  await expect(page.locator('p[role="status"]')).toHaveCount(0)
})

test('visual messaging: the edge markers update at once on a swipe, not after the server round-trip', async ({ page }) => {
  test.slow()
  const box = await openDrawing(page, 'Fast markers ' + Date.now())
  await inkStroke(page, box, [60, 60], [220, 140])
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('1.1', { exact: true })).toBeVisible()

  // Make every page-data request take 3s, so anything that waits for the server is slow.
  await page.route(/_rsc=/, async (route) => {
    await new Promise((r) => setTimeout(r, 3000))
    await route.continue()
  })
  await page.getByRole('button', { name: /swipe right: 1 back up/ }).click()
  // The new layer's markers (a reply to dive into) are there well inside the 3s.
  await expect(page.getByRole('button', { name: /swipe left: 1 deeper/ })).toBeVisible({ timeout: 1500 })
  await expect(page.getByRole('button', { name: /swipe right/ })).toHaveCount(0) // root: nowhere further back
  await page.unroute(/_rsc=/)
  await expect(page.getByText('Replies to this layer (1)')).toBeVisible({ timeout: 15_000 })
})

test('visual messaging: X-ray while viewing fades the replies, not the picture, and resets when drawing starts', async ({
  page,
}) => {
  test.slow()
  const box = await openDrawing(page, 'Xray view ' + Date.now())
  await inkStroke(page, box, [60, 60], [220, 140])
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('1.1', { exact: true })).toBeVisible()
  const xray = page.getByRole('button', { name: /^X-ray/ })
  await xray.click()
  // Viewing: the picture stays solid, the ink of the replies fades.
  await expect.poll(() => layerOpacities(page)).toEqual([1, 0.5, 0.5, 1])
  await xray.click()
  await expect.poll(() => layerOpacities(page)).toEqual([1, 0.15, 0.15, 1])
  // Starting a reply resets it, since it now means something else.
  await page.getByRole('button', { name: 'Draw a reply' }).click()
  await expect(xray).toHaveAttribute('aria-label', 'X-ray: off')
  await expect.poll(() => layerOpacities(page)).toEqual([1, 1, 1, 1])
})
