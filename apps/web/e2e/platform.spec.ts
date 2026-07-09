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
  // Charlie's top match is Dana (91%) from the seeded answers; same-gender
  // pairs are excluded by the gender dealbreaker and never appear.
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-match/m/matchmaking')
  await expect(page.getByRole('heading', { name: 'Make-a-Match' })).toBeVisible()

  const matches = page.locator('h2', { hasText: 'Your matches' }).locator('xpath=following-sibling::ul[1]')
  await expect(matches).toContainText('Dana D')
  await expect(matches).toContainText('91%')
  await expect(matches).not.toContainText('Frank F') // same gender → excluded

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
  await page.getByRole('button', { name: 'Run next round (pair everyone)' }).click()

  // Charlie marks interested in Dana; Dana sees NO match yet (one-sided).
  await signIn(page, 'charlie@demo.local')
  await page.goto('/o/demo-dating/m/speed-dating')
  await page.getByRole('link', { name: 'Friday Night Mixer' }).click()
  await expect(page.getByText('People you met')).toBeVisible()
  await expect(page.getByText('Dana D')).toBeVisible()
  await page.getByRole('button', { name: 'interested', exact: true }).click()

  await signIn(page, 'dana@demo.local')
  await page.goto('/o/demo-dating/m/speed-dating')
  await page.getByRole('link', { name: 'Friday Night Mixer' }).click()
  await expect(page.getByText("It's a match!")).not.toBeVisible()
  // Dana reciprocates.
  await page.getByRole('button', { name: 'interested', exact: true }).click()
  // Still unrevealed — mutual interest alone shows nothing until the organizer reveals.
  await expect(page.getByText("It's a match!")).not.toBeVisible()

  // Organizer completes the event and reveals.
  await signIn(page, 'alice@demo.local')
  await page.goto('/o/demo-dating/m/speed-dating')
  await page.getByRole('link', { name: 'Friday Night Mixer' }).click()
  await page.getByRole('button', { name: 'Complete event' }).click()
  await page.getByRole('button', { name: 'Reveal mutual matches' }).click()

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
