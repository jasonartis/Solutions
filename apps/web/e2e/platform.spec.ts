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

test('classroom module: professor sees the seeded class, student view is scoped', async ({ page }) => {
  await signIn(page, 'alice@demo.local')
  await page.getByRole('link', { name: 'Classroom' }).click()
  await expect(page.getByRole('heading', { name: 'Classes' })).toBeVisible()
  await expect(page.getByText('Statistics 101 — Fall')).toBeVisible()
  await expect(page.getByText('Welcome to Statistics 101!')).toBeVisible()
  await expect(page.getByText('Homework 1 — Descriptive statistics')).toBeVisible()

  // Professor-only manage console: roster with preferred/display names.
  await page.getByRole('link', { name: 'Manage' }).click()
  await expect(page.getByRole('heading', { name: 'Classroom — Manage' })).toBeVisible()
  await expect(page.getByText('Roster (3)')).toBeVisible()
  await expect(page.getByText('Charlie C')).toBeVisible()
})

test('classroom module: student sees published materials and can submit homework files', async ({ page }) => {
  await signIn(page, 'charlie@demo.local')
  await page.getByRole('link', { name: 'Classroom' }).click()

  // Seeded, always-visible (no window) URL material.
  await expect(page.getByRole('link', { name: 'Syllabus' })).toBeVisible()

  await page.getByRole('link', { name: 'Homework 1 — Descriptive statistics' }).click()
  await expect(page.getByRole('heading', { name: 'Homework 1 — Descriptive statistics' })).toBeVisible()
  await expect(page.getByText('No files uploaded yet.')).toBeVisible()

  await page.setInputFiles('input[name="file"]', {
    name: 'homework1-answer.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('my answer'),
  })
  await page.getByRole('button', { name: 'Upload' }).click()
  await expect(page.getByText('homework1-answer.txt')).toBeVisible()
})

test('classroom module: professor publishes a material with a visibility window', async ({ page }) => {
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-a/m/classroom/manage/materials')
  await expect(page.getByRole('heading', { name: 'Classroom — Materials' })).toBeVisible()

  await page.getByPlaceholder('Title').fill('Lecture 2 slides')
  await page.getByPlaceholder('URL (optional)').fill('https://example.com/lecture2.pdf')
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('Lecture 2 slides')).toBeVisible()

  // Publish it into the future — should NOT be visible to the student yet.
  // Scope to the material-row class combo (not a generic 'div' filter) so we
  // don't match the ancestor section/title divs that also contain this text.
  const row = page.locator('div.rounded.border.border-gray-100').filter({ hasText: 'Lecture 2 slides' })
  await row.getByLabel('From').fill('2099-01-01T00:00')
  await row.getByRole('button', { name: 'Publish' }).click()
  await expect(row.getByRole('button', { name: 'Update' })).toBeVisible()

  await signIn(page, 'charlie@demo.local')
  await page.getByRole('link', { name: 'Classroom' }).click()
  await expect(page.getByText('Lecture 2 slides')).not.toBeVisible()
})

