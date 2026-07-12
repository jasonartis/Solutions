// Visual-messaging walkthroughs (docs/03 user-walkthrough decision). UPDATE
// RULE: a UI change updates the matching steps here in the same commit.
import type { ModuleHelp } from '@platform/core'

export const visualMessagingHelp: ModuleHelp = {
  moduleKey: 'visual-messaging',
  guides: [
    {
      role: 'member',
      title: 'Member — draw your side of the conversation',
      body: `
## The idea
A conversation starts with a picture. Every reply is a transparent drawing on
top of the layer it answers — so a thread becomes a tree of layers you can
walk through.

## Start a conversation

1. From the Dashboard, click **Visual Messaging** on your organization's card.
2. Under **Start a conversation**, type a title, choose a picture, click
   **Create**. You're its admin; add people with **Add member** (bottom of
   the conversation page), or open it to link-joining (see the moderator
   guide) and share its link.

## Join by a shared link

If someone sends you a link to a conversation you're not in yet and its owner
has opened it up, the page offers **Join conversation** — click it to join as
a read-only viewer (you can watch and react, but not draw until an admin gives
you a drawing seat). Invite-only conversations can't be joined this way.

## Read a thread

3. Open a conversation. You see the current layer drawn on top of everything
   under it. **Swipe on the picture to move around**: swipe **left** to dive
   into its first reply, **right** to go back up, **up/down** to flip between
   sibling replies (the dots under the picture show where you are — click a
   dot to jump). The **Layer** breadcrumb (e.g. 1 · 1.2 · 1.2.1) also shows
   where you are — click any part to jump up the chain.
4. **Replies to this layer** lists what was drawn in answer to it — click one
   to descend into it. For the bird's-eye view, click **Tree view**: every
   layer appears as a small thumbnail grouped by level — click any thumbnail
   to jump straight to it, then **Back to layer** returns to normal viewing.
5. **Hold to X-ray** fades the drawings so you can see the original picture
   underneath.
6. React without drawing: the ❤️ and 😂 buttons under the picture. If a layer
   is a problem, click **Flag this layer**, pick a reason, and submit — a
   moderator will review it (you won't be told what they decide).

## Reply by drawing

7. Click **Draw a reply** to switch the picture into drawing mode. Choose the
   **Pen** tool (pick a color and size, then draw directly on the picture) or
   the **Emoji** tool (pick an emoji and a size, then tap the picture to drop
   it) — a reply can mix both. (**Cancel** returns to viewing without saving
   anything.)
8. **Clear draft** starts over — nothing is saved until you send.
9. Click **Send reply**. Your drawing becomes a new layer under the one you
   were viewing. Once someone replies on top of yours, it can't be edited —
   that's what keeps every reply's context intact.
`,
    },
    {
      role: 'moderator',
      title: 'Moderator — keep conversations healthy',
      staff: true,
      body: `
1. Open any conversation you moderate and scroll to the **Moderation**
   section (below the reply list). **Flagged content** lists every report in
   this conversation — reason, who reported it (the flagged layer's author
   never sees this), and a jump-to-layer link.
2. **Mark actioned** or **Dismiss** closes a flag once you've decided.
3. **Remove this layer** tombstones whatever layer you're currently viewing —
   its drawing is blanked but its slot stays, so replies drawn in its context
   still make sense. **Restore this layer** brings the original back. Both
   actions are audited (who, when, and — for a removal — the original
   content, kept in the moderation log even though it's gone from the
   thread).
4. **Freeze this branch** locks that layer and everything drawn under it
   (view-only, no new replies); **Unfreeze** reopens it. (Freezing and
   membership below are conversation-admin actions — a moderator who isn't an
   admin sees the flag tools above but not these.)
5. **Members (admin):** **Link joining** controls whether someone in your
   organization who has the conversation's link can join themselves as a
   read-only viewer. Click **Open to anyone with the link** to allow it (share
   the page URL), or **Make invite-only** to require an explicit **Add
   member**. Invite-only is the default.
`,
    },
  ],
}
