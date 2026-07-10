// Classroom walkthroughs (docs/03 user-walkthrough decision). One guide per
// role, numbered click-by-click. UPDATE RULE: any change to this module's UI
// updates the matching steps here IN THE SAME COMMIT.
import type { ModuleHelp } from '@platform/core'

export const classroomHelp: ModuleHelp = {
  moduleKey: 'classroom',
  guides: [
    {
      role: 'student',
      title: 'Student — take a class from enrollment to final grade',
      body: `
## What you can do
See your classes, read announcements, open published materials, submit homework
files, review a classmate's work anonymously, answer surveys, and see the
grades your professor publishes.

## Your class page

1. Sign in and click your organization's **Classroom** button on the Dashboard.
2. You land on **Classes** — one card per class you're enrolled in. Each card
   shows **Materials**, **Announcements**, **Homework**, and (when relevant)
   **Peer reviews assigned to you**, **Your grades**, and **Surveys**.

## Open a published material

3. Under **Materials**, click any title. Links open the professor's page or
   file. If a material you expect is missing, its visibility window may not
   have opened yet — ask your professor.

## Submit homework

4. Under **Homework**, click the assignment's name (e.g. "Homework 1").
5. On the homework page, click **Choose file**, pick your file, click
   **Upload**. The file appears in the list — upload as many as you need.
6. To replace a file before the deadline, click **Remove** next to it and
   upload again. After the deadline (or once grading starts) the page says
   the submission is locked.

## Peer review (when assigned)

7. Back on **Classes**, a **Peer reviews assigned to you** section lists each
   review with a *pending* or *graded* tag. Click one.
8. On the review page: open the submission's files, type comments in the
   **Your comments** box (the author never sees your name), enter a number in
   **Your grade**, and click **Submit grade**. You can update it until the
   professor closes the round.

## Surveys

9. Under **Surveys**, type your answer and click **Submit** (or **Update** to
   change it). If the professor shares results, the counts appear under the
   question.

## Your grades

10. **Your grades** lists each assignment's final grade once your professor
    publishes it. Only finals you're meant to see appear here.

## Export your data

11. From the Dashboard, click **Export data** on your organization's card to
    download what you entered (submissions, comments, survey answers) as a
    zip of spreadsheets. Your professor may disable this per class policy.
`,
    },
    {
      role: 'ga',
      title: 'GA — grade homework and exams',
      staff: true,
      body: `
## What you can do
Enter GA grades for homework submissions and exam subproblems. (Moving the
workflow between stages and publishing finals are professor actions.)

## Grade homework

1. Open **Classroom → Manage** and click a homework's name to open its
   grading console.
2. Each student row shows their state. When a row is in **ga_grading**, enter
   a number in the **GA grade** box and click **Save**.
3. The **Peer reviews** column fills in as students complete their reviews —
   read-only context for you.

## Grade an exam by subproblem

4. From **Manage**, click an exam under **Exams**.
5. Per student: click **Upload scan** to attach the paper's scan (repeat for
   multiple pages), then enter points per subproblem (each box shows its
   maximum) and click **Save scores**. The total computes automatically.

## Notes

- You always see the whole grading picture, but only the **GA** column is
  yours to write.
- After the class's retention date, student submissions hide from your view
  too — the professor retains access.
`,
    },
    {
      role: 'professor',
      title: 'Professor — run a course end to end',
      staff: true,
      body: `
## What you can do
Everything: materials with visibility windows, homework, the grading
workflow (GA → peer review → finals), exams, surveys, rosters, retention,
and export controls.

## Set up content

1. Open **Classroom → Manage**. Each class card has forms for announcements,
   homework, exams, and surveys; the header links to **Materials**.
2. **Materials**: add a title + URL or file upload per course item. In its
   row, set optional **From/Until** dates per class and click **Publish** —
   students only see it inside that window (enforced by the database, not
   just the page). **Unpublish** removes access; **Update** changes the window.
3. **Homework**: type a title, optionally a due date, click **Add homework**.
   Students can upload until the deadline.
4. **Exams**: title plus a problem structure like \`1a:10, 1b:5, 2:20\`
   (label:points, comma-separated) — this drives per-subproblem grading.
5. **Surveys**: add a question; later click **Show results to class** to
   reveal aggregate counts (never individual answers).

## Run the homework grading workflow

6. From **Manage**, click a homework to open its grading console. Buttons at
   the top drive the stages:
   - **Move submitted → GA grading** freezes student uploads; GAs grade.
   - **Move GA-graded → peer review** (set reviews-per-student first)
     auto-assigns who reviews whom — never their own, balanced, no repeat
     pairings across the semester.
   - **Finalize peer review → done** averages each submission's peer grades.
7. **Compute finals**: set the weights (default GA ×0.8 + Peer ×0.2) and
   click **Compute finals** — each student's final renormalizes over the
   components they actually have. Type in a row's **Final** box and click
   **Update** to override; overrides survive recomputes.

## Grade exams

8. From **Manage**, click the exam. Per student: **Upload scan**, enter
   points per subproblem, **Save scores**, then **Publish final** (defaults
   to the computed total).

## Retention (never deletes anything)

9. On a class card, set **Hide submissions from** and click **Save
   retention** — from that date, submissions hide from students AND GAs;
   you keep access. In the grading console, set a row's **reveal until**
   date to temporarily re-show one submission. Clearing the date restores
   everything.

## Export controls

10. From the Dashboard, click **Export data** → your module's **Export
    controls** panel. Uncheck a hat or data set to shut off exporting for
    the levels below you; your own exports are unaffected.
`,
    },
  ],
}
