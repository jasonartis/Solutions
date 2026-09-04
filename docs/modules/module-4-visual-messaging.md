# Module 4: Visual Messaging (key: `visual-messaging`, prefix `vm_`)

## Problem & context

A visual conversation app: a thread starts with a picture; every reply is a transparent layer drawn on top of the layer it responds to. Audiences (decided 2026-07-06): **both** fun/family (photos) and professional (engineers/architects annotating plans, document markup) — the latter demands high-res zoom with layers staying registered, and suggests a future paid org tier.

## Data model

- A conversation = a **tree**: root image at the root; each reply layer is a child of the layer it was drawn on. Address = **materialized path** (e.g., `1.3.2.23`); shareable **deep links** jump straight to a layer.
- A layer's content = **vector objects (JSON)**: freehand strokes, styled text (color, angle), emojis, and **image stamps** (upload, shrink/rotate/place). Decided: vector storage, not flattened rasters — crisp at any zoom, small, composable; worker rasterizes thumbnails for grids.
- Image-stamp guards (decided 2026-07-06): default max stamp size relative to canvas (admin/org-tunable) and default slight transparency — nudge toward responding *to* the image, not covering it.
- Viewing layer L renders L composited on **its ancestors only** (siblings/descendants invisible).

## Navigation (from the founder's walkthrough, confirmed)

- **Swipe left** = descend (next reply layer slides in on top, from the side).
- **Swipe right** = peel the top layer off the way it came (back up one level).
- **Swipe up/down** = cycle siblings (alternate replies to the same parent; current top layer exits, sibling enters from opposite direction).
- Breadcrumb showing the path (`1.1.2`) + sibling dots (carousel-style) so users know unexplored replies exist.
- **Press-and-hold X-ray:** temporarily fade reply layers to see the original/composite below.
- **Zoomed-out grids:** multi-level zoom-out to grids of layer thumbnails (small grid → larger row/column counts at further zoom), toggle "with underlying layers" vs "layer alone", scroll, tap to enter a layer full-screen.
- Pinch-zoom into the artwork itself with all layers staying registered (plans use case).

## Rules

- Reply from any layer (adds a child of the currently viewed layer).
- **Delete own layer only while it has no children**; afterwards, request admin deletion.
- Drafts: a layer is local until sent; undo/eraser pre-send only. Immutable once replied-on.
- Attribution: tap to see author + timestamp of the current layer. "What's new" indicators in grid for layers added since last visit.
- **Lightweight reactions** (heart/laugh) on a layer without creating a content layer.

## Membership

- Conversations belong to an **org** (company/family) or an ad-hoc person-to-person group (WhatsApp-style list).
- Roles: participant, **read-only viewer** (watch, no draw — also what a deep-link visitor gets before joining), **moderator** (handles flags), **admin** (membership + settings + everything).

## Admin & moderation (decided 2026-07-06)

- WhatsApp-like conversation list; add/remove users; **freeze** a conversation or a **branch** (lock a subtree while others stay live).
- **Tombstone over subtree-delete:** blank an offending layer's content but keep its slot so descendants (drawn in its context) still render; subtree delete reserved for severe cases.
- Moderation queue shows flagged layers **composited on their ancestors** (context), one-tap tombstone/dismiss/ban; audit log of all moderation.
- Per-conversation settings: who may invite; whether deep links work for non-members; content rules.

## Tech notes

Mobile-first PWA; gesture-driven. Canvas: **Konva (react-konva) + perfect-freehand** (tldraw rejected on license — docs/02). Backend is light (tree + JSON + files); the swipe/draw frontend is where the effort lives — scheduled late (docs/04) so the platform is stable underneath it.

## Primitives used

Orgs/membership, files, notifications, audit log, moderation/approval patterns, PWA shell.

## Future enhancements

Paid org workspaces (firms annotating drawings); animated layers (explicitly out of v1); export a flattened composite as an image.

## Schema integrated (2026-07-09)

`vm_` tables live (`supabase/migrations/20260709100000_visual_messaging.sql`, local + prod): `vm_conversations`, `vm_layers` (the materialized-path tree), `vm_conversation_members`, `vm_reactions`, `vm_flags`, `vm_moderation_log` (append-only — no user update/delete GRANTs at all). Manifest registered but **not enabled for any org** — schema only, no UI, dark. Agent-drafted (`modules/visual-messaging/schema-draft.sql`), hand security-reviewed (`schema-fixes.sql`), **16/16 live guard assertions**.