test('classroom module: grading workflow — GA grade, peer review, finalize, publish', async ({ page }) => {
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-a/m/classroom/manage')
  await page.getByRole('link', { name: 'Homework 1 — Descriptive statistics' }).click()
  await expect(page.getByRole('heading', { name: /^Grading —/ })).toBeVisible()

  await page.getByRole('button', { name: 'Move submitted → GA grading' }).click()

  // Row-scope by the exact student-name cell — a `hasText` row filter would
  // also match the OTHER student's row once the peer-review column mentions
  // this name (e.g. "Dana D" appears inside Charlie's row as "Dana D: pending").
  const rowFor = (name: string) =>
    page.locator('tbody tr').filter({ has: page.getByRole('cell', { name, exact: true }) })

  await rowFor('Charlie C').locator('input[name="score"]').fill('85')
  await rowFor('Charlie C').getByRole('button', { name: 'Save' }).click()
  await expect(page.locator('input[name="score"]').first()).toHaveValue('85')

  await page.locator('input[name="reviewsPerStudent"]').fill('1')
  await page.getByRole('button', { name: 'Move GA-graded → peer review' }).click()

  // With exactly 2 students and 1 review each, the algorithm assigns them to
  // review each other — Dana reviews Charlie's submission and vice versa.
  await expect(rowFor('Charlie C')).toContainText('Dana D: pending')
  await expect(rowFor('Dana D')).toContainText('Charlie C: pending')

  await signIn(page, 'charlie@demo.local')
  await page.getByRole('link', { name: 'Classroom' }).click()
  await expect(page.getByText('Peer reviews assigned to you')).toBeVisible()
  // The homework title also links to the (different) submission-upload page —
  // scope to the review-route href to avoid the ambiguous duplicate link text.
  await page.locator('a[href*="/classroom/review/"]').click()
  await expect(page.getByRole('heading', { name: 'Peer review' })).toBeVisible()

  await page.getByPlaceholder('Add a comment…').fill('Nice work!')
  await page.getByRole('button', { name: 'Add' }).click()
  await expect(page.getByText('Nice work!')).toBeVisible()

  await page.locator('input[name="grade"]').fill('90')
  await page.getByRole('button', { name: 'Submit grade' }).click()
  await expect(page.getByRole('button', { name: 'Update grade' })).toBeVisible()

  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-a/m/classroom/manage')
  await page.getByRole('link', { name: 'Homework 1 — Descriptive statistics' }).click()
  await expect(rowFor('Dana D')).toContainText('Charlie C: 90')

  await page.getByRole('button', { name: 'Finalize peer review → done' }).click()

  // Automatic gradebook combination (defaults GA×0.8 + Peer×0.2, renormalized
  // over the components each student actually has): Charlie has only GA 85,
  // Dana only peer 90 — so their finals land at exactly those values.
  await page.getByRole('button', { name: 'Compute finals' }).click()
  await expect(rowFor('Charlie C').locator('input[name="finalScore"]')).toHaveValue('85')
  await expect(rowFor('Dana D').locator('input[name="finalScore"]')).toHaveValue('90')

  // Manual override still wins: bump Charlie to 88, recompute, 88 survives.
  await rowFor('Charlie C').locator('input[name="finalScore"]').fill('88')
  await rowFor('Charlie C').getByRole('button', { name: 'Update' }).click()
  await expect(rowFor('Charlie C').locator('input[name="finalScore"]')).toHaveValue('88')
  await page.getByRole('button', { name: 'Compute finals' }).click()
  await expect(rowFor('Charlie C').locator('input[name="finalScore"]')).toHaveValue('88')

  await signIn(page, 'dana@demo.local')
  await page.getByRole('link', { name: 'Classroom' }).click()
  await expect(page.getByText('Your grades')).toBeVisible()
  // The homework title also appears in the homework list and Dana's own
  // (unrelated) pending peer-review entry — scope to the grades list itself.
  const gradesList = page.locator('h3', { hasText: 'Your grades' }).locator('xpath=following-sibling::ul[1]')
  await expect(gradesList).toContainText('Homework 1 — Descriptive statistics')
  await expect(gradesList).toContainText('90')
})

test('classroom module: student answers a survey, professor reveals aggregate results', async ({ page }) => {
  // Seeded survey "Which lab time do you prefer?" starts with results hidden.
  await signIn(page, 'charlie@demo.local')
  await page.getByRole('link', { name: 'Classroom' }).click()
  const survey = page.locator('div').filter({ hasText: 'Which lab time do you prefer?' }).last()
  await survey.getByPlaceholder('Your answer…').fill('Mornings')
  await survey.getByRole('button', { name: 'Submit' }).click()
  // Re-render shows the saved answer with an Update button.
  await expect(
    page.locator('div').filter({ hasText: 'Which lab time do you prefer?' }).last().getByRole('button', { name: 'Update' }),
  ).toBeVisible()

  // Professor flips results visible.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-a/m/classroom/manage')
  await page.getByRole('button', { name: 'Show results to class' }).click()
  await expect(page.getByRole('button', { name: 'Hide results' })).toBeVisible()

  // Student now sees the aggregated count for their answer.
  await signIn(page, 'charlie@demo.local')
  await page.getByRole('link', { name: 'Classroom' }).click()
  const surveyAfter = page.locator('div').filter({ hasText: 'Which lab time do you prefer?' }).last()
  await expect(surveyAfter).toContainText('Mornings')
})

