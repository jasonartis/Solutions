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
   the conversation page).

## Read a thread

3. Open a conversation. You see the current layer drawn on top of everything
   under it. **Swipe on the picture to move around**: swipe **left** to dive
   into its first reply, **right** to go back up, **up/down** to flip between
   sibling replies (the dots under the picture show where you are — click a
   dot to jump). The **Layer** breadcrumb (e.g. 1 · 1.2 · 1.2.1) also shows
   where you are — click any part to jump up the chain.
4. **Replies to this layer** lists what was drawn in answer to it — click one
   to descend into it.
5. **Hold to X-ray** fades the drawings so you can see the original picture
   underneath.
6. React without drawing: the ❤️ and 😂 buttons under the picture.

## Reply by drawing

7. Click **Draw a reply** to switch the picture into drawing mode, pick a
   pen color and size, then draw directly on the picture. (**Cancel** returns
   to viewing without saving anything.)
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
1. Removed content: a moderator can tombstone a layer — its drawing is
   blanked but its slot stays, so replies drawn in its context still make
   sense. Restore brings the original back. (Both actions are audited.)
2. A conversation admin can freeze a branch (locks that subtree while the
   rest stays live) or the whole conversation.
3. Members can flag layers; the moderation queue UI is coming — today
   moderation actions run per layer.
`,
    },
  ],
}
