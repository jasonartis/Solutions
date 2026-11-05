# 27 — Feedback, bug reports and requests (a platform-wide ticket tool)

**Status: v1 BUILT, ON PRODUCTION AND PROD-VERIFIED 2026-11-05 (Opus) — read "v1 AS BUILT" at the end first.** Backup `backups/2026-11-05T10-53-25`; `scripts/prod-verify-feedback.mts` 7/24 before → **36/0** after; ACL 17/17 on prod; `prod-verify-migration.ts` 0/0; CI green on `17c2066` (incl. the e2e); `scripts/prod-verify-feedback-ui.mjs` **5/5 in a real browser on prod** (send from a module page, preview, My feedback, another user gets 404; its ticket deleted afterwards). The sections before it are the 2026-10-28
design note (founder decisions, unchanged) and the routing questions that are still open.

## Why

Some things cannot be tested by us: the camera/microphone picker and the reconnect banner in the speed-dating video room
(module-6 spec 2026-10-28) depend on real devices and real network drops. The person who hits the problem must be able to
tell the platform owner, **with everything needed to reproduce it**, from inside the product. The same channel carries
suggestions and feature requests.

## Founder decisions (2026-10-28) — settled

1. **Platform-wide, ONE set of code.** One tool shared by every module; the module-specific part is only *what context
   gets attached*. Not a per-module feature.
2. **Per-user inbox, platform-wide.** A user sees all of their own tickets (every org, every module) in one place.
3. **It is a ticket system, not email.** A conversation per ticket (messages both ways, a status), shown in the product.
   **No email provider is needed** — nothing in v1 sends mail. (Email later is an add-on, never the transport.)
4. **v1 is between the user and the platform owner only.**
5. **Prepare for routing to an org admin** for requests the org admin has the power to act on beyond what the requesting
   user can. NOT built in v1, but the design must not make it hard.
6. **A full review is owed** of which request types go to whom, and how the exchange shows up, before routing is built.

## What the tool captures automatically ("where they are and what they are seeing")

