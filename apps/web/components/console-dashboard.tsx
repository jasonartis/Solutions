import Link from 'next/link'
import type { Dashboard, Severity } from '@/lib/console-dashboard'

// The Owner Console's "what needs me" panel (module-9 spec §H). Presentation
// only — every number comes from lib/console-dashboard.ts. Colour is never the
// only signal: each badge also carries a word.

const TILE: Record<Severity, { box: string; badge: string; word: string }> = {
  urgent: { box: 'border-red-300 bg-red-50', badge: 'bg-red-600 text-white', word: 'Urgent' },
  attention: { box: 'border-amber-300 bg-amber-50', badge: 'bg-amber-500 text-white', word: 'Needs you' },
  ok: { box: 'border-green-200 bg-green-50', badge: 'bg-green-600 text-white', word: 'All clear' },
  idle: { box: 'border-gray-200 bg-gray-50', badge: 'bg-gray-400 text-white', word: 'Not live' },
}

export default function ConsoleDashboard({ dashboard }: { dashboard: Dashboard }) {
  const { tiles, priorities } = dashboard
  return (
    <section data-testid="console-dashboard" className="mb-8">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => {
          const s = TILE[t.severity]
          return (
            <Link
              key={t.key}
              href={t.href}
              data-testid={`dash-tile-${t.key}`}
              data-severity={t.severity}
              className={`block rounded-lg border p-4 hover:shadow-sm ${s.box}`}
            >
              <div className="flex items-start justify-between gap-2">
                <h2 className="text-sm font-medium text-gray-800">{t.title}</h2>
                <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.badge}`}>{s.word}</span>
              </div>
              <p className="mt-2 text-3xl font-semibold text-gray-900">{t.count ?? '—'}</p>
              <p className="text-sm text-gray-600">{t.detail}</p>
              {t.lines.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-gray-600">
                  {t.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
              )}
            </Link>
          )
        })}
      </div>

      <div className="mt-4 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-2 text-sm font-medium text-gray-800">What needs you, most urgent first</h2>
        {priorities.length === 0 ? (
          <p data-testid="dash-priorities-empty" className="text-sm text-gray-600">
            Nothing needs you right now.
          </p>
        ) : (
          <ol className="space-y-1.5 text-sm">
            {priorities.map((p) => (
              <li key={p.text} className="flex items-center gap-2">
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                    p.severity === 'urgent' ? 'bg-red-600 text-white' : 'bg-amber-500 text-white'
                  }`}
                >
                  {p.severity === 'urgent' ? 'Urgent' : 'Needs you'}
                </span>
                <Link href={p.href} className="text-blue-700 hover:underline">
                  {p.text}
                </Link>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  )
}
