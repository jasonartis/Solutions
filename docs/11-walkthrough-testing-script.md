# Founder Testing Script — every module, every level, from zero

Follow this top to bottom. Every chapter says who to sign in as and which
in-app guide to follow; the guides themselves contain the numbered
click-by-click steps, so this document only sequences them and adds the
platform-level checks.

## Where to test — pick one

**Option A — Production (any browser, nothing to install):**
- Start at **https://solutions-platform.vercel.app**
- Demo password: the one given to you privately (deliberately written
  nowhere). **Lost it?** Any session can set a new one by re-seeding prod:
  load .env.deploy values, then run the seed with SEED_ALLOW_REMOTE=yes,
  DEMO_PASSWORD=<new password>, and SUPABASE_URL/SERVICE_ROLE_KEY pointed at
  the prod project. Local is always password123.
- Background-worker steps (marked ⚙ below): open a terminal in the repo
  folder and run **`pnpm worker:prod`** — leave that window open while you
  test. Without it, ⚙ steps queue and complete whenever it next runs.

**Option B — Fully local / offline (the dev PC, no internet needed):**
1. Start Docker Desktop (whale icon running).
2. Open a terminal in `d:\Solutions Platform` and run **`pnpm dev`**
   (or double-click `scripts\start-dev.bat`). Wait for `Ready`.
3. If this is a fresh database, also run **`pnpm seed`** in a second terminal.
4. Test at **http://localhost:3000** — demo password is `password123`.
5. The background worker is ALREADY running (`pnpm dev` starts it), so ⚙
   steps just work — nothing extra to start.
6. When done: `Ctrl+C`, then `pnpm stop`.

Everything below is identical in both options.

**The cast** (all `<name>@demo.local`, with the password for your option):

| Login | Plays |
|---|---|
| owner | Platform superadmin |
| alice | The staff side of everything: professor, matchmaking admin, salon manager, synagogue maker, event organizer, conversation admin |
| bob | An org with no modules (the "empty" experience) |
| charlie | The everyman member: student, single, salon customer, event participant, visual-messaging member |
| dana | Second student, single, salon worker, participant, VM member |
| gabe | Classroom GA |
| eve | Single, salon cashier, participant |
| frank | Single, participant |
| mel | Matchmaker |

**How to give feedback:** `module / guide / step N — what happened`. Screenshots welcome.

**⚙ = needs the background worker running** (auto-rescoring in matchmaking,
the speed-dating automatic round clock, synagogue exports). Local testing:
already running via `pnpm dev`. Production testing: run `pnpm worker:prod`
in a repo terminal — each ⚙ chapter repeats this reminder in place.

---

## Chapter 0 — Orientation (10 min)

1. Sign in as **bob**. You should see one org (Demo Org B), "No modules
   enabled", and nothing else — no other org's names anywhere.
2. In the address bar, type `/o/demo-a/m/classroom` after the domain. You
   should get a 404 — bob cannot reach an org he isn't in, even by URL.
3. Sign out (top right). Sign in as **owner**. You see every demo org plus
   the **Owner Console** link (create orgs, toggle modules). Look, don't
   change anything.
4. Sign in as **alice**. This is the view you'll use most: each org card has
   its module buttons plus **Help** and **Export data**. Click **Help** on
   Demo Org A and skim the index — as staff, alice sees every guide.

## Chapter 1 — Sample module (module 0, 10 min)

The template every future module is copied from — worth testing first
because it's the smallest complete example.

5. As **alice**, Demo Org A → Help → *Manager — create projects*. Follow it.
6. Sign in as **charlie** → Demo Org A → Help. Confirm the manager guide is
   NOT listed for him. Follow *Member — add and complete items*.

## Chapter 2 — Classroom (45 min, the deepest module)

7. As **charlie**: Help → *Student — take a class...*. Follow all steps
   (materials, homework upload, survey; peer review appears later).
