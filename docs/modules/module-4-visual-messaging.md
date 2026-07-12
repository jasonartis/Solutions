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
