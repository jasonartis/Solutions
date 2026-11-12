'use client'

// "Expand all" / "Collapse all" for the Owner Console's org cards (founder,
// 2026-11-10; made in-place 2026-11-12). They open or close the cards' native
// <details> right where they are — the same thing a click on one org does — so
// the page does not reload or jump to the top. (They used to be links to
// /console?expand=all, which reloaded the whole page.) The server still honours
// ?expand=all for a pasted link; it just is not what these buttons use.
function setAll(open: boolean) {
  document.querySelectorAll<HTMLDetailsElement>('section[data-testid="console-org"] > details').forEach((d) => {
    d.open = open
  })
}

export default function OrgExpandControls() {
  const cls = 'text-blue-600 hover:underline'
  return (
    <>
      <button type="button" onClick={() => setAll(true)} className={cls}>
        Expand all
      </button>
      <button type="button" onClick={() => setAll(false)} className={cls}>
        Collapse all
      </button>
    </>
  )
}
