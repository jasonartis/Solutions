# Running To-Do (Jason)

A living list, same spirit as `founder-feedback.md` — I add new things for
you to test or do as they come up; you check them off (or just leave notes)
as you go. No fixed order unless noted. Older, already-resolved items are
removed rather than kept as clutter — check `founder-feedback.md` and the
module specs in `docs/modules/` for history of what's already been decided
and built.

---

## TO DO — Oracle Cloud free-tier VPS signup (~15-20 min, in the browser)

This is the free path we discussed for the worker/Jitsi VPS (docs/10 has the
full Hetzner-vs-Oracle writeup and the Hetzner runbook this mirrors —
switching providers later is low-cost, same Docker setup either way).

1. Go to **cloud.oracle.com/free** → **Start for free**. Sign up with email +
   password; verify the email.
2. Oracle's signup asks for a **credit/debit card** even for the free tier —
   this is identity verification only; the Always Free resources genuinely
   never charge it. (If you'd rather not enter a card at all, that rules out
   Oracle entirely and Hetzner's ~$5/mo becomes the only option — let me know
   if you'd rather just do that instead of dealing with this.)
3. Pick your **Home Region** carefully — you cannot easily change it later,
   and Always-Free ARM capacity availability varies a LOT by region. Pick
   somewhere with a good chance of ARM capacity (US regions are usually
   safest bets, e.g. Ashburn/us-ashburn-1 if offered).
4. Once your account/dashboard is active, go to **Compute → Instances →
   Create Instance**:
   - **Image:** Ubuntu (24.04 or latest LTS available).
   - **Shape:** click **Change Shape** → **Ampere** → **VM.Standard.A1.Flex**
     — this is the ARM shape that's Always-Free-eligible. Set it to the max
     free allowance (usually 4 OCPUs / 24GB RAM total across all your A1
     instances — one instance can use all of it).
   - **SSH keys:** generate one if you don't have one yet (same as the
     Hetzner runbook: `ssh-keygen -t ed25519` in PowerShell, then paste the
     `.pub` file's contents here).
5. **Create**. If you get an "Out of capacity" error for A1.Flex — this is
   the well-known free-tier capacity issue, not a mistake on your part. Try:
   - A different Availability Domain (if your region has more than one).
   - Retrying every so often (people often get one within a day or two of
     periodic retries).
   - If it's persistently unavailable, that's a real signal this path isn't
     going to work reliably — tell me and we'll just go with Hetzner.
6. Once the instance is running, note its **public IP** from the instance
   details page.
7. **One thing Oracle needs that Hetzner didn't**: by default Oracle's
   virtual network blocks incoming traffic. Go to your instance's **Subnet**
   link → **Security Lists** → the default list → **Add Ingress Rules** →
   allow TCP ports **8901** (worker health) and whatever port a future Jitsi
   setup needs (I'll tell you when we get there). Source CIDR `0.0.0.0/0` is
   fine for now.
8. Stop here and tell me the public IP — I'll take it from there (Part 2/3
   of the Hetzner runbook in docs/10 apply the same way: SSH in, install
   Docker, clone the repo, done).

---

## Keep testing whatever you'd like

Everything is live and fair game. Known gaps are tracked in each module's
spec under `docs/modules/` (search for "remaining" or "still not built") and
in `docs/04-build-plan.md`'s per-module status lines — check there before
assuming something's a new bug, but if in doubt, just write it up in
`founder-feedback.md` anyway; better a duplicate note than a missed one.

## Optional glance-overs

- **Vercel dashboard** (vercel.com): Deployments — all green? Any failures?
- **Supabase dashboard** (supabase.com): prod project "Active" (not paused)?
  Any errors in Logs?
