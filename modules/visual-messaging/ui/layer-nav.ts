// Where each swipe from a layer leads, and how many swipes keep working that
// way (spec: left = descend into the first reply, right = back up to the
// parent, up/down = cycle siblings). Pure, so the SERVER page and the CLIENT
// canvas compute it identically: the canvas uses it to update the edge markers
// the instant a swipe completes instead of waiting for the server round-trip.
//
// `tree` is every layer of the conversation in PATH order (so sibling order is
// stable): just id + parent, nothing else.

export type LayerNav = {
  parentId: string | null
  firstChildId: string | null
  prevSiblingId: string | null
  nextSiblingId: string | null
  /** this layer + its siblings, in path order (for the dots) */
  siblings: { id: string; current: boolean }[]
  /** how many consecutive swipes each direction keeps working from here */
  swipeCounts: { left: number; right: number; up: number; down: number }
}

export type TreeNode = { id: string; parentId: string | null; frozen?: boolean; tombstoned?: boolean }

export function navFor(tree: TreeNode[], currentId: string): LayerNav {
  const byId = new Map(tree.map((n) => [n.id, n]))
  const current = byId.get(currentId)
  if (!current) {
    return {
      parentId: null,
      firstChildId: null,
      prevSiblingId: null,
      nextSiblingId: null,
      siblings: [{ id: currentId, current: true }],
      swipeCounts: { left: 0, right: 0, up: 0, down: 0 },
    }
  }
  const childrenOf = (id: string) => tree.filter((n) => n.parentId === id)
  const siblings = current.parentId ? tree.filter((n) => n.parentId === current.parentId) : [current]
  const sibIndex = siblings.findIndex((n) => n.id === currentId)

  // left follows the first-child chain down as far as it goes.
  let left = 0
  for (let id: string | null = currentId; id; ) {
    const kids = childrenOf(id)
    if (kids.length === 0) break
    left++
    id = kids[0]!.id
  }
  // right always ends at the root: one ancestor per hop.
  let right = 0
  for (let n: TreeNode | undefined = current; n?.parentId; n = byId.get(n.parentId)) right++

  return {
    parentId: current.parentId,
    firstChildId: childrenOf(currentId)[0]?.id ?? null,
    prevSiblingId: sibIndex > 0 ? siblings[sibIndex - 1]!.id : null,
    nextSiblingId: sibIndex >= 0 && sibIndex < siblings.length - 1 ? siblings[sibIndex + 1]!.id : null,
    siblings: siblings.map((n) => ({ id: n.id, current: n.id === currentId })),
    swipeCounts: { left, right, up: siblings.length - 1 - sibIndex, down: sibIndex },
  }
}
