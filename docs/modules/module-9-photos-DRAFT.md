# Module 9 (proposed): Photos — shared family/org photo archive

> **STATUS: DRAFT / PLANNING — do not build.** Captured from the founder's
> planning conversation of 2026-11-03. Decisions below are the founder's,
> dated; everything under "Open" is not decided. An adversarial review pass
> (legal, product, security/abuse, cost/architecture) runs against this draft
> next and its findings are appended as a dated section.

## Problem & context

An org's members contribute photos and describe them: who is in them, where,
when, and free labels ("too much fun", "hard at work"). Everyone finds photos
by any of those, keeps private favourites, and exports what they want.

**First real client: the founder's own family**, set up as an org. That shapes
every default: many of the people in the photos are NOT members (including
deceased grandparents), many photos are SCANS of old prints with no reliable
date, and the archive is meant to last decades.

The motivating example (founder, 2026-11-03):

> *Top row, left to right: A, B, C. Second row: D, E, F, G. Under the
> umbrella: H and I. At the grand hiet in the summer of 1988, with grandpa
> Joe's band.*

## Decisions (founder, 2026-11-03)

1. **No face recognition. Ever, for v1 and as a direction.** Biometric data;
   manual people tags do the job.
2. **One mechanism: everything is a tag.** Labels, albums, favourite lists and
   people are tags with different settings, not separate features:

   | Setting | Label | Album | Favourite list | Person | Place |
   |---|---|---|---|---|---|
   | Visible to | org | org | **only the owner** | org | org |
   | Who may add photos | anyone | anyone (owner-only is a setting) | owner | anyone | anyone |
   | Ordered + cover photo | no | yes | optional | no | no |
   | Row/position within the photo, 👍/👎 | no | no | no | **yes** | no |

   A "smart album" is a saved tag search (e.g. `Harry AND 1988`).
   **Deleting a tag or album never deletes a photo** (rule X, founder chose it
   once he confirmed photos survive). Photos are deleted only by their
   uploader or by an admin moderating.
3. **People are TEXT tags, not member accounts.** Most subjects are not
   members, some are deceased. Consequently there is no per-person opt-out of
   being tagged (nothing to attach it to). Tools needed because text drifts:
   fuzzy "did you mean Harry Johnson?" autocomplete, **rename**, **merge**
   (harry + haRy → Harry Johnson), **split** (re-assign photo by photo when
   "Harry" turns out to be two people), and an edit history with undo.
   *Later idea, not v1:* a member may "claim" a person tag as themselves.
4. **Who is in the photo = ordered groups.** A photo has zero or more named
   groups ("Top row", "Under the umbrella"), each an ordered left-to-right
   list of person tags. The caption is generated from it. **No tap-on-face
   pins, and no pin coordinates stored** (founder is unsure they are ever
   needed; adding them later is additive).
5. **Anyone may tag; the tag keeper curates.** A new module position, "tag
   keeper", may rename/merge/split tags and approve new ones. Any member may
   apply existing tags. **A member may create a new tag and use it
   immediately; it shows as PENDING until the keeper approves, merges it into
   an existing tag, or rejects it.** (Founder chose "use now, pending" so a
   long tagging session never stalls.)
6. **👍/👎 on each person-in-photo entry** so wrong identifications surface;
   enough 👎 marks the entry "disputed".
7. **Visibility v1: everyone in the org sees everything.** No per-album
   audiences (no entity-level visibility, docs/22 §20.2 stays deferred).
8. **Org-only. No links for people outside the org in v1.**
9. **Departed uploaders: their photos stay**, credited "Former member" per the
   docs/21 silhouette.
10. **Keep the full original by default; display a smaller copy by default.**
    Each photo stores three files: thumbnail (~400px, grids), display copy
    (~2560px, full-screen), and the untouched original (download, high-quality
    export, and loaded on demand when someone zooms past the display copy's
    detail). The uploader may choose not to keep the original (cheaper); that
    choice is one-way — an original can be dropped later, never re-added
    without re-uploading.
