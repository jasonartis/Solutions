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
