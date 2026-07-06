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