11. **Location data: match what other platforms do.** (Research item for the
    review: Google Photos / iCloud / Facebook behaviour on GPS in shared and
    downloaded photos. Working proposal: store the original byte-exact, strip
    location from every copy that leaves the platform, losslessly.)
12. **No push/email notifications.** Instead: **watch a tag**; the dashboard
    lights up watched tags with new photos ("Harry: 12 new"), and a "new in
    my watched tags" feed.
13. **Export**: the org chooses which positions may export a ZIP. Options:
    by tag/album/search or everything; display copies or originals; a
    spreadsheet of who is in each photo, captions, dates, places; tags
    written into each file's own keyword metadata so names travel with the
    file. Built in the browser (a multi-GB ZIP cannot be assembled on Vercel).
14. **No video in v1.** Maybe later.
15. **Quotas at three levels — platform stop, per org, per person — with
    paid upgrades, and a status bar at each level as it nears its limit.**
    Same shape as the founder's cost-cap design for the (planned, unbuilt)
    career résumé builder module, whose planning exists ONLY in a chat
    transcript (session `4ad1d135…`, 2026-10-27 → 11-02): a platform stop, a
    per-org cap, a per-user limit; the superadmin sees a tree — platform →
    per org → per org per module, and platform → per user → per user per
    module. **That module's plan should be written into a docs/modules draft
    before it is lost; it is not in the repo.**
16. **Backups must include the files.** Supabase's backups and our `backups/`
    folder are database-only. Proposed: a nightly copy of every new file to a
    second company (Backblaze B2 or Cloudflare R2), versioned, deletes held
    90 days, object lock so nothing can overwrite a backed-up file; run from
    a scheduled GitHub Actions job (prod has no always-on worker); a restore
    drill that restores a random photo and verifies its checksum. Plan
    together with docs/12's "offsite snapshot" TO BE PLANNED item.
17. **Safety for originals**: originals are write-once (rotate/crop make a
    derived copy); 30-day trash; a checksum taken at upload and re-verified
    periodically (also detects duplicates); the second-company backup; orgs
    are archived rather than deleted (below); export any time. User-facing
    promise: "kept in two copies with two separate providers" — never "never
    lost"; still advise keeping your own copy.

## Platform dependencies this module surfaces

- **Org archive ("ghost org").** Today deleting an org removes its rows but
  NOT its storage files (`20260928010000` header, "UPLOADED FILES"); org delete
  refuses while real module data exists, which mostly hides the gap. Proposed
  lifecycle, platform-wide (every module, its own slice): **active → archived**
  (read-only, members still view/export, nobody joins, reversible) → deletion
  requested (30-day grace, cancellable, "download everything first") →
  deleted (files actually removed, including from the backup after its hold).
- **Storage**: a separate bucket for photos at minimum; designed so files can
  move to Cloudflare R2 (no egress fees) later. Access stays server-checked:
  the app checks the database, then hands out a short-lived signed URL (the
  pattern visual messaging already uses).
- **Uploads go browser → storage directly** (signed upload URLs), never
  through a Vercel function (body limits). The browser produces the thumbnail
  and display copy and converts HEIC.
- **Quota/metering primitive** shared with the résumé builder's AI caps — a
  second module needing it is the extract-don't-speculate trigger.

## Data model sketch (not a schema)

- `photo`: org, uploader, original/display/thumb object paths, checksum,
  keep-original flag, date taken + **date precision** (day / month / season /
  year / circa), caption, trashed_at, optional "back of print" image.
- `tag`: org, kind (label / album / person / place / private-list), name,
  status (approved / pending / rejected), owner (private lists, owner-curated
  albums), cover photo, merged_into.
- `photo_tag`: photo, tag, added_by, album order.
- `photo_person`: photo, person tag, group label, position in group, added_by.
- `photo_person_vote`: entry, voter, up/down.
- `tag_history`: every rename/merge/split/approve, with undo data.
- `tag_watch`: member, tag, last seen.

## Ease-of-use requirements

- Bulk upload from a phone in about three taps; date read from the photo;
  duplicates detected by checksum.
