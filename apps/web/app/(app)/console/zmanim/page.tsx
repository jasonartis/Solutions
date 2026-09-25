import { requireSuperadmin } from '@/lib/platform'
import {
  getLastSweepSummary,
  getZmanimApiHealth,
  getZmanimCallCountsThisMonth,
  getZmanimCoverage,
  getZmanimPrefetchSettings,
} from '@/lib/zmanim-console'
import { updateZmanimPrefetchSettings } from './actions'

// The Owner Console's zmanim screen (docs/23 §5c) — "is the next year covered,
// and if not, where are the holes?" V1 is deliberately READ-ONLY for anything
// that would enqueue a job (Fill gaps / Backfill year / Run sweep now): prod has
// no continuously-running worker (docs/23 §7), so those buttons would appear to
// work and silently do nothing. The settings knobs stay editable — they are a
// pure metadata write (platform_setting_merge) with no worker dependency.
// Filling coverage stays scripts/zmanim-backfill.mts until that changes.

const inputCls = 'w-20 rounded border border-gray-300 px-2 py-1 text-sm'

function relative(iso: string | null): string {
  if (!iso) return 'never'
  const ms = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 60) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}

export default async function ZmanimConsolePage() {
  const { supabase } = await requireSuperadmin()

  const settings = await getZmanimPrefetchSettings(supabase)
  const [health, counts, lastSweep, coverage] = await Promise.all([
    getZmanimApiHealth(supabase),
    getZmanimCallCountsThisMonth(supabase),
    getLastSweepSummary(supabase),
    getZmanimCoverage(supabase, settings.horizonDays),
  ])

  const totalCalls = counts.sweep + counts.maker + counts.backfill

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold">Zmanim prefetch</h1>
      <p className="mb-6 text-sm text-gray-400">
        Is the next year covered, and if not, where are the holes? Read-only for now — see
        docs/23 §5c for why the action buttons wait on a running worker.
      </p>

      {/* Settings — the one part of this screen that writes anything, and it
          writes only metadata (docs/23 §2), never a job. */}
      <form
        action={updateZmanimPrefetchSettings}
        className="mb-6 rounded-lg border border-gray-200 bg-white p-5"
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" name="enabled" defaultChecked={settings.enabled} />
            Daily prefetch {settings.enabled ? '● ON' : '○ OFF'}
          </label>
          <button
            type="submit"
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save
          </button>
        </div>
        {!settings.enabled && settings.pausedReason && (
          <p className="mb-3 text-sm text-amber-600">{settings.pausedReason}</p>
        )}
        <div className="flex flex-wrap gap-6 text-sm text-gray-600">
          <label className="flex items-center gap-2">
            Horizon
            <input
              type="number"
              name="horizonDays"
              min={1}
              max={400}
              defaultValue={settings.horizonDays}
              className={inputCls}
            />
            days
          </label>
          <label className="flex items-center gap-2">
            Budget
            <input
              type="number"
              name="budgetPerRun"
              min={1}
              defaultValue={settings.budgetPerRun}
              className={inputCls}
            />
            calls/run
          </label>
          <label className="flex items-center gap-2">
            Auto-pause after
            <input
              type="number"
              name="pauseAfterDays"
              min={1}
              defaultValue={settings.pauseAfterDays}
              className={inputCls}
            />
            days with no successful sweep call
          </label>
        </div>
        {settings.updatedAt && (
          <p className="mt-3 text-xs text-gray-400">Last changed {relative(settings.updatedAt)}</p>
        )}
      </form>

      {/* API health */}
      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-gray-500">
          API health
        </h2>
        {!health.everCalled ? (
          <p className="text-sm text-gray-500">
            No call has ever been logged from this environment. That is expected on production —
            the myzmanim key never travels there (docs/23 §7); the cache was filled by copying
            rows fetched from a dev environment.
          </p>
        ) : health.healthy ? (
          <p className="text-sm text-green-600">
            ✓ Healthy — last success {relative(health.lastSuccessAt)}
          </p>
        ) : (
          <div className="text-sm">
            <p className="text-red-600">✕ Last call failed — {relative(health.lastCallAt)}</p>
            {health.lastErrMsg && <p className="mt-1 text-gray-600">ErrMsg: {health.lastErrMsg}</p>}
            <p className="mt-1 text-gray-500">
              Last success: {relative(health.lastSuccessAt)}. Every schedule is serving hebcal
              fallback until this clears.
            </p>
          </div>
        )}
      </div>

      {/* Counters + last sweep */}
      <div className="mb-6 grid gap-4 rounded-lg border border-gray-200 bg-white p-5 text-sm text-gray-600 sm:grid-cols-2">
        <p>
          Calls this month: <span className="font-medium text-gray-900">{totalCalls}</span>{' '}
          (sweep {counts.sweep} · maker {counts.maker} · backfill {counts.backfill})
        </p>
        <p>
          {lastSweep.atISO ? (
            <>
              Last sweep {relative(lastSweep.atISO)}, {lastSweep.written} written,{' '}
              {lastSweep.failed} failed
            </>
          ) : (
            'Last sweep: never (sweep is disabled or has not run yet)'
          )}
        </p>
      </div>

      {/* Per-location coverage */}
      <div className="rounded-lg border border-gray-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-gray-500">
          Coverage by location
        </h2>
        {coverage.length === 0 ? (
          <p className="text-sm text-gray-400">
            No org has a myzmanim location configured yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-left text-xs uppercase tracking-wide text-gray-400">
                <th className="py-2 pr-4">Location</th>
                <th className="py-2 pr-4">Orgs</th>
                <th className="py-2 pr-4">Coverage</th>
                <th className="py-2">First gap</th>
              </tr>
            </thead>
            <tbody>
              {coverage.map((row) => (
                <tr key={row.locationKey} className="border-b border-gray-50">
                  <td className="py-2 pr-4 font-mono text-xs">{row.locationKey}</td>
                  <td className="py-2 pr-4 text-gray-600">{row.orgNames.join(', ')}</td>
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="flex gap-px" title={`${row.cachedDays} / ${row.horizonDays} days cached`}>
                        {row.weeksCovered.map((covered, i) => (
                          <span
                            key={i}
                            className={`inline-block h-3 w-1.5 ${covered ? 'bg-green-500' : 'bg-gray-200'}`}
                          />
                        ))}
                      </span>
                      <span className="text-xs text-gray-500">
                        {row.cachedDays} / {row.horizonDays}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 text-gray-600">{row.firstGapISO ?? '— fully covered —'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
