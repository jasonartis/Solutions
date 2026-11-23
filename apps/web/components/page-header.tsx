import Link from 'next/link'
import type { ReactNode } from 'react'
import { resolveBack, safeFromPath, withFrom, type BackTarget } from '@/lib/back-link'

export { resolveBack, safeFromPath, withFrom }
export type { BackTarget }

// THE ONE BACK-LINK CONVENTION (founder, 2026-11-23; docs/03 convention #37).
//
//  1. Format "← Page name": the destination page's heading copied EXACTLY.
//  2. It goes where you CAME FROM when the linking page said so (?from=…), else
//     to the PARENT page. Always ONE back link.
//  3. Every page uses <PageHeader>; a top page (dashboard, a module home, the
//     console home) passes `back={null}` on purpose. The prop is REQUIRED so
//     TypeScript fails when a page forgets to decide.
//
// Enforced by packages/db/src/page-header-coverage.test.ts (scans every page).
// Server-component safe (no client code); modules import it as
// '@/components/page-header' the same way they import '@/lib/module-gate'.

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-sm text-blue-600 hover:underline" data-testid="back-link">
      ← {label}
    </Link>
  )
}

/**
 * Back link (top-left) + the page's h1. `back` is REQUIRED: a BackTarget, or
 * null for a top page. `eyebrow` is the small grey line above (usually the org
 * name); `children` are actions shown beside the title.
 */
export function PageHeader({
  title,
  back,
  eyebrow,
  children,
  className = 'mb-6',
  titleClassName = 'text-2xl font-semibold',
}: {
  title: ReactNode
  back: BackTarget | null
  eyebrow?: ReactNode
  children?: ReactNode
  className?: string
  titleClassName?: string
}) {
  const resolved = back ? resolveBack(back) : null
  return (
    <div className={className}>
      {eyebrow ? <p className="mb-1 text-sm text-gray-400">{eyebrow}</p> : null}
      {resolved ? (
        <div className="mb-1">
          <BackLink href={resolved.href} label={resolved.label} />
        </div>
      ) : null}
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className={titleClassName}>{title}</h1>
        {children}
      </div>
    </div>
  )
}