- Tagging by drag-and-drop: a searchable tag panel (fuzzy match, recent tags,
  tags from the same upload batch first); drag a tag onto one photo or a
  multi-selection.
- "Who's in it" entry: add a group, type names left to right, autocomplete.
- Browse without knowing tags: a date grid first, tags as filters.

## Open (founder)

- Location behaviour once the review reports what other platforms do (11).
- Does the tag keeper role sit beside org admin, or does org admin imply it?
- Pricing of the paid tiers (original storage, larger quotas).

## 2026-11-03 — ADVERSARIAL REVIEW (four parallel reviewers: legal, product, security/abuse, cost/ops)

Each reviewer answered one question against the draft above. What follows is
the orchestrator's consolidation. "Proposed" = not yet accepted by the founder.
Claims each reviewer marked UNVERIFIED are kept marked.

### A. Changes the review forces (proposed; most are technical, not taste)

1. **Private favourite lists leave the tag table.** Both the security and
   product reviewers found that one shared table leaks them through every
   org-visible path: admin escape arms, tag counts, autocomplete, the keeper's
   merge, export, the data browser, view-as. A list's NAME alone can disclose
   ("Divorce evidence"). → Their own table, owner-only policy with **no admin
   or superadmin arm**, excluded from export and every aggregate, view-as
   `personal` with mode 2 off; tested as an admin reading 0 rows with a
   control that the same admin reads other tags. **"Everything is a tag"
   survives in the UI and stops at the storage layer.**
2. **A person is a record, not a string.** One record with aliases ("Grandpa
   Joe", "Yosef", "Joseph Smith"), optional birth/death years, maiden/other
   names, a disambiguation line, so Joe at 5 and Joe at 80 are one person and
   most duplicate spellings never get created. "Grandpa Joe" is relative to
   the speaker, so it is an alias, never the canonical name. **Unknown
   person** is a first-class slot ("Top row, 3rd: ?") with a **"Help
   identify" queue** — the reason older relatives come back (FamilySearch is
   built around it).
3. **Scans get their own path.** A scan's file date is the SCAN date; reading
   it would file every 1960s print under 2026. → A batch switch "these are
   scans" (plus scanner-make detection) defaults the date to unknown; bulk
   front/back pairing ("every second file is a back"); bulk rotate; a field
   to transcribe the handwriting on the back.
4. **Dates: ranges and an Undated bucket.** "1985–1990", "before 1970",
   circa; Undated is a visible home, because a date-grid-first screen of a
   mostly-undated archive looks empty or wrong.
5. **Rows need an escape.** A "scattered / no order" group for candids and
   crowds. (The product reviewer also recommends storing one OPTIONAL x,y per
   entry now so a name can highlight its place on hover — conflicts with
   decision 4; founder question below.)
6. **Location (answers decision 11 — what others do).** Google Photos: shared
   albums keep location PRIVATE by default with a per-album "share locations"
   toggle (verified). Apple: officially recipients "may be able to access"
   location; stripping in shared albums is only forum-reported (unverified).
   → **"Strip on every exit" is at least as strict as the market.** But the
   draft leaked anyway: zoom-on-original and originals export hand the
   untouched file to every member. → Originals are served GPS-stripped to
   everyone **except their uploader**. CPRA classes precise geolocation as
   sensitive (unverified).
7. **HEIC originals break three promises** (cost reviewer, verified): only
   Safari decodes HEIC, location cannot be stripped losslessly from HEIC in
   the browser, and keywords cannot be written into HEIC. → For a HEIC upload
   the browser also makes a **full-resolution JPEG** (stripped) that
   everyone but the uploader sees and exports; the byte-exact HEIC is kept
   for the uploader and the backup. Costs extra storage; a technical call,
   taken unless the founder objects.
8. **Uploaders can always export their own uploads**, whatever the org's
   export setting (GDPR Art. 20 portability).
9. **Quotas live inside this module** (extract-don't-speculate: the résumé
   builder is not in the repo, so there is no second consumer yet). Enforced
   where the server issues a single-use, size-bounded signed upload URL; a
   reconcile job charges actual bytes; orphan objects are swept.