8. As **alice**: *Professor — run a course end to end*. Follow it fully —
   materials with a visibility window, homework, the grading workflow
   (move stages, GA grade as yourself, peer review, compute finals), an
   exam with subproblems, surveys, retention date, export controls.
9. As **gabe**: *GA — grade homework and exams*. Follow it.
10. Back as **charlie**: complete the peer review that now exists, then
    check **Your grades**.

## Chapter 3 — Make-a-Match (20 min)

> ⚙ One step here (automatic rescoring) uses the background worker.
> **Local:** nothing to do — `pnpm dev` already runs it.
> **Production:** run `pnpm worker:prod` in a terminal at the repo and leave
> it open. (The admin's manual Recompute button works either way.)

11. As **dana**: *Single — answer questions...*. Answer, move sliders, and
    check **Share this answer with a potential match** on one answer.
12. As **charlie**: same guide — his matches should show dana's shared
    answer marked *(shared with you)*. Change an answer and watch
    *(recompute pending)* appear (it clears automatically only while the
    worker runs ⚙; the admin button always works).
13. As **mel**: *Matchmaker — review matches...*.
14. As **alice**: *Admin — questions, locks, and recomputes*. Approve or
    reject something, add a locked question, recompute.

## Chapter 4 — Nail Salon (30 min)

15. As **charlie**: *Customer — book appointments...*. Book, then cancel.
16. As **alice** (or **eve** for the pure-cashier view): *Cashier — day
    board...*. Walk one appointment booked → paid; add a walk-in.
17. As **dana**: *Worker — run your chairs*. Start and complete one.
18. As **alice**: *Manager — catalog, promotions, and the books*. Add a
    service, a promotion, an expense; run a shopping item to purchased.

## Chapter 5 — Speed Dating (30 min)

> ⚙ The automatic round clock runs in the background worker.
> **Local:** already running via `pnpm dev`.
> **Production:** run `pnpm worker:prod` in a repo terminal before starting
> the event. (The organizer's manual "Run next round" button works without
> it, but the self-advancing clock is worth seeing.)

19. As **charlie**, then **dana** (and **eve**/**frank** if you like a fuller
    event): *Participant — from registration...*. Register everyone.
20. As **alice**: *Organizer — create and run an event*. Open, start, run
    rounds (manual button works without the worker; the automatic clock
    needs it ⚙), complete, reveal.
21. Back as **charlie** and **dana**: mark interest in each other mid-event,
    and after the reveal both should see *It's a match!* — and nobody else
    sees anything.

## Chapter 6 — Synagogue Schedules (20 min)

> ⚙ Exports (PDF/JPG rendering) run in the background worker.
> **Local:** already running via `pnpm dev`.
> **Production:** run `pnpm worker:prod` in a repo terminal before clicking
> Export. Without it, the export queues and finishes whenever the worker
> next runs — nothing is lost.

22. As **alice** on Demo Synagogue: *Maker — build rules, publish weeks,
    export*. Also try the public no-login page: open `/s/demo-shul` in a
    private/incognito window.
23. Your real org: sign in with YOUR account and repeat on `pozne` —
    docs/08 is the original deep walkthrough for it.

## Chapter 7 — Visual Messaging (20 min)

24. As **alice** on Demo Visual: *Member — draw your side...*. Create a
    conversation from any photo, draw a reply, descend into it. Add
    charlie as a member.
25. As **charlie**: open it, draw a reply to alice's layer, react with ❤️.
26. As **alice**: *Moderator — keep conversations healthy* (moderation
    actions are per-layer today; the queue UI is coming).

## Chapter 8 — Platform: export & controls (15 min)

27. As **charlie** on Demo Org A: **Export data** → download the zip; open
    the CSVs — they contain what charlie entered, nothing the professor
    published.
28. As **alice**: in **Export controls**, uncheck the student hat, save.
    As **charlie**: the export should now say it's turned off for your role.
    As **alice**: re-enable it.

---

When you're done (or as you go): send feedback as `module / guide / step N`.
Anything that made you stop and think is a finding — the goal is that a
stranger can do everything you just did.