test('classroom module: professor creates an exam, grades by subproblem, publishes final', async ({ page }) => {
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-a/m/classroom/manage')

  await page.getByPlaceholder('New exam title').fill('Midterm')
  await page.getByPlaceholder('Problems, e.g. 1a:10, 1b:5, 2:20').fill('1a:10, 1b:5, 2:20')
  await page.getByRole('button', { name: 'Add exam' }).click()
  await page.getByRole('link', { name: 'Midterm' }).click()
  await expect(page.getByRole('heading', { name: 'Exam — Midterm' })).toBeVisible()
  await expect(page.getByText('1a (10) · 1b (5) · 2 (20) — max 35')).toBeVisible()

  // Grade Dana by subproblem: 8 + 4 + 15 = 27.
  const danaCard = page.locator('section').filter({ hasText: 'Dana D' })
  await danaCard.locator('input[name="problem_1a"]').fill('8')
  await danaCard.locator('input[name="problem_1b"]').fill('4')
  await danaCard.locator('input[name="problem_2"]').fill('15')
  await danaCard.getByRole('button', { name: 'Save scores' }).click()
  await expect(page.locator('section').filter({ hasText: 'Dana D' })).toContainText('graded: 27/35')

  // Publish final (defaults to the GA total).
  await page
    .locator('section')
    .filter({ hasText: 'Dana D' })
    .getByRole('button', { name: 'Publish final' })
    .click()
  await expect(page.locator('section').filter({ hasText: 'Dana D' })).toContainText('final: 27')

  // Dana sees the exam final in her grades.
  await signIn(page, 'dana@demo.local')
  await page.getByRole('link', { name: 'Classroom' }).click()
  await expect(page.getByText('Your grades')).toBeVisible()
  const gradesList2 = page.locator('h3', { hasText: 'Your grades' }).locator('xpath=following-sibling::ul[1]')
  await expect(gradesList2).toContainText('Midterm')
  await expect(gradesList2).toContainText('27')
})

test('matchmaking module: single sees seeded matches and can answer; admin recomputes', async ({ page }) => {
  // Dana shares one answer with her matches (wait on the POST per CLAUDE.md).
  await signIn(page, 'dana@demo.local')
  await page.goto('/o/demo-match/m/matchmaking')
  const kidsForm = page.locator('form').filter({ hasText: 'I want children' })
  await kidsForm.getByRole('checkbox', { name: /Share this answer/ }).check()
  const saved = page.waitForResponse((r) => r.request().method() === 'POST')
  await kidsForm.getByRole('button', { name: 'Save' }).click()
  await saved

  // Charlie's top match is Dana (91%) from the seeded answers; same-gender
  // pairs are excluded by the gender dealbreaker and never appear.
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-match/m/matchmaking')
  await expect(page.getByRole('heading', { name: 'Make-a-Match' })).toBeVisible()

  const matches = page.locator('h2', { hasText: 'Your matches' }).locator('xpath=following-sibling::ul[1]')
  await expect(matches).toContainText('Dana D')
  await expect(matches).toContainText('91%')
  await expect(matches).not.toContainText('Frank F') // same gender → excluded
  // Dana's shared answer is revealed to her match — with the chosen label.
  await expect(matches).toContainText('I want children: Yes')
  await expect(matches).toContainText('(shared with you)')

  // Answer the open exercise question (radio + save).
  const exercise = page.locator('form').filter({ hasText: 'I exercise' })
  await exercise.getByRole('radio').first().check() // "Never"
  await exercise.getByRole('button', { name: 'Save' }).click()

  // Admin can recompute from the Manage console.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-match/m/matchmaking/manage')
  await expect(page.getByRole('heading', { name: 'Make-a-Match — Manage' })).toBeVisible()
  await expect(page.getByText('Approved questions (3)')).toBeVisible()
  await page.getByRole('button', { name: 'Recompute all matches' }).click()
  // Page reloads with the recompute done (no error surfaced).
  await expect(page.getByRole('heading', { name: 'Make-a-Match — Manage' })).toBeVisible()
})

