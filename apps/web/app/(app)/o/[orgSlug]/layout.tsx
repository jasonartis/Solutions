import { getMyOrgRole } from '@/lib/platform'

// Founder feedback (2026-07-11): "once you click in you lose sight of your
// role" — the dashboard card shows a role badge, but nothing carries that
// forward once you're inside the org's pages. This thin layout wraps every
// /o/<slug>/* route with a small role indicator. Deliberately does NOT
// repeat the org name — every module page already prints that itself as
// its own first line; showing it again here would just duplicate it.
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ orgSlug: string }>
}) {
  const { orgSlug } = await params
  const me = await getMyOrgRole(orgSlug)

  return (
    <div>
      {me && (
        <div className="mb-2 flex justify-end">
          <span className="flex items-center gap-1.5 text-[11px] text-gray-400">
            Your role here:
            <span
              className={
                'rounded-full px-2 py-0.5 font-semibold uppercase tracking-wide ' +
                (me.role === 'owner'
                  ? 'bg-purple-100 text-purple-700'
                  : me.role === 'admin'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-gray-100 text-gray-600')
              }
            >
              {me.role}
            </span>
          </span>
        </div>
      )}
      {children}
    </div>
  )
}