Key design (agent decisions A1–A10, reviewer-confirmed): the root image IS a layer (path `1`, one-root partial unique); `child_count` is a direct column so childless/immutable checks never self-reference the table (docs/03 #15); branch freeze is stored at the freeze point and computed for descendants by path prefix; ad-hoc person-to-person groups = auto-created lightweight orgs (**pending founder confirmation**); audit rows survive deletion of what they describe (SET NULL, not cascade); org module roles are `admin`/`moderator`/`member` while per-conversation seats are the spec's participant/viewer/moderator/admin.

Security-review pass (T1–T8 built; T9 public deep-link definer fns ship with the UI; T10 decided — flags/reactions stay possible under freeze since flagging frozen content is a safety need): **atomic reply-path assignment** (parent row lock serializes concurrent siblings — client-supplied path/child_count ignored; replies to tombstoned/frozen parents rejected); child-count maintenance on delete; the layer pin (author edits content only while childless — "immutable once replied-on" — structure pinned below org manage, tombstone stamps forced server-side); **audited moderation RPCs** `vm_tombstone_layer` (original content preserved into the mod log, then blanked) / `vm_restore_layer` (restores from the log) / `vm_set_branch_frozen`; `vm_join_conversation` (settings-gated, refuses banned); member pins (no self-promotion/self-unban, **last-admin-standing guard**); flag-triage pins with server-side review stamps; the `vm-images` bucket with conversation-membership storage policies (not plain org membership — the module-2 finding class).

**Remaining for module 4:** the entire gesture-driven canvas frontend (Konva + perfect-freehand — the effort center), conversation list/membership UI, moderation queue UI, thumbnail rasterization worker job, deep-link definer functions, org-per-group auto-creation flow.

## UI v1 shipped (2026-07-10)

The core loop is live: conversations list + create-from-picture (root image
to the `vm-images` bucket; the root IS layer `1`), the conversation page
rendering the viewed layer composited on its ancestors (Konva; strokes stored
in image pixel space so zoom stays registered), click navigation (breadcrumb
up the chain, replies list down), press-and-hold X-ray, pen palette + size +
draft/clear/send (drafts never leave the browser until Send), heart/laugh
reactions, and admin add-member by email. Walkthroughs (member + moderator)
and the export manifest (authorship: my layers / my reactions; admin:
moderation log) ship alongside.

**Not yet built (the gesture/PWA layer):** swipe navigation, sibling
carousel + dots, zoomed-out thumbnail grids (needs the worker rasterizer),
image stamps/text/emoji tools, moderation queue UI, deep links for
non-members, org-per-group auto-creation (pending founder confirmation).

## Gesture layer + moderation queue shipped (2026-07-10)

The three items flagged above as the effort center are done, in a view/draw
mode split (view is default; "Draw a reply" enters draw mode):

- **Swipe navigation** — left dives into the first reply, right backs up to
  the parent, up/down cycles siblings; **sibling dots** under the picture
  show carousel position and are clickable. Nav targets are computed
  server-side per render from the path-ordered layer rows.
- **Zoomed-out tree view** (`?view=tree` toggle) — every layer as a small
  Konva thumbnail (root image + composited ancestor-chain strokes; tombstoned
  layers render blank), grouped by tree depth, click to jump. **No worker
  rasterizer needed at this scale** — it composites client-side from data the
  conversation page already loads; revisit only if a conversation's layer
  count grows into the hundreds.
- **Moderation queue UI** — members get **Flag this layer** (reason +
  optional detail); moderators get a **Moderation** section per conversation:
  a **Flagged content** list (reporter visible to moderators only — the
  flagged layer's author never learns who reported), **Mark
  actioned**/**Dismiss**, and **Remove**/**Restore this layer** +
  **Freeze**/**Unfreeze this branch** wired to the already-audited
  `vm_tombstone_layer`/`vm_restore_layer`/`vm_set_branch_frozen` RPCs from the
  2026-07-09 security review — no new migration, this was UI + three server
  actions.

Both walkthroughs updated same commit (docs/03 update rule).

## Deep-link join + admin-tier UI gating (2026-07-10)

Deep-link joining for logged-in org members shipped, and it needed **no
migration** — everything was already in the schema. A conversation admin
toggles `settings.joinPolicy` between **open** and **invite-only** (via the
existing `vm_conversations_update_admin` policy; `vm_pin_conversation` leaves
settings free). An org-module member who isn't a conversation member and hits
the conversation URL gets a **Join this conversation?** prompt (the title is
never revealed — no read access pre-join); **Join** calls the existing
`vm_join_conversation` RPC, which grants a read-only **viewer** seat only when
the policy is open (invite-only / banned / non-org-member all refuse
server-side). A viewer can watch + react but not draw (`vm_can_post` excludes
viewers; the canvas `drawable` prop now checks the caller's actual role, not
just membership — a fix made the same day).

Also fixed a pre-existing UI/permission mismatch: add-member, freeze-branch,
and the new join-policy toggle all require the conversation-**admin** tier
(`vm_is_conv_admin`) at the RLS layer, but the page had gated them on the
looser `vm_can_moderate` — a plain moderator would have seen buttons that
error. The page now computes `vm_is_conv_admin` and gates those three on it,
leaving tombstone/restore/flag-triage on `vm_can_moderate`.

Note: the "whether deep links work for non-members" setting is implemented for
*logged-in org members* (the join flow above). **Anonymous, no-login public
links are explicitly out of v1** — see the future-enhancement section below.

**Still not built:** image stamps / styled text tools; the org-per-group
auto-creation for ad-hoc person-to-person groups (awaiting founder
confirmation, raised 2026-07-09: ad-hoc groups = auto-created lightweight
orgs). Public links are deferred (below).

## Emoji stamps (2026-07-10)

Content vocabulary gains its second type: a fixed-palette (14 emoji) drop-to-
place stamp tool alongside the pen, in `layer-canvas.tsx`. A layer's `content`
jsonb now carries `stamps: [{ emoji, x, y, fontSize }]` (image-pixel
coordinates, same registration approach as strokes) alongside `strokes` — no
migration. A single reply can mix pen strokes and emoji stamps. Tree-view
thumbnails composite stamps the same way as strokes.

## Text stamps (2026-07-11) — spec content vocabulary complete short of image stamps

Third content type: **styled text** (the spec's "color, angle"). A third tool
alongside Pen/Emoji — type a message, pick color/size/-180°..180° angle, tap
to place (a tap is a no-op until something's typed). `content` gains
`texts: [{ text, color, x, y, fontSize, angle }]` as a third sibling next to
`strokes`/`stamps` — still no migration, still jsonb. `replyWithDrawing`'s
payload is `{ strokes, stamps, texts }`; any one non-empty is enough to send.
Tree-view thumbnails render texts the same way. **Only image stamps remain**
from the spec's content vocabulary (upload, shrink/rotate/place, plus the
spec's default-size/transparency guards) — the bigger lift since it needs a
storage upload path, unlike the two jsonb-only types above.

## Image stamps (2026-07-11) — content vocabulary COMPLETE

Fourth and final content type: **image stamps** (the spec's "upload,
shrink/rotate/place" + "default max stamp size... default slight
transparency"). Upload a photo, adjust size (50%-250% of a default box) and
rotation (-180°..180°), tap to place. `content` gains a fourth sibling
`images: [{ path, x, y, width, height, rotation, opacity }]` — path is a
`vm-images` storage object, x/y/width/height/rotation in image pixels like
the other three types, opacity fixed at the spec's "default slight
transparency" guard (0.85; the "admin/org-tunable" part of that guard is
deferred — no settings UI yet). Default box size is 30% of the root image's
width (also fixed, same deferral).

**No migration** — the `vm-images` bucket and its `vm_can_post`-gated write
policy already existed from the 2026-07-09 security review (T8); this was UI
+ one new server action (`uploadImageStamp`). That action takes a `File`
directly rather than `FormData` since the canvas calls it programmatically
(not from a `<form>` submit like the root-image upload). **New guard added in
`replyWithDrawing`:** every image path must start with
`${org.id}/${conversationId}/` — `uploadImageStamp` is the only writer of
that prefix, so a crafted payload can't reference a storage path from
elsewhere.

Rendering needed one new piece the other three types didn't: `vm-images` is a
**private** bucket, so stamped photos need signed URLs, not direct src. The
page batch-signs every distinct stamp path across the **whole conversation**
in one `createSignedUrls()` call (tree view needs every layer's, not just the
viewed chain's), and a shared `useImageCache` hook (exported from
`layer-canvas.tsx`, reused by `layer-grid.tsx`) loads each resolved URL — and
the draft's local blob URLs, for an instant preview of a just-uploaded photo
with no round trip — into an `HTMLImageElement` for Konva to paint.

**Module 4's layer-content vocabulary from the spec is now fully built**:
strokes, emoji stamps, styled text, and image stamps — all four, mixable in
one reply. e2e 25/25.

## FUTURE ENHANCEMENT — public links (NOT v1, revisit later)

*Founder, 2026-07-10: "make the whole public link a potential future
enhancement to be discussed at a later time. Not for v1."* Captured here so
the design thinking survives; nothing is built and no decision is final.

The idea: a per-conversation **public** visibility tier (a third rung above
private and org-link) letting anonymous, non-logged-in visitors get a taste of
a conversation — modelled on the Facebook/Instagram pattern where a limited
public view drives the viewer to want full access. Working design so far:

- **Per-conversation, admin opt-in only — never a default, never
  platform-wide.** This is a private-by-default messaging module; the inverse
  of FB/IG, so public must be a deliberate, well-warned per-conversation act.
- **Interactive teaser, not a static preview** (founder's refinement — the
  stronger hook). Let the visitor actually *feel* the product: draw a reply
  that won't save (the existing draft behavior with "Send" swapped for
  "Request access"), and take a **limited number of swipes per direction** with
  "there's more" walls — a bounded test-drive that conveys the gesture feel and
  that depth exists, while withholding the content.
- **The wall MUST be enforced server-side.** Anything the page can render, it
  received over the network — so a UI-only wall leaks via the network payload.
  The public definer function must return **only a small fixed neighborhood**
  (e.g. root + its first reply + one step of siblings); the "random direction"
  only shuffles presentation order *within* that fixed slice, never expands
  reach — otherwise reload-farming reassembles the whole tree. The bound is on
  total content exposed, not per-load randomness.
- **Call-to-action is "Request access", NOT open self-signup** (founder's
  correction — and it removes the biggest risk). The teaser does not turn the
  platform into an open consumer-signup product (which would drag in
  content-moderation, spam, ToS, an acquisition funnel). Instead "Request
  access" routes to the org head / someone who can add members, who
  approves → the person is added the normal way. Platform stays invite-only and
  controlled. Introduces one small bounded new primitive: an **access request**
  (a pending "someone wants in" item an approver accepts/declines), reusable
  for invite-only conversations and other modules.
- **OPEN — the multi-party consent question (the crux).** Once *others* have
  replied, the admin no longer owns all the material; flipping public would
  expose other people's drawings they never agreed to share. Options: (a)
  simplest — allow public only **before the first outside reply**, lock after;
  (b) fuller — notify contributors and let them withdraw their layers, or
  expose only content created *after* the switch (drawing on after the "now
  public" notice = implicit consent). This mirrors the module's existing
  "immutable once replied-on" principle (others' contributions change what the
  owner may do unilaterally). Left undecided.
- **Technical shape when built:** the `syn_public_*` security-definer pattern
  (T10) + a public route, keyed by a **revocable per-conversation share token**
  (not the raw conversation UUID — so a leaked link can be killed by
  regenerating the token), plus a scary confirmation on going public. This is a
  migration/RLS slice for a verified-Opus session with the full security-review
  rhythm.

**Status:** parked, explicitly not v1 (founder). Revisit as a whole after the
testing round; the multi-party-consent rule is the first thing to settle.

## Testing-round feedback fixes (2026-07-11)

Real feedback from the founder's live walkthrough of the shipped-complete
canvas, addressed same-session:

- **Placed stamps are now editable, not locked in** (the founder's biggest
  ask). Every draft emoji/text/image is selectable (tap it), draggable,
  resizable + rotatable via Konva's `Transformer`, and deletable (**Delete
  selected**). Draft items carry a local-only `id` for
  selection/ref-tracking, stripped before the send payload — the stored
  `Stamp`/`TextStamp`/`ImageStamp` shape is unchanged, no migration.
- **Draw-mode is now visually unmistakable**: a blue border + "Drawing mode"
  label (founder had swiped without realizing draw mode was active).
- **Sending a reply now lands on it directly** instead of leaving you on the
  parent requiring a swipe to find what you just sent
  (`replyWithDrawing` returns the new layer's id).
- **Color picker swatches enlarged** with a proper `ring-offset` selected
  state and a "current color" preview (the old CSS `outline` barely showed,
  and the choice wasn't visible until you actually drew something).
- **Dashboard now shows the caller's per-module role** (professor/GA/
  matchmaker/etc.), not just the org-level role, which looked identical for
  any two org admins regardless of what they actually do in each module.

**Real bug caught before it shipped:** the first cut of the stamp-selection
logic checked `e.target !== stage` to detect "tapped an existing shape" —
wrong, since the background photo is itself a full-canvas `KonvaImage`, so
nearly every tap hits *it*, not the bare Stage, silently blocking ALL new
placements everywhere. Fixed by checking against the actual tracked
draft-shape refs instead of the Stage object. The new e2e caught it
immediately (placement itself stopped working) before this ever reached
production.

**Deferred (documented, not built):** swipe-direction arrows with
layer-count badges, and a slide-in transition when navigating between
layers — both queued next. Mobile/tablet layout is explicitly out of scope
for this module alone (docs/13 cross-cutting item).

### 2026-07-12 — swipe UX finished + platform-wide error boundary

Closed out the two items deferred above, plus a real platform gap found
while fixing an unrelated matchmaking bug report:

- **Swipe-direction arrows + count badges**: non-editable ← → ↑ ↓ overlays
  on the canvas edges (plain HTML siblings of the Konva stage, not part of
  it, so they always render above whatever's drawn and are never obscured
  by ink), each shown only when that direction has somewhere to go, with a
  badge counting how many consecutive swipes still work that way (not just
  "can I" but "how many"). Clicking one navigates the same place the
  matching swipe/dot would. Reuses the `swipeCounts` already computed
  server-side in the conversation page (left = first-child chain depth,
  right = ancestor count, up/down = position within the sibling group).
- **Slide-in transition**: the new layer nudges in ~24px from the direction
  it was reached from (swipe or arrow-button click) and eases to rest over
  200ms — a directional cue, not a scene transition, so the offset stays
  small. Implemented client-side only: on `currentLayerId` change, set an
  offset transform with no CSS transition, then in a double
  `requestAnimationFrame` clear it back to `none` WITH a transition, so the
  browser paints the starting offset before animating away from it.
- **First `error.tsx` in the entire app** (platform-wide, not module-4-
  specific, but found via a module-4-adjacent report): every module's
  thrown server-action errors were falling back to Next's generic unstyled
  crash page for lack of any error boundary anywhere. One boundary at
  `apps/web/app/(app)/error.tsx` now covers every module.

e2e 27/27, RLS 7/7.

## Ad-hoc groups — discussion expanded (2026-07-16) — SUPERSEDED 2026-09-04

**Status: this entry is history. The question it leaves open was DECIDED
2026-09-04 in favour of candidate shape 1 (per-pair lightweight orgs) — see
"Ad-hoc groups — SHAPE DECIDED" below, and read
[docs/16-network-features-review.md](../16-network-features-review.md) before
revisiting. Its closing claim that this stays "blocking for ad-hoc groups
specifically until resolved (ideally alongside the Redt-It planning session)"
is no longer true: per-pair orgs need none of docs/16's blocking items.**

Founder asked to discuss the ad-hoc-group question further after the earlier
sketch ("auto-created lightweight orgs"). Talked through a concrete example
first (a synagogue member wanting a private thread with their out-of-town
sister, who has no relationship to the synagogue's org at all) — confirmed:
yes, the group is just between those two (or however many) specific people;
they'd be added to the conversation itself via `vm_conversation_members`,
same mechanism as today.

**Two candidate technical shapes, discussed but not decided:**

1. **Per-pair lightweight orgs** (the original sketch): auto-create a tiny,
   invisible org for each ad-hoc group. Con surfaced in discussion: these
   would clutter the Owner Console's org list (every ad-hoc chat = one more
   row), and org-level features that assume a real multi-person business
   context (last-admin-standing guard, org self-management) don't make much
   sense for a 2-person pairing.
2. **One shared "everyone" org**: every signed-up platform user automatically
   belongs to a single hidden org; ad-hoc conversations live inside it, with
   `vm_conversation_members` (unchanged) still gating who's actually in a
   given conversation — the shared org is just plumbing to satisfy the
   tenancy model, never a real access boundary on its own for this module.

**Bigger strategic thread surfaced by this discussion, worth its own
session**: the founder asked whether other modules could go "global" the
same way — Make-a-Match or Speed Dating across ALL platform members, not
scoped to one client's org, if Visual Messaging is meant to become more
WhatsApp-like/widespread. This is the SAME underlying tenancy question
already flagged as open for the proposed Redt-It module
(`docs/modules/module-7-redt-it-DRAFT.md`) — a platform-wide user pool that
doesn't fit today's "one org = one client engagement" model. Three separate
ideas (ad-hoc visual-messaging groups, Redt-It's singles pool, and a
hypothetical global matchmaking/speed-dating) are now independently pointing
at the same missing primitive — per docs/00's own extraction principle,
that's a strong signal this deserves ONE deliberate decision made together,
not three separate ad-hoc answers per module. Real considerations if
pursued: automatic inclusion in a global pool raises real privacy questions
(would a synagogue member's account automatically become part of a global
dating/networking pool unless they opt out, or does joining need to be a
deliberate per-user action?) — this needs explicit design, not a default.

Still fully open — nothing here is a decision, and this stays blocking for
ad-hoc groups specifically until resolved (ideally alongside the Redt-It
planning session, given the overlap).

## Per-org tunable image-stamp guards (2026-09-03) — BUILT, Sonnet, no migration

Closes the first of the two go-live-checklist items for this module. The
fixed v1 defaults (0.3 canvas-width fraction, 0.85 opacity) are now the
**fallback**, not the only value: `org_modules.settings` for
`visual-messaging` can carry `{ imageStampMaxFraction, imageStampOpacity }`
(fractions 0-1), self-serve via `/o/[orgSlug]/settings` alongside
synagogue-schedules' existing location fields — same mechanism
(`20260712030000_org_settings_self_serve.sql`'s org-admin update policy +
pin trigger already covers every module's settings, so **no migration was
needed**). `requireOrgModule()` already returns `org_modules.settings`; the
conversation page resolves it (`resolveVisualMessagingSettings()`, falls
back to the defaults on anything missing/out-of-range — the docs/03 #7
"Zod-validated JSON... skip-on-invalid" discipline, done with plain
validation since `apps/web` carries no zod dependency, matching
`synagogue-settings.ts`'s own precedent) and passes both values into
`LayerCanvas` as props — the two module-level constants are gone. Settings
UI is percent-based (5-100% / 10-100%) for a founder-facing org admin; stored
as fractions. **Scope note:** this makes the *default* placement size/opacity
tunable, matching the spec's literal wording ("default max stamp size...
default slight transparency... admin/org-tunable") — it does not add a new
hard ceiling on resizing an already-placed stamp via the Transformer (which
today only floors at 16px, no cap), since that resize-clamp behavior wasn't
part of the existing guard and adding one wasn't asked for.

## Ad-hoc groups — SHAPE DECIDED 2026-09-04 (per-pair orgs), not yet built

The 2026-07-16 open question is resolved. **The answer is candidate shape 1,
per-pair lightweight orgs — NOT shape 2, the one shared "everyone" org.**

The founder first chose shape 2 (its Owner-Console clutter cost looked smaller
than shape 1's), then **reversed it the same session** once an adversarial
review surfaced a document this module's planning had never read:
**[docs/16-network-features-review.md](../16-network-features-review.md)** —
an independent Fable-tier tenancy review, produced 2026-07-20, of exactly the
shared-org design. Its §D names the pattern ("make the public space an org")
and its P1 section is titled *"Public Square findings."* **Read docs/16 before
touching this again.**

### Why shape 2 was rejected

docs/16 endorses the architecture — *"'make the public space an org' is the
right instinct and should be kept"* — but finds the platform-core policies were
all written under an unstated assumption, *an org is a small, vetted,
mutually-acquainted group*, and several **fail OPEN** when it isn't. Three bind
directly on a universal org, and were re-verified live during this session's
review:

- **P1-1 (CRITICAL) — a platform-wide email directory.** `shares_org_with()`
  (`20260727010000`) joins `org_members` to `org_members` on `org_id` with no
  clause excluding any org, and `profiles_select_shared_org`
  (`20260708020000:21-22`) is `for select using (shares_org_with(user_id))`.
  Everyone sharing one org ⇒ every authenticated user reads every other user's
  whole `profiles` row, **email and the `settings` jsonb included**. The sharp
  second-order cost, in docs/16's words: matchmaking's `mm_mutual_matches()`,
  speed-dating's `sd_reveal_matches()` and Redt-It's entire premise all exist
  to gate contact-info reveal — *"all three become theater."* Ten existing
  pages already issue unfiltered `profiles` reads relying on this policy to
  narrow them.
- **P1-4 (HIGH) — roster enumeration.** `org_members_select_member` lets any
  member read the full roster: in a universal org, the platform census.
  *"Standing in a public square does not entitle you to its census."*
- **P1-5 (HIGH) — §7 defaults assume trusted orgs.** This module's own default
  ("global `member` = can create chats and invite") becomes, unvetted, *"an
  unsolicited-contact engine where the spammer moderates their own
  conversation."*

And docs/16's checklist item 2 — choosing the `profiles_select_shared_org` fix
shape — is marked **"Blocking for Public Square and Redt-It Shape B,"** with
*"The founder has decided none of the open items below."* So shape 2 was not
merely risky, it was **formally blocked** on an undecided founder call.

The diagnosis worth keeping: **the original plan used a PUBLIC mechanism to
solve a PRIVATE problem.** Dana messaging her sister is not a public act, yet
routing it through a platform-wide org dragged all three findings into a
feature that needed none of them. docs/16 P3 makes the identical argument for
Redt-It: Shape B must be *"its own org, NOT Public Square — the platform-wide
org must not become a junk drawer where every network module's data commingles
under one membership predicate."*

### Why shape 1 is safe

In a 2-person org `shares_org_with` is **correct by construction**: the only
person who can read your profile is the person you deliberately chose to talk
to. P1-1/P1-4/P1-5 do not arise. `orgs.kind` (below) therefore carries **UX
weight only, never security weight** — which is what makes this buildable
without deciding docs/16's blocking item.

**Accepted residual cost** (founder, explicit): accepting an ad-hoc chat invite
does disclose your email to that one person, since you now share a tiny org.
Symmetric, and only after mutual consent — but not zero. The same P1-1 fix
would close it if ever wanted.

### The decided design

1. **`orgs.kind`** (`client` | `personal`, default `client`) — used ONLY to hide
   personal orgs from the Owner Console org list and the dashboard's org cards,
   surfacing ad-hoc chats under a single "Personal" entry instead. This adopts
   docs/16 §D's trust-class **column** for a cosmetic purpose without adopting
   its security semantics; it is also docs/16 checklist item 1, which *"gates
   everything below"* — so this work moves the platform TOWARD Public Square
   rather than away from it.
2. **`create_personal_org(title)`, SECURITY DEFINER.** Verified necessary:
   `orgs_write_superadmin` (`20260706120000_core.sql:164-166`) makes `orgs`
   superadmin-write-only, so an ordinary user cannot mint one. It creates the
   org `kind='personal'`, adds the caller as active owner, enables
   `visual-messaging`, and grants the caller the `module_roles` row that
   conversation-creation requires (verified chain:
   `vm_conversations_insert_creator` → `vm_is_module_member` →
   `has_module_role`). **This is the rate-limit / abuse choke point** — cap
   per-user creations here, not elsewhere.
3. **Consent: accept-first, and it needs NO new mechanism.** Inviting an
   existing user to an ad-hoc org uses the already-built, already-Fable-reviewed
   org-invite flow (`org_accept_invite()` + the dashboard invite card): a
   pending seat the invitee accepts or declines. This satisfies docs/16 P1-2/P1-7
   for free.
4. **Inviting an email with NO account — the one genuinely new mechanism.**
   Founder's instruction: don't hard-fail; tell the inviter it's fine, hand
   them the **plain standard signup link** (no token — *"just the standard
   instructions on how to sign up like anyone else"*), and resolve the invite
   when that email signs up. Design:
   - **`vm_pending_invites`, module-prefixed, NOT a generic
     `public.pending_invites`.** Two reasons: extract-don't-speculate (one
     consumer today), and `packages/db/src/view-as-coverage.test.ts` derives
     each module's tables from `pg_catalog` **by prefix**, so a `vm_`-named
     table is caught and forced into a view-as declaration while a
     `public.`-named one would silently escape that ratchet forever.
   - Typed FK `conversation_id → vm_conversations on delete cascade`. (A
     polymorphic `target_id` can carry no FK, so rows would outlive their
     targets and retry resolution forever.)
   - **`org_id` is never client-supplied** — derived by a BEFORE INSERT
     scope-sync trigger modelled on this module's own
     `vm_sync_from_conversation` (docs/03 #10). Without it a conversation admin
     can name a *different* org on the row, which under a signup-time trigger
     (`auth.uid()` null ⇒ the documented rank-ladder bypass at
     `20260727010000:543`) would be a cross-org membership injection.
   - **30-day expiry** (founder's call), resolver ignores expired rows, pg-boss
     pruner deletes them (precedent: `login_events`' pruner + daily job). The
     reason expiry is not optional: an email-keyed invite with no TTL is a
     standing grant to whoever controls that mailbox *at any future time* —
     Gmail never recycles addresses but corporate/university/ISP domains do, so
     a years-old unresolved invite would auto-admit a stranger who inherits the
     mailbox. Same mechanism covers a typo'd address.
   - Resolved at **signup**, by an `auth.users` AFTER INSERT trigger,
     **fail-OPEN** (a missed auto-join is recoverable; a signup outage is not):
     inner `begin…exception when others → raise warning end` around only the
     risky inserts, plus a function-scoped `lock_timeout`, copying
     `capture_login`'s exact shape. **Deliberately NOT from `(app)/layout.tsx`**
     — verified against this Next version's own docs
     (`node_modules/next/dist/docs/…/layout.md:180`): *"Layouts do not rerender
     on navigation,"* so a layout call would miss invites for an already-open
     session; and a mutating write during render would be the first on this
     platform (every `recordActivity` call site is in a server action).
   - Resolution creates a **pending** org seat, so accept-first holds
     identically for new and existing invitees.
   - `invited_by` (FK → `auth.users`) must be declared in
     `data-browser-modules.ts` or `data-browser-coverage.test.ts` TIER 1 fails.
5. **Self-block.** Permit a self-UPDATE of `vm_conversation_members.status` to
   `'banned'` only. Today `vm_pin_member`'s self-service branch pins
   `new.status := old.status`, so a member **cannot** opt out of being
   re-added: they may leave (`vm_members_delete_self`) and the admin re-inserts
   immediately. Cheapest real abuse mitigation available, and there is no
   user-level ban or rate limit anywhere on the platform (docs/16 P1-6).

### Deliberately NOT part of this

- **Public Square itself** — a genuinely public, org-independent space. The
  founder confirmed it is *worth having* and wants the capability; it is now
  its own workstream, needing docs/16 checklist items 1-3 decided (the P1-1 fix
  shape, roster-read restriction, module whitelist — **never the
  matchmaking family**, whose staff-tier `for all` policies would hand one
  org's admins the dating data of everyone opted in — plus named owner seats,
  an abuse path, and docs/16's asked-for *"written acknowledgment that Public
  Square means operating a public community, with the ongoing cost that
  implies"*). docs/16 notes it *"is not a new workstream; it is the acceptance
  test for"* the tenancy-core slice.
- **Anonymous public view-links** — still deferred post-v1, unchanged.

### Found in passing: a live cross-org hole (fixed separately, see the dated entry below)

`addMember` inserts a `vm_conversation_members` seat without checking the target
belongs to the conversation's org, and `vm_is_conv_member` / `vm_can_post` /
`vm_is_conv_admin` gate purely on the seat row. Bounded today only by
`profiles_select_shared_org` — i.e. by the very policy shape 2 would have
widened. Classroom already defends this exact class and documents it
(`modules/classroom/ui/manage/actions.ts:66-80`).

## Future enhancement: conversation-admin transfer (2026-07-16, not built)

Founder asked whether transferring ownership of a conversation (or,
separately, a classroom course — see module-2 spec) would be hard to add
later. Assessed as NOT architecturally hard: conversation admin is already
just a role on `vm_conversation_members` (per-conversation, not global), so
"transfer" is fundamentally removing the old admin's role + granting the new
one — the only real design work is the offer/accept flow itself (a pending-
transfer state so the new admin has to affirmatively accept, not just be
silently reassigned), which is comparable in shape to classroom's existing
peer-review-assignment or matchmaking's question-approval flows already
built on this platform. Parked as a future enhancement, not scoped further.