test('nail-salon module: operator runs an appointment from booked to paid', async ({ page }) => {
  // alice is the salon manager; the seed has one booked appointment for Charlie.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-salon/m/nail-salon')
  await expect(page.getByRole('heading', { name: /^Nail Salon/ })).toBeVisible()

  const row = page.locator('tbody tr').filter({ hasText: 'Charlie C' })
  await expect(row).toContainText('booked')

  // Walk the lifecycle: check in → start → complete → bill → pay.
  await row.getByRole('button', { name: 'Check in' }).click()
  await page.locator('tbody tr').filter({ hasText: 'Charlie C' }).getByRole('button', { name: 'Start' }).click()
  await page.locator('tbody tr').filter({ hasText: 'Charlie C' }).getByRole('button', { name: 'Complete' }).click()
  await page.locator('tbody tr').filter({ hasText: 'Charlie C' }).getByRole('button', { name: 'Bill' }).click()
  await page
    .locator('tbody tr')
    .filter({ hasText: 'Charlie C' })
    .getByRole('button', { name: /Mark paid/ })
    .click()
  await expect(page.locator('tbody tr').filter({ hasText: 'Charlie C' })).toContainText('paid')
})

test('nail-salon module: manager runs the back-office (catalog, expenses, shopping→expense)', async ({ page }) => {
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-salon/m/nail-salon/manage')
  await expect(page.getByRole('heading', { name: 'Salon — Manage' })).toBeVisible()

  // Catalog: add a service. `.first()` keeps the assertion stable if a prior
  // retry of this test already inserted one (rows accumulate across attempts).
  await page.getByPlaceholder('Service name').fill('Gel polish')
  await page.getByPlaceholder('Price').fill('25')
  await page.getByPlaceholder('Minutes').fill('20')
  await page.getByRole('button', { name: 'Add service' }).click()
  await expect(page.getByText('Gel polish · $25.00 · 20 min').first()).toBeVisible()

  // Shopping list: add an item, mark purchased with the actual cost -> expense.
  // The "×1" suffix only exists on the shopping-list row, disambiguating it
  // from the expense row that will also mention the item name after purchase.
  await page.getByPlaceholder('Item to buy').fill('Acetone (1L)')
  await page.getByRole('button', { name: 'Add item' }).click()
  const shoppingRow = page.locator('li').filter({ hasText: 'Acetone (1L) ×1' }).first()
  await shoppingRow.getByPlaceholder('Paid').fill('12.50')
  await shoppingRow.getByRole('button', { name: 'Purchased' }).click()
  await expect(page.locator('li').filter({ hasText: 'Acetone (1L) ×1' }).first()).toContainText('purchased')
  // The linked expense appears in the expenses section (category "supplies").
  await expect(page.locator('li').filter({ hasText: 'supplies' }).filter({ hasText: '$12.50' }).first()).toBeVisible()
})

test('nail-salon module: customer self-books and can cancel', async ({ page }) => {
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-salon/m/nail-salon')
  await expect(page.getByRole('heading', { name: 'Book an appointment' })).toBeVisible()

  await page.locator('select[name="serviceId"]').selectOption({ label: 'Pedicure ($60)' })
  await page.locator('input[name="start"]').fill('2099-03-05T14:00')
  await page.getByRole('button', { name: 'Book', exact: true }).click()

  const row = page.locator('li').filter({ hasText: 'Pedicure' }).first()
  await expect(row).toContainText('booked')
  await row.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('li').filter({ hasText: 'Pedicure' }).first()).toContainText('cancelled')
})

test('nail-salon module: worker sees only their assigned chairs', async ({ page }) => {
  // dana is the salon worker; the seeded appointment is assigned to her.
  await signIn(page, 'dana@demo.local')
  await page.goto('/o/demo-salon/m/nail-salon')
  await expect(page.getByRole('heading', { name: 'Your chairs today' })).toBeVisible()
  await expect(page.getByText('Charlie C')).toBeVisible()
  // No operator-only booking form for a pure worker.
  await expect(page.getByRole('heading', { name: 'Book appointment' })).not.toBeVisible()
})

