# First Shul Walkthrough — hands-on test script (Jason: pozne)

A click-by-click exercise on **production** to build and publish a working schedule.
Written 2026-07-07 for the `pozne` org (location already configured: Brooklyn/US11210,
America/New_York). Works identically for any future shul org.

**Before you start:** be signed in at https://solutions-platform.vercel.app/login
(as `jasonartisenergy@gmail.com`). If any module page "doesn't load," sign in first,
then hard-refresh (`Ctrl+Shift+R`).

## Part 1 — Build a schedule (~2 minutes)

1. Go to `https://solutions-platform.vercel.app/o/pozne/m/synagogue-schedules` → click **Setup**.
2. Bottom of page, **New schedule type**: name `Erev Shabbos Schedule`, check trigger
   **erev-shabbat** only → **Create schedule type**.
3. In the new card: type `ערב שבת` in **New section name** → **Add section**.
4. **Add line** #1 (fixed time): name `Shachris` → time kind **Fixed clock time** →
   `07:00` → **Add line**.
5. **Add line** #2 (zman-based — the magic): name `Mincha & Kabbolas Shabbos` →
   kind **Zman-based time** → zman **sunset** → offset `-20` → round to `5`, **down**
   → **Add line**.
6. Click **View schedules →**: your document shows this Friday with Shachris 7:00 AM
   and a Mincha time computed from *this Friday's actual Brooklyn sunset*, rounded
   down to 5. Click **Next →** a few times — Mincha drifts with the sun, Shachris stays.

## Part 2 — Publish to the world (~30 seconds)

7. Back in **Setup** → **Published weeks** → pick this week's **Sunday** date →
   **Publish week**.
8. Open an **incognito window** (no login): `https://solutions-platform.vercel.app/s/pozne`
   — the public page any congregant can open from a WhatsApp link.

## Part 3 — Extra credit (each ~1 minute)

- **Self-updating title:** create a schedule type named `{shabbatTitle}` with trigger
  **shabbat** + **erev-shabbat** — its heading becomes
  "שבת פרשת … - שבת מברכים תשפ״ו" automatically, right parsha every week.
- **Friday-anchored time:** add a line with zman **candle-lighting** (or type `Candles`
  in the free-text box) and aggregate **Friday's value** — the classic "Hadlakas Neiros"
  that shows Friday's time even on the Shabbos document.
- **"+10 after another line":** add a line, time kind **After another line (+ offset)**,
  referenced line `Mincha & Kabbolas Shabbos` (exact name), offset `10`.
- **Floor/clamp:** a `Mincha Gedolah` line — zman **mincha-gedola**, "not before" `13:30`.
- **Weekly message:** Setup → **Weekly message** → pick section + this week's Sunday +
  `Kiddush sponsored by …` (Hebrew field optional) — appears only on that week.
- **Off-season text:** any line + season **winter only** + fallback text
  `Will IY"H resume next week` — in summer it shows the text instead of vanishing.

## Known limitations right now (documented, not bugs)

- **Export this week** (PDF/JPG files) does nothing on production yet — the render
  worker isn't deployed to a server (docs/05 Phase B: VPS). It works on the dev machine.
  The button will queue a request that stays "pending".
- **Zmanim source is the built-in calculator (hebcal)** until the myzmanim credentials
  issue is resolved (parked — see module SPEC). Times are correct but may differ by a
  minute or two from myzmanim's rounding on some zmanim.
- The in-app **Help** link (next to Setup) has the full guide with more examples.

## If something misbehaves

Note exactly what the screen shows (404 page / "Application error" / blank / redirect
to login) and tell Claude — each symptom points at a different layer.
