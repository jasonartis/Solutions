# 27 — Feedback, bug reports and requests (a platform-wide ticket tool)

**Status: DESIGN NOTE, nothing built (2026-10-28). Founder-initiated; do not start building without an Opus session.**
It records what the founder decided and what is still open, so the design is not re-derived.

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
