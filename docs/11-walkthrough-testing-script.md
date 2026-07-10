# Founder Testing Script — every module, every level, from zero

Follow this top to bottom. You need: a browser, the production URL, and the
demo password (given to you privately — it is deliberately written nowhere).
Every chapter says who to sign in as and which in-app guide to follow; the
guides themselves contain the numbered click-by-click steps, so this document
only sequences them and adds the platform-level checks.

**Start here:** https://solutions-platform.vercel.app

**The cast** (all `<name>@demo.local`, all with the demo password):

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

**Two steps need the background worker** (marked ⚙ below): synagogue exports
and the speed-dating automatic round clock. Tell me before those chapters and
I'll run `pnpm worker:prod`, or run it yourself in a terminal at the repo.

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

## Chapter 5 — Speed Dating (30 min) ⚙ for the auto-clock

19. As **charlie**, then **dana** (and **eve**/**frank** if you like a fuller
    event): *Participant — from registration...*. Register everyone.
20. As **alice**: *Organizer — create and run an event*. Open, start, run
    rounds (manual button works without the worker; the automatic clock
    needs it ⚙), complete, reveal.
21. Back as **charlie** and **dana**: mark interest in each other mid-event,
    and after the reveal both should see *It's a match!* — and nobody else
    sees anything.

## Chapter 6 — Synagogue Schedules (20 min) ⚙ for exports

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