Attached to every ticket, shown to the user BEFORE sending (a short "what will be sent" preview with an opt-out for the
optional parts), so nothing is collected in secret:
- where: the page/route, org, module, the entity ids in the URL (event, class, conversation…), and the user's role/grants there;
- what they were seeing: page title, any visible notice/alert text (`?notice=` banners, error text) — **not** a copy of the page
  (it contains other people's names);
- environment: browser, device, viewport, app version (commit), time;
- what they did: the user's recent activity trail from `activity_events` (docs/17 — already captured, the key to reproducing);
- a Sentry event id for any recent client error (Sentry is live);
- module-supplied extra context through ONE extension point (a module registers a function returning a small JSON blob; e.g.
  speed-dating's video room would add the device list, connection state and last library events).
**Not** session replay/recording (privacy, volume).

## Shape (sketch for the Opus design pass — do not treat as final)

- `tickets`: id, created_by, org_id (nullable: a platform-level request has none), module_key (nullable), kind
  (`bug | suggestion | question | other`), status (`new | open | waiting_on_user | resolved | closed`), title, `context` jsonb,
  timestamps, `routed_to` (null in v1 = platform owner).
- `ticket_messages`: ticket_id, author_id, author_kind (`user | staff`), body, `internal` (staff-only note), created_at.
- Unread tracking per user and per staff member.
- **RLS is the point (docs/00: tenancy isolation is existential):** a user reads only their own tickets and only the
  non-internal messages; the superadmin reads all; nobody else, in v1. Routing later = an explicit, per-category, opt-in rule,
  **never a default** — a user may be reporting the org admin themselves (safety, harassment), so a report must never reach the
  person it is about.
- Screens: a "Send feedback" control reachable from every page; **My feedback** (the user's inbox, unread badge in the shell);
  **/console/feedback** (superadmin queue: filter by module/org/kind/status, the context panel with the activity trail, reply,
  internal notes).
- Account deletion (docs/21): decide per column — who owns a ticket after the author is deleted (it is a human act with the
  author's own words; the silhouette rule applies), and the 30-day grace period. `/privacy` needs a line (what is attached, who
  reads it).
- Registered in the activity capture, the ACL verifier, the table-grants ratchet; a `prod-verify-*` script with before/after.

## The review that is owed before ROUTING (founder item 6) — questions, not answers

- Request TYPES and who handles each: product bug (platform owner); feature suggestion (platform owner); "change a setting in my
  org" (org admin?); account/privacy requests — export, deletion (platform owner, legal weight, must not be missable); safety or
  conduct reports about a person or about an org admin (platform owner only, never routed down); module questions from clients
  (org admin first?).
- Who can SEE a user's ticket once routed (the user's own words, plus automatic context that includes their activity trail)?
- What the USER sees: status wording, who answered (a person or "the platform team"), whether an org admin's reply is
  labelled as theirs.
- Hand-off between handlers (an org admin escalating to the platform owner), and what happens when the org has no active admin.
- Notifications without email: unread badge only? A digest page for staff? (Email is explicitly not required.)
- Volume and abuse: rate limits, attachments (screenshots — privacy and storage), retention.

## Tiering

Opus: the tables, RLS, privacy/deletion handling, the verifier, the context-capture contract. Sonnet afterwards: the button, the
user's inbox and the superadmin queue UI on the verified tables. Fits the platform rule *extract, don't speculate*: the founder
has named a real need (untestable features), and every module needs it, so it is one primitive in `packages/platform`, not a
speed-dating feature.

## v1 AS BUILT (2026-11-05, Opus; founder said "go" on the list that included it)

**Migration `20261106010000_feedback_tickets.sql`.** Tables `feedback_tickets` and `feedback_messages`; the API roles hold
**SELECT only** (revoke-before-grant); every write goes through four SECURITY DEFINER functions, so no client-writable column
needs pinning: `feedback_open(kind, title, body, org_id, module_key, context)`, `feedback_reply(ticket_id, body, internal)`,
`feedback_set_status(ticket_id, status)`, `feedback_mark_read(ticket_id)`.
- **Who reads:** the author (own tickets, non-internal messages) and the superadmin (everything). **No one else — an org admin
  of the org on the ticket reads nothing** (org_id is where the person was, context only). Pinned by tests and by the prod verifier.
- **Who writes what:** author and `author_kind` are server-set; only staff can write an internal note; the person may only
  CLOSE their own ticket, every other status is staff's; a ticket can only name an org the person is an active member of.
  "Not yours" and "does not exist" give the same answer ("Ticket not found").
- **Status flow:** new → (staff reply) waiting_on_user → (person replies) open; resolved/closed are set by staff (closed also
  by the person); a person replying on a resolved/closed ticket reopens it.
- **Unread:** `last_staff_message_at` vs `user_read_at` (the person's badge in the top bar and "New reply" on My feedback);
  `last_user_message_at` vs `staff_read_at` ("unread" in the console). Opening a ticket marks it read.
- **Limits:** 10 new tickets and 60 messages per person per rolling 24 h (superadmin exempt); title ≤ 200, body ≤ 5000,
  context ≤ 8000 bytes. No attachments.
- Times inside the functions are `clock_timestamp()` (now() ties within one transaction — found by the unread test).

**Decisions made in the build (technical calls, recorded so they are not re-derived):**
1. **The activity trail is NOT copied into the ticket.** The console reads it LIVE from `activity_events` (the 24 h before the
   ticket). A copy would be a second, unpruned, deletion-blind record of what someone did; the live read ages out at 90 days with
   everything else. The person is told the team "may also look at what you did on the platform shortly before you wrote".
2. **Account deletion (docs/21):** tickets and messages are the person's own words — human acts — so the silhouette keeps them;
   the author shows as "Former member". `context` (page/browser, not identity) is kept so a report stays reproducible. No change
   to the silhouette function was needed. FKs are ON DELETE CASCADE (only a raw superadmin delete reaches them).
3. **The person's role/grants are not stored either** — the console shows their CURRENT module positions in the ticket's org.
4. **No superadmin-lookup logging** for reading tickets: a ticket is addressed TO the platform owner, so reading it is not a
   lookup of a person (unlike the data browser / view-as).
5. **The "what will be sent" preview** lists every optional field before sending, with ONE switch ("include page and browser
   details") that drops all of them, module key included.
6. **Not built in v1:** the module extension point for extra context (e.g. the video room's device list), a Sentry event id,
   routing to an org admin (the open review above stands), email, attachments, a personal-export data set for tickets, and an
   activity_events entry for sending feedback (a ticket may have no org, and activity rows are org-scoped).

**Screens:** "Feedback" in the top bar of every signed-in page (carries the current page as `?from=`, with an unread count);
`/feedback/new`, `/feedback` (My feedback), `/feedback/[id]` (author-only; a superadmin opening someone else's is sent to the
console); `/console/feedback` (queue: new+open by default, filters by status/kind) and `/console/feedback/[id]` (thread with
internal notes, context panel, current positions, the 24 h activity trail, reply / internal note / status). `/privacy` gained a
feedback paragraph (draft page; founder review of the wording is owed with the rest of it, docs/18 item 3).

**Verified:** `packages/db/src/feedback.test.ts` 11/11 (every refusal with a control; db suite 503/503); e2e
`feedback: a person sends feedback…` passes locally (send from a module page, a second user gets 404, the superadmin sees the
context and replies, the person sees the badge, the reply and "Answered — waiting for you", and opening clears the badge);
`scripts/prod-verify-feedback.mts` (structure + rolled-back behaviour as real demo users) local 36/0, prod pre-apply 7/24 with
every control green. Registered in `verify-acl-hardening.ts` (local 17/17) and the data browser (`data-browser-modules.ts`).

**Adversarial review (2026-11-05): no tenancy-isolation defect.** Fixed before shipping: `feedback_set_status`'s owner guard is
now `is distinct from 'closed'` (a NULL status had slipped the guard and was stopped only by the NOT NULL check); the console's
context panel is labelled self-reported (`context` and `module_key` are whatever the author's call sends — a lead, not evidence).
**Accepted, recorded:** (a) the author can read every column of their own rows, so a staff reply's `author_id` (the superadmin's
user id) and the ticket's `staff_read_at` are visible to them — low; narrow it with a definer view if it ever matters; (b) the
daily caps count without a lock, so concurrent calls can overshoot slightly; (c) "the person may only close" really means
"close, or reopen by replying" — intended (see the status flow); (d) a superadmin opening their OWN ticket on `/feedback/[id]`
also stamps `staff_read_at`, hiding its console "unread" mark — cosmetic; (e) `parseFromPath` accepts `/\host` (harmless: the
value is only parsed and stored, never redirected to) — do not reuse it as a redirect guard.