test('speed-dating module: register → round → mutual interest → reveal', async ({ page }) => {
  // Charlie and Dana register for the seeded open event.
  for (const who of ['charlie@demo.local', 'dana@demo.local']) {
    await signIn(page, who)
    await page.goto('/o/demo-dating/m/speed-dating')
    await page.getByRole('link', { name: 'Friday Night Mixer' }).click()
    await page.getByRole('button', { name: 'Register for this event' }).click()
    await expect(page.getByText('You are registered')).toBeVisible()
  }

  // Organizer starts the event and runs a round (orchestrator stand-in).
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-dating/m/speed-dating')
  await page.getByRole('link', { name: 'Friday Night Mixer' }).click()
  await expect(page.getByText('Roster (2 registered)')).toBeVisible()
  await page.getByRole('button', { name: 'Start event' }).click()
  await expect(page.getByText('running', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Run next round (pair everyone)' }).click()
  // Confirm the round landed before navigating (goto-after-POST race).
  await expect(page.getByText(/Rounds run: 1/)).toBeVisible()

  // Charlie marks interested in Dana; Dana sees NO match yet (one-sided).
  // After each mutating click, wait for the re-render to confirm the mark
  // landed (the chosen button turns solid) BEFORE navigating — a goto() right
  // after a form POST can abort the in-flight server action (see CLAUDE.md).
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-dating/m/speed-dating')
  await page.getByRole('link', { name: 'Friday Night Mixer' }).click()
  await expect(page.getByText('People you met')).toBeVisible()
  await expect(page.getByText('Dana D')).toBeVisible()
  await page.getByRole('button', { name: 'interested', exact: true }).click()
  await expect(page.getByRole('button', { name: 'interested', exact: true })).toHaveClass(/bg-blue-600/)

  await signIn(page, 'dana@demo.local')
  await page.goto('/o/demo-dating/m/speed-dating')
  await page.getByRole('link', { name: 'Friday Night Mixer' }).click()
  await expect(page.getByText("It's a match!")).not.toBeVisible()
  // Dana reciprocates.
  await page.getByRole('button', { name: 'interested', exact: true }).click()
  await expect(page.getByRole('button', { name: 'interested', exact: true })).toHaveClass(/bg-blue-600/)
  // Still unrevealed — mutual interest alone shows nothing until the organizer reveals.
  await expect(page.getByText("It's a match!")).not.toBeVisible()

  // Organizer completes the event and reveals (each step confirmed on-page).
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-dating/m/speed-dating')
  await page.getByRole('link', { name: 'Friday Night Mixer' }).click()
  await expect(page.getByText('Matches: 0 revealed / 1 total')).toBeVisible()
  await page.getByRole('button', { name: 'Complete event' }).click()
  await page.getByRole('button', { name: 'Reveal mutual matches' }).click()
  await expect(page.getByText('Matches: 1 revealed / 1 total')).toBeVisible()

  // Both sides now see the match.
  await signIn(page, 'dana@demo.local')
  await page.goto('/o/demo-dating/m/speed-dating')
  await page.getByRole('link', { name: 'Friday Night Mixer' }).click()
  await expect(page.getByText("It's a match!")).toBeVisible()
  await expect(page.getByText('Charlie C is interested too.')).toBeVisible()
})

test('sample module (module 0 template): staff creates, member contributes', async ({ page }) => {
  // Proves the living template stays green: module UI physically inside
  // modules/sample/ui, mounted by a thin wrapper (docs/03 composition).
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-a/m/sample')
  await expect(page.getByRole('heading', { name: 'Sample Module' })).toBeVisible()
  await page.getByPlaceholder('New project name').fill('Rollout plan')
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByText('Rollout plan')).toBeVisible()

  // Member (no manager role): no create-project form, but can add + toggle items.
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-a/m/sample')
  await expect(page.getByPlaceholder('New project name')).not.toBeVisible()
  const section = page.locator('section').filter({ hasText: 'Template Project' })
  await section.getByPlaceholder('Add an item…').fill('Write the docs')
  await section.getByRole('button', { name: 'Add' }).click()
  const item = page
    .locator('section')
    .filter({ hasText: 'Template Project' })
    .locator('li')
    .filter({ hasText: 'Write the docs' })
  await expect(item).toBeVisible()
  await item.getByRole('button', { name: 'Done' }).click()
  await expect(
    page.locator('section').filter({ hasText: 'Template Project' }).locator('li').filter({ hasText: 'Write the docs' }),
  ).toContainText('Reopen')
})

test('data export: student downloads their classroom zip; hats are enforced', async ({ page }) => {
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-a/export')
  await expect(page.getByRole('heading', { name: 'Export your data' })).toBeVisible()
  // Charlie is a plain student: no professor hat offered for classroom.
  await expect(page.getByRole('link', { name: 'Professor (full class data)' })).not.toBeVisible()
  await expect(page.getByText('My homework submissions')).toBeVisible()

  const downloadPromise = page.waitForEvent('download')
  await page
    .locator('section')
    .filter({ hasText: 'Classroom' })
    .getByRole('button', { name: 'Download zip' })
    .click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^demo-a-classroom-.*\.zip$/)

  // Verify the zip's actual contents.
  const path = await download.path()
  const JSZip = (await import('jszip')).default
  const fs = await import('node:fs')
  const zip = await JSZip.loadAsync(fs.readFileSync(path!))
  const names = Object.keys(zip.files)
  expect(names).toContain('my-submissions.csv')
  expect(names).toContain('my-submissions.json')
  expect(names).toContain('README.txt')
  const submissions = JSON.parse(await zip.files['my-submissions.json']!.async('string'))
  expect(submissions.length).toBeGreaterThan(0)
  expect(submissions[0].homework.title).toBe('Homework 1 — Descriptive statistics')

  // Professor sees the hat picker and can deliberately choose the student hat.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-a/export')
  await expect(page.getByRole('link', { name: 'Professor (full class data)' })).toBeVisible()
  await page.getByRole('link', { name: 'Student (what I entered)' }).click()
  // Scope to the download form — the staff controls panel repeats set labels.
  const dlForm = page.locator('section').filter({ hasText: 'Classroom' }).locator('form[action="/api/export"]')
  await expect(dlForm.getByText('My homework submissions')).toBeVisible()
  await expect(dlForm.getByText('Full gradebook')).not.toBeVisible()

  // Export controls: professor shuts off the student hat entirely.
  const controls = page.locator('section').filter({ hasText: 'Classroom' }).locator('details')
  await controls.locator('summary').click()
  await controls.locator('input[name="allowedHats"][value="student"]').uncheck()
  // Wait for the server-action POST to complete before navigating —
  // client-side signals (checkbox/details state) can false-positive.
  const saved1 = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/export'))
  await controls.getByRole('button', { name: 'Save controls' }).click()
  await saved1
  // Staff bypass their own switches — alice still sees the student hat link.
  await expect(page.getByRole('link', { name: 'Student (what I entered)' })).toBeVisible()

  // Charlie (plain student) is now fully shut off.
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-a/export')
  await expect(
    page.locator('section').filter({ hasText: 'Classroom' }).getByText('turned off for your role'),
  ).toBeVisible()
  await expect(
    page.locator('section').filter({ hasText: 'Classroom' }).getByRole('button', { name: 'Download zip' }),
  ).not.toBeVisible()

  // Professor re-enables; charlie can export again.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-a/export')
  const controls2 = page.locator('section').filter({ hasText: 'Classroom' }).locator('details')
  await controls2.locator('summary').click()
  await controls2.locator('input[name="allowedHats"][value="student"]').check()
  const saved2 = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/export'))
  await controls2.getByRole('button', { name: 'Save controls' }).click()
  await saved2

  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-a/export')
  await expect(page.getByText('My homework submissions')).toBeVisible()
  // Authorship principle (founder correction): what the professor published
  // for students to SEE is not theirs to export — no materials set offered.
  await expect(page.getByText('Class materials published to me')).not.toBeVisible()
  await expect(page.getByText('My survey answers')).toBeVisible()
})