### B. Legal — must be handled before launch (and most are PLATFORM-WIDE)

1. **TAKE IT DOWN Act (verified; removal duties in force since
   2026-05-19).** A user-generated-content photo archive is very likely a
   "covered platform". Requires a clear, public request route, removal of a
   valid request within **48 hours**, and reasonable effort on identical
   copies. The requester is usually NOT a member, so the route must be public
   and operated by the superadmin, not an org admin who may be the poster.
   **⚠ Platform-wide: visual messaging and classroom already accept user
   image uploads, so this may already apply today.**
2. **CSAM, 18 U.S.C. §2258A.** On actual knowledge, report to NCMEC; the
   REPORT Act raised preservation to **1 year** (verified). The 30-day trash,
   uploader delete and backup purge would all destroy evidence → a
   superadmin **quarantine** state (hidden from everyone, undeletable, kept
   with uploader details for a year) and NCMEC registration in advance.
   Scanning is believed NOT required (§2258A(f) — unverified). Family
   archives carry the bath/beach-photo trap: write a moderation policy that
   does not over-report.
3. **COPPA (amended rule in force 2026-04-22, verified).** A family org will
   have under-13s. Either terms say 13+ with an age attestation at signup and
   invite, or build verifiable parental consent. Photos OF minors posted by
   adults are not COPPA's concern. **Platform-wide.**
4. **Terms need a content licence and warranties.** Licence to store, copy
   (thumbnails), back up to a second provider and export; the uploader
   warrants rights and consent; an abuse/NCII clause; repeat-offender
   policy. Today's terms grant nothing.
5. **GDPR.** A family may be household-exempt, but Recital 18 keeps the
   provider of the means in scope (verified). With any EU subject: an
   erasure/objection route for a person IN a photo, a processor agreement
   with each org, a transfer mechanism. Decision 1 (no face recognition)
   keeps photos out of special-category biometrics (Recital 51 — unverified);
   free-text tags can still reveal religion or health.
6. **DMCA (should).** Register a designated agent ($6, lapses after 3 years),
   notice/counter-notice, repeat-infringer policy; studio portraits are the
   photographer's copyright. No agent, no §512(c) safe harbour.