test('data export: salon hats follow authorship — customer exports visits, cashier gets no client data', async ({ page }) => {
  // charlie is a salon CUSTOMER: his hat exports his own record + visits.
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-salon/export')
  await expect(page.getByText('My appointments & visit history')).toBeVisible()

  // eve is the CASHIER: she sees customers all day, but her export offers
  // only the bills SHE processed — no customer data sets (founder's
  // salesperson rule, docs/03).
  await signIn(page, 'eve@demo.local')
  await page.goto('/o/demo-salon/export')
  await expect(page.getByText('Bills I created')).toBeVisible()
  await expect(page.getByText('My customer record')).not.toBeVisible()
  await expect(page.getByText('Full appointment book')).not.toBeVisible()
})

test('help walkthroughs: role-aware — student sees their guide, professor sees all', async ({ page }) => {
  // Charlie (student): sees the student guide, no staff guides listed, and a
  // direct link to a staff guide 404s (enforced, not just hidden).
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-a/help')
  await expect(page.getByRole('heading', { name: 'Help & walkthroughs' })).toBeVisible()
  await expect(page.getByRole('link', { name: /Student — take a class/ })).toBeVisible()
  await expect(page.getByRole('link', { name: /Professor — run a course/ })).not.toBeVisible()
  await page.goto('/o/demo-a/help/classroom/professor')
  await expect(page.getByText('404')).toBeVisible()

  // The student guide renders its numbered steps.
  await page.goto('/o/demo-a/help/classroom/student')
  await expect(page.getByRole('heading', { name: /Student — take a class/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Submit homework' })).toBeVisible()

  // Alice (professor): sees and opens the staff guide.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-a/help')
  await expect(page.getByRole('link', { name: /Professor — run a course/ })).toBeVisible()
  await page.getByRole('link', { name: /Professor — run a course/ }).click()
  await expect(page.getByRole('heading', { name: 'Run the homework grading workflow' })).toBeVisible()
})

test('visual messaging: create from a picture, draw a reply, membership gates access', async ({ page }) => {
  // Alice starts a conversation from an image.
  const title = 'Family sketch ' + Date.now()
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-visual/m/visual-messaging')
  await page.getByPlaceholder('Title').fill(title)
  await page.setInputFiles('input[name="image"]', {
    name: 'photo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#cbd5e1"/></svg>'),
  })
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  await expect(page.getByText('No replies yet — draw one above.')).toBeVisible()

  // Enter draw mode, ink a stroke, send it as a reply layer.
  await page.getByRole('button', { name: 'Draw a reply' }).click()
  const stage = page.locator('canvas').first()
  await expect(stage).toBeVisible()
  const box = (await stage.boundingBox())!
  await page.mouse.move(box.x + 60, box.y + 60)
  await page.mouse.down()
  await page.mouse.move(box.x + 180, box.y + 120, { steps: 8 })
  await page.mouse.move(box.x + 240, box.y + 200, { steps: 8 })
  await page.mouse.up()
  await page.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('Replies to this layer (1)')).toBeVisible()

  // Descend into the reply. Wait for a LEAF-unique signal before swiping —
  // 'by Alice A' matches the root too, and swiping against the old page's
  // nav props makes 'up' a no-op (the root has no parent).
  await page.getByRole('link', { name: 'Layer 1.1' }).click()
  await expect(page.getByText('Replies to this layer (0)')).toBeVisible()
  await expect(page.getByText(/by Alice A ·/).first()).toBeVisible()

  // Swipe navigation (view mode): swipe RIGHT on the canvas → back up to the
  // root; swipe LEFT → descend into the first reply again.
  const b2 = (await page.locator('canvas').first().boundingBox())!
  await page.mouse.move(b2.x + 80, b2.y + 120)
  await page.mouse.down()
  await page.mouse.move(b2.x + 260, b2.y + 124, { steps: 6 })
  await page.mouse.up()
  await expect(page.getByText('Replies to this layer (1)')).toBeVisible() // back at the root
  const b3 = (await page.locator('canvas').first().boundingBox())!
  await page.mouse.move(b3.x + 260, b3.y + 120)
  await page.mouse.down()
  await page.mouse.move(b3.x + 80, b3.y + 124, { steps: 6 })
  await page.mouse.up()
  await expect(page.getByText('Replies to this layer (0)')).toBeVisible() // in the leaf again

  // Tree view: every layer as a clickable thumbnail, grouped by level.
  await page.getByRole('link', { name: 'Tree view' }).click()
  await expect(page.getByTestId('layer-grid')).toBeVisible()
  await expect(page.getByText('Level 1', { exact: true })).toBeVisible()
  await expect(page.getByText('Level 2', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'open layer 1.1' }).click()
  await expect(page.getByText('Replies to this layer (0)')).toBeVisible() // jumped to the leaf
  await expect(page.getByRole('link', { name: 'Tree view' })).toBeVisible() // back in layer view

  // Charlie is NOT a member: the conversation is invisible to him.
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-visual/m/visual-messaging')
  await expect(page.getByRole('link', { name: title })).not.toBeVisible()

  // Alice adds charlie; now he can open it and see the reply tree.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-visual/m/visual-messaging')
  await page.getByRole('link', { name: title }).click()
  await page.getByPlaceholder('member@email').fill('charlie@demo.local')
  const added = page.waitForResponse((r) => r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Add member' }).click()
  await added

  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-visual/m/visual-messaging')
  await page.getByRole('link', { name: title }).click()
  await expect(page.getByText('Replies to this layer (1)')).toBeVisible()

  // Charlie flags the reply layer (a non-moderator member — he has no
  // moderation controls of his own).
  await page.getByRole('link', { name: 'Layer 1.1' }).click()
  await expect(page.getByText('Replies to this layer (0)')).toBeVisible()
  await page.getByText('Flag this layer').click()
  await page.locator('select[name="reason"]').selectOption('inappropriate')
  await page.getByPlaceholder('Details (optional)').fill('not appropriate for the group')
  const flagged = page.waitForResponse((r) => r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Flag' }).click()
  await flagged
  await expect(page.getByText('Moderation')).not.toBeVisible() // charlie isn't a moderator

  // Alice (the conversation admin) reviews the queue and removes the layer.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-visual/m/visual-messaging')
  await page.getByRole('link', { name: title }).click()
  await expect(page.getByText('Flagged content (1 open)')).toBeVisible()
  await expect(page.getByText(/inappropriate — not appropriate for the group · reported by Charlie C/)).toBeVisible()
  await page.getByRole('link', { name: 'Review layer 1.1' }).click()
  // Wait for a signal unique to the destination before acting — otherwise the
  // click can fire against the still-rendered root page (its bound
  // current.id), tombstoning the ROOT layer instead of 1.1.
  await expect(page.getByText('Replies to this layer (0)')).toBeVisible()
  const removed = page.waitForResponse((r) => r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Remove this layer' }).click()
  await removed
  await expect(page.getByText('removed', { exact: true })).toBeVisible()
  const actioned = page.waitForResponse((r) => r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Mark actioned' }).click()
  await actioned
  await expect(page.getByText('Flagged content (0 open)')).toBeVisible()

  // Charlie now sees the layer as removed — but the tree still makes sense.
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-visual/m/visual-messaging')
  await page.getByRole('link', { name: title }).click()
  await page.getByRole('link', { name: 'Layer 1.1' }).click()
  await expect(page.getByText('removed', { exact: true })).toBeVisible()
})

test('visual messaging: deep-link join of an open conversation (viewer seat)', async ({ page }) => {
  // Alice creates a conversation. Dana is an org + module member but NOT a
  // member of this conversation — the deep-link join case.
  const title = 'Shared album ' + Date.now()
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-visual/m/visual-messaging')
  await page.getByPlaceholder('Title').fill(title)
  await page.setInputFiles('input[name="image"]', {
    name: 'photo.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#e2e8f0"/></svg>'),
  })
  await page.getByRole('button', { name: 'Create' }).click()
  await page.getByRole('link', { name: title }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible()
  const conversationUrl = page.url()

  // Default is invite-only; the admin opens the conversation to link-joining.
  await expect(page.getByText('Link joining: invite-only')).toBeVisible()
  const opened = page.waitForResponse((r) => r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Open to anyone with the link' }).click()
  await opened
  await expect(page.getByText('Link joining: open')).toBeVisible()

  // Dana follows the deep link, is offered a join, and takes a viewer seat.
  await signIn(page, 'dana@demo.local')
  await page.goto(conversationUrl)
  await expect(page.getByRole('heading', { name: 'Join this conversation?' })).toBeVisible()
  await page.getByRole('button', { name: 'Join conversation' }).click()
  await expect(page.getByRole('heading', { name: title })).toBeVisible() // redirected in as a member
  await expect(page.getByText('Replies to this layer (0)')).toBeVisible()
  // A viewer may watch but not draw — no draw affordance.
  await expect(page.getByRole('button', { name: 'Draw a reply' })).not.toBeVisible()
})

test('public schedule page works with no login', async ({ page }) => {
  await page.goto('/s/demo-shul')
  await expect(page.getByRole('heading', { name: 'Demo Synagogue' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Weekday Schedule' })).toBeVisible()
  await expect(page.getByText('6:00 PM')).toBeVisible()
  // An unpublished/unknown org 404s.
  await page.goto('/s/no-such-shul')
  await expect(page.getByText('404')).toBeVisible()
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