7. Decision 9 (departed uploaders' photos stay) is fine for the uploader but
   clashes with erasure when the departing person is IN photos — the
   removal-request route (B1/B5) is where that is answered.
8. Biometric laws (BIPA etc.) do not reach manual tags; keep decision 1
   binding on vendors too (no storage/CDN "smart" face features).

### C. Security and integrity (proposed technical design; Opus build rhythm)

- **Paths are server-derived** (`<org_id>/<photo_id>/<variant>`), never
  client-supplied, pinned by a trigger; storage policies check BOTH the org
  segment and the module role; URLs are signed with the user's RLS client,
  never service role; TTL ≤ 5 minutes. A signed URL cannot be revoked —
  documented residual.
  *Side finding, checked by the orchestrator:* `vm-images`' policies
  (`20260709100000`, `vm_images_read/_write/_delete`) check only the
  conversation segment, so their `<org_id>` prefix is decoration. Not a
  cross-org read (authority is the conversation), but the prefix cannot be
  trusted for deleting an org's files by folder.
- **Originals truly write-once**: no UPDATE policy on the bucket; trash marks
  the row and never deletes the object; only a purge job deletes after 30
  days (and never a quarantined file).
- **Vandalism**: merge is a pointer (`merged_into`), not a rewrite; captions
  generated at read time; `tag_history` stores full prior state so undo holds
  after later edits; confirmation above a photo-count threshold; rate-limit
  tag creation; a "recent changes" feed per person and org-wide.
- **The browser makes thumbnails, so they can lie**: the original is
  authoritative; moderation and reports open the original; checksums per
  variant recorded; re-derive server-side when a runner exists.
- **Uploads**: allow-list JPEG/PNG/WebP/HEIC by magic bytes; bucket
  `allowed_mime_types` and size limit; originals served `attachment` +
  `nosniff`; cap pixel count before decode; EXIF strings are text only;
  export as `.xlsx` with string cells (or prefix CSV cells) against formula
  injection.
- **Votes**: one per member per entry; "disputed" is a ratio with a minimum
  count; keeper resolves.
- **Duplicates checked within an org only** — a cross-org match reveals that
  another org holds the same photo.
- Account deletion: scrub `added_by` and voter identity per docs/21; a
  person tag naming a departed member is text and is NOT scrubbed (accepted).

### D. Cost and operations (verified 2026-11-03)

| Per month | 5,000 photos (~21 GB) | 50,000 photos (~213 GB) |
|---|---|---|
| Supabase only | free tier impossible (1 GB, 50 MB file cap); **Pro $25** | Pro ~$27.40 |
| Supabase DB + R2 files | R2 ~$0.17 + Supabase ($0 free / $25 Pro) | R2 ~$3.05 + same |
| B2 backup | ~$0.08 | ~$1.40 |
| Vercel Pro if paid tiers are sold | +$20 (Hobby forbids commercial use) | +$20 |

- **Blocker: Supabase Pro first.** Free is 1 GB storage, 5 GB egress, 50 MB
  per file, and **pauses after a week of inactivity** — fatal for a
  rarely-visited family archive. This is docs/05's phase-C decision, made for
  the whole platform. R2 only saves money while Supabase stays free.
- **Blocker: the backup key.** Copying files offsite needs a read-everything
  key (service role or Supabase S3 keys), which conflicts with hard rule 14
  and would sit in a PUBLIC repo's Actions. Mitigations: environment-scoped
  secret with required reviewer, actions pinned by SHA, a WRITE-ONLY B2 key,
  compliance-mode object lock (B2 verified; R2's unconfirmed). The read side
  remains — founder decision.
- **A file-capable job runner is required.** Trash purge, checksum re-verify,
  org file deletion and backup all touch files; pg_cron cannot, and prod has
  no worker. Candidate: a Supabase Edge Function on a cron. Same root
  question as the always-on worker deferred in module 6.
- Uploads: Supabase supports resumable (TUS) uploads with signed tokens
  (verified) — needed for scans; Vercel's 4.5 MB body limit confirms
  browser→storage direct.
- Browser HEIC needs libheif wasm (~1.2 MB, LGPL) outside Safari, with known
  failures on portrait/burst HEIC; plan for the failure.
- Export: streaming ZIP works; save-to-disk is Chrome/Edge only; split into
  ≤2 GB parts; re-sign mid-export; one full originals export of 50,000
  photos is ~175 GB of Pro's 250 GB monthly egress.
- Writing keywords losslessly into JPEG means hand-splicing an XMP segment;
  no library does it in the browser; none for HEIC.
- The cost reviewer called the platform-wide org-archive lifecycle scope
  creep and would fix only the orphaned-files gap. **The founder asked for
  ghost orgs explicitly**, so it stays — as its own platform slice, not part
  of this module.

### E. Product — should / later

Should: near-duplicate detection by perceptual hash (not biometric) for two
cousins scanning the same print; a mobile "select → Tag…" bottom sheet
(drag-and-drop is desktop-only); **Event** as a tag kind; place hierarchy
(Country > City > Venue) exported hierarchically; a first-run "scan day"
checklist and Google Photos import; per-photo **memories/stories** text
(moderated). Later: claim a person tag as yourself, audio memories,
family-tree (GEDCOM) links, region export, "in memoriam" display, and an
**opt-in weekly email digest once a mail provider exists** — without it,
contributors who do not log in on their own never come back.

### F. Founder questions raised by the review

1. Supabase Pro ($25/month) as the prerequisite — yes?
2. The backup copier: accept a read-all key in GitHub Actions with the
   mitigations, or run the copy somewhere private (a small VPS, the founder's
   own machine)?
3. A file-capable runner (Edge Function on a cron) — acceptable as the first
   always-on piece of infrastructure?
4. Pins: still no x,y at all, or store an optional point now so a name can
   highlight its place on hover?
5. PENDING tags: visible to everyone at once (decision 5 as written), or only
   to their creator and the keeper until approved (security reviewer — stops
   an offensive-tag flood)?
6. Legal B1–B4 are platform-wide (removal route, quarantine, age gate,
   terms licence). Build them as their own platform slice before this module?

### G. Founder answers, 2026-11-03 (second round)

1. **Showcase on the FREE tier** (about 20 photos), built so moving to Pro is
   a configuration change, not a rewrite. Free tier limits apply to the
   whole platform: 1 GB storage shared with every module, 50 MB per file,
   project pauses after a week of inactivity.
2. Backup key placement — answered by the finding recorded in docs/12 on
   2026-11-03 (the nightly database backup's artifacts on a public repo).
3. **A file-capable scheduled runner (Edge Function on a cron): approved.**
4. **No pins and no stored point for now.** Adding an optional point later
   is a nullable column — additive and cheap — so nothing is lost by waiting.
5. **PENDING tags are visible to everyone right away** (decision 5 stands;
   the security reviewer's alternative was declined).
6. Platform-wide legal slice: explained to the founder, decision pending.
7. **Children: no logins under 13 for now (option A)**; an "I am 13 or
   older" confirmation at signup. Children appear in and are tagged in
   photos regardless (COPPA governs children USING the service, not photos
   of them posted by adults). Parent-managed child accounts with verified
   consent (option B) can be ADDED later; nothing in A has to be undone.

### H. Founder answers, 2026-11-08 — the platform legal slice's user-facing text

Founder rule for ALL of this text: short and general, nothing that scares
users, and nothing that teaches anyone how the platform works inside
(no mechanisms, no timings). Wording v2 below has the founder's edits applied.
**APPROVED by the founder 2026-11-09 ("The Legal text looks good").** Not yet
built or on the site.

**(a) "Your content" — new section on the Privacy & Terms page:**
> You keep ownership of what you upload. You give us permission to store,
> copy, resize, back up, display and otherwise use it in the context of
> running the service.
>
> Only upload things you have the right to share. Never upload anything
> illegal, sexual content involving anyone under 18, intimate images shared
> without consent, or content meant to harass someone.
>
> We may remove content and suspend accounts that break these rules. If the
> law requires it, we may have to report illegal content to the authorities.

Founder's reasons: "in the context of running the service" (was "only to
run the service") leaves room to look at content to build better tools for
it; "we may have to" (was "we report") says reporting happens because the
law compels it, not because the platform watches its users.

**(b) Age:** terms line "You must be 13 or older to create an account." plus
a signup checkbox "I am 13 or older".

**(c) Public "Report content" page** (no sign-in, footer link beside Privacy
& Terms): a link or description of where it was seen; a reason (Shows me
without permission · Intimate or sexual image · Involves a minor · Copyright ·
Other); the reporter's email; "The information I've given is accurate".
After sending: "Thank you. We review every report." **No time frame is
shown to users (founder, 2026-11-08).**

**(d) Internal only, no user-facing text:** the superadmin's review queue,
quarantine/preservation, legal reporting steps.

**The 48-hour TAKE IT DOWN obligation is the founder's, and he wants it
surfaced, not remembered (2026-11-08).** Measured the same day: the Owner
Console home (`apps/web/app/(app)/console/page.tsx`) is a plain list of links
with no counts, badges or priorities. Founder ask, verbatim intent: one main
superadmin dashboard that summarises everything going on and everything
that needs doing — reports, feedback, things that are expiring, and so on —
with number and colour badges and a priority list, so he never misses a
report inside 48 hours. Build that dashboard before (or with) the Report
content page.

**Dashboard BUILT 2026-11-09** (no migration; journal 2026-11-09 Sonnet
entry). The "Content reports" tile is a placeholder until the report table
exists — wire it in `reportsSection()` of `apps/web/lib/console-dashboard.ts`.

## Out of scope for v1

Face recognition (never), video, links outside the org, per-album audiences,
tap-on-face pins, comments (moderation surface — decide later), notifications
by email or push, AI search of photo contents.
