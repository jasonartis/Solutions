import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { getProfile } from '@/lib/platform'
import {
  CREDENTIAL_STORES,
  DATE_KINDS,
  IF_LOST,
  PART_B_URL,
  SIGN_IN_METHODS,
  daysUntil,
  getVendorData,
  vendorIssues,
  type VendorAccount,
} from '@/lib/vendor-accounts'
import {
  addVendorCredential,
  addVendorDate,
  deleteVendorCredential,
  deleteVendorDate,
  saveVendorAccount,
  setVendorDateDone,
} from './actions'

// Vendor accounts (docs/28 Part A): every outside account the platform depends
// on, for the founder to "manage everything and stay on top of all accounts".
// Superadmin-only by RLS; the notFound() below is presentation.

const inputCls = 'rounded border border-gray-300 px-2 py-1 text-sm'
const DAY = 24 * 3600 * 1000

const NO_SECRETS =
  'Never type a password or key here. Record only WHERE it is kept, by name. The database refuses ' +
  'text that looks like a key or password, but it cannot spot one written as ordinary words.'

const IF_LOST_STYLE: Record<VendorAccount['if_lost'], string> = {
  platform_down: 'bg-red-100 text-red-800',
  feature_down: 'bg-amber-100 text-amber-800',
  invisible: 'bg-gray-100 text-gray-700',
  unclassified: 'bg-gray-100 text-gray-500',
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ')
}

/** The edit/add form. One component for both, so the two never drift. */
function AccountForm({ account }: { account: VendorAccount | null }) {
  const a = account
  const action = saveVendorAccount.bind(null, a?.id ?? null)
  const field = (label: string, input: React.ReactNode, wide = false) => (
    <label className={`text-xs text-gray-600 ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="mb-0.5 block font-medium">{label}</span>
      {input}
    </label>
  )
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-2">
      {field('Service', <input name="service" required defaultValue={a?.service ?? ''} className={`${inputCls} w-full`} />)}
      {field(
        'Status',
        <select name="status" defaultValue={a?.status ?? 'active'} className={`${inputCls} w-full`}>
          <option value="active">active</option>
          <option value="planned">planned (not created yet)</option>
          <option value="closed">closed</option>
        </select>,
      )}
      {field('What it is used for', <input name="used_for" defaultValue={a?.used_for ?? ''} className={`${inputCls} w-full`} />, true)}
      {field(
        'Sign-in page (https, no ?query)',
        <input name="sign_in_url" type="url" defaultValue={a?.sign_in_url ?? ''} className={`${inputCls} w-full`} />,
      )}
      {field(
        'How you sign in',
        <select name="sign_in_method" defaultValue={a?.sign_in_method ?? 'unknown'} className={`${inputCls} w-full`}>
          {Object.entries(SIGN_IN_METHODS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>,
      )}
      {field('Owned by (email or user name)', <input name="owner_login" defaultValue={a?.owner_login ?? ''} className={`${inputCls} w-full`} />)}
      {field(
        'Two-step verification',
        <select name="two_step" defaultValue={a?.two_step ?? 'unknown'} className={`${inputCls} w-full`}>
          <option value="unknown">not recorded</option>
          <option value="on">on</option>
          <option value="off">off</option>
        </select>,
      )}
      {field('Plan or tier', <input name="plan" defaultValue={a?.plan ?? ''} className={`${inputCls} w-full`} />)}
      {field(
        'Monthly cost (USD)',
        <input name="monthly_cost_usd" inputMode="decimal" defaultValue={a?.monthly_cost_usd ?? ''} className={`${inputCls} w-full`} />,
      )}
      {field('How it is paid', <input name="paid_how" defaultValue={a?.paid_how ?? ''} className={`${inputCls} w-full`} />)}
      {field(
        'Payment',
        <select name="payment_status" defaultValue={a?.payment_status ?? 'unknown'} className={`${inputCls} w-full`}>
          <option value="unknown">not recorded</option>
          <option value="ok">ok</option>
          <option value="failing">failing</option>
          <option value="free">free (nothing to pay)</option>
        </select>,
      )}
      {field('Last paid', <input name="last_paid_on" type="date" defaultValue={a?.last_paid_on ?? ''} className={`${inputCls} w-full`} />)}
      {field('Next charge', <input name="next_charge_on" type="date" defaultValue={a?.next_charge_on ?? ''} className={`${inputCls} w-full`} />)}
      {field(
        'If we lose it',
        <select name="if_lost" defaultValue={a?.if_lost ?? 'unclassified'} className={`${inputCls} w-full`}>
          {Object.entries(IF_LOST).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>,
      )}
      {field(
        'Part B plan (e.g. B.3-1)',
        <input name="part_b_ref" defaultValue={a?.part_b_ref ?? ''} pattern="B\.[0-9]+(-[0-9]+)?" className={`${inputCls} w-full`} />,
      )}
      {field('What breaks if it is lost', <textarea name="breaks_if_lost" rows={2} defaultValue={a?.breaks_if_lost ?? ''} className={`${inputCls} w-full`} />, true)}
      {field('Notes', <textarea name="notes" rows={3} defaultValue={a?.notes ?? ''} className={`${inputCls} w-full`} />, true)}
      <p className="text-xs text-amber-800 sm:col-span-2">{NO_SECRETS}</p>
      <div className="sm:col-span-2">
        <button className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700">
          {a ? 'Save changes' : 'Add account'}
        </button>
      </div>
    </form>
  )
}

export default async function VendorAccountsPage(props: { searchParams?: Promise<{ error?: string; show?: string }> }) {
  const profile = await getProfile()
  if (!profile?.is_superadmin) notFound()
  const { error: actionError, show } = (await props.searchParams) ?? {}

  const supabase = await createClient()
  let data
  try {
    data = await getVendorData(supabase)
  } catch (e) {
    return (
      <p className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
        Could not read vendor accounts: {(e as Error).message}
      </p>
    )
  }

  const now = Date.now()
  const issues = vendorIssues(data, now)
  const shown = data.accounts.filter((a) => (show === 'all' ? true : a.status !== 'closed'))
  const monthly = data.accounts
    .filter((a) => a.status === 'active')
    .reduce((sum, a) => sum + (a.monthly_cost_usd === null ? 0 : Number(a.monthly_cost_usd)), 0)
  const unpriced = data.accounts.filter((a) => a.status === 'active' && a.monthly_cost_usd === null).length

  return (
    <div>
      <Link href="/console" className="text-sm text-blue-600 hover:underline">
        ← Owner Console
      </Link>
      <h1 className="mt-2 mb-1 text-2xl font-semibold">Vendor accounts</h1>
      <p className="mb-4 text-sm text-gray-600">
        Every outside account the platform depends on. Go to a vendor through its <strong>Open</strong> button, so this
        page records when you last checked it. What to do if one is lost:{' '}
        <a href={PART_B_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
          docs/28 Part B
        </a>
        .
      </p>

      {actionError && (
        <p data-testid="vendors-error" className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {actionError}
        </p>
      )}

      <div className="mb-6 flex flex-wrap gap-4 text-sm text-gray-700">
        <span>
          <strong>{data.accounts.filter((a) => a.status === 'active').length}</strong> active
        </span>
        <span>
          <strong>{data.accounts.filter((a) => a.status === 'planned').length}</strong> planned
        </span>
        <span>
          <strong>${monthly.toFixed(2)}</strong>/month recorded{unpriced ? ` (${unpriced} with no cost recorded)` : ''}
        </span>
        <span data-testid="vendors-issue-count">
          <strong>{issues.length}</strong> to check
        </span>
        <Link href={show === 'all' ? '/console/vendors' : '/console/vendors?show=all'} className="text-blue-600 hover:underline">
          {show === 'all' ? 'hide closed' : 'show closed'}
        </Link>
      </div>

      <div className="space-y-4">
        {shown.map((a) => {
          const opens = data.opens.filter((o) => o.account_id === a.id)
          const lastOpen = opens[0]?.opened_at ?? null
          const opens90 = opens.filter((o) => now - new Date(o.opened_at).getTime() <= 90 * DAY).length
          const dates = data.dates.filter((d) => d.account_id === a.id)
          const creds = data.credentials.filter((c) => c.account_id === a.id)
          const mine = issues.filter((i) => i.accountId === a.id)
          return (
            <section key={a.id} data-testid={`vendor-${a.service}`} className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium">
                    {a.service}
                    {a.status !== 'active' && <span className="ml-2 text-sm font-normal text-gray-500">({a.status})</span>}
                  </h2>
                  <p className="text-sm text-gray-600">{a.used_for}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={`rounded px-2 py-0.5 text-xs font-medium ${IF_LOST_STYLE[a.if_lost]}`}>{IF_LOST[a.if_lost]}</span>
                  {a.sign_in_url && (
                    // A form, not a link: the click is recorded server-side, then
                    // the vendor opens in a new tab (open/route.ts).
                    <form action="/console/vendors/open" method="post" target="_blank">
                      <input type="hidden" name="account_id" value={a.id} />
                      <button
                        data-testid={`vendor-open-${a.service}`}
                        className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700"
                      >
                        Open ↗
                      </button>
                    </form>
                  )}
                </div>
              </div>

              {mine.length > 0 && (
                <ul className="mt-2 space-y-1 text-sm">
                  {mine.map((i) => (
                    <li key={i.text} className="flex items-center gap-2">
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-medium text-white ${
                          i.severity === 'urgent' ? 'bg-red-600' : 'bg-amber-500'
                        }`}
                      >
                        {i.severity === 'urgent' ? 'Urgent' : 'Needs you'}
                      </span>
                      {i.text.replace(`${a.service}: `, '')}
                    </li>
                  ))}
                </ul>
              )}

              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div>
                  <dt className="inline text-gray-500">Last opened: </dt>
                  <dd className="inline" data-testid={`vendor-last-opened-${a.service}`}>
                    {lastOpen ? `${fmtDateTime(lastOpen)} UTC` : 'never'}
                  </dd>
                  <span className="text-gray-400"> · {opens90} in 90 days, {opens.length} total</span>
                </div>
                <div>
                  <dt className="inline text-gray-500">Sign in: </dt>
                  <dd className="inline">{SIGN_IN_METHODS[a.sign_in_method]}</dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">Owned by: </dt>
                  <dd className="inline">{a.owner_login ?? '—'}</dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">Two-step: </dt>
                  <dd className={`inline ${a.two_step === 'off' ? 'font-medium text-red-700' : ''}`}>
                    {a.two_step === 'unknown' ? 'not recorded' : a.two_step}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">Plan: </dt>
                  <dd className="inline">
                    {a.plan ?? '—'}
                    {a.monthly_cost_usd !== null ? ` · $${Number(a.monthly_cost_usd).toFixed(2)}/mo` : ''}
                  </dd>
                </div>
                <div>
                  <dt className="inline text-gray-500">Payment: </dt>
                  <dd className={`inline ${a.payment_status === 'failing' ? 'font-medium text-red-700' : ''}`}>
                    {a.payment_status === 'unknown' ? 'not recorded' : a.payment_status}
                    {a.paid_how ? ` · ${a.paid_how}` : ''}
                    {a.last_paid_on ? ` · last paid ${a.last_paid_on}` : ''}
                    {a.next_charge_on ? ` · next ${a.next_charge_on}` : ''}
                  </dd>
                </div>
              </dl>

              {a.breaks_if_lost && (
                <p className="mt-2 text-sm text-gray-700">
                  <span className="text-gray-500">If lost: </span>
                  {a.breaks_if_lost}
                  {a.part_b_ref && (
                    <>
                      {' '}
                      <a href={PART_B_URL} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                        Plan: docs/28 {a.part_b_ref}
                      </a>
                    </>
                  )}
                </p>
              )}
              {a.notes && <p className="mt-1 text-sm whitespace-pre-wrap text-gray-700">{a.notes}</p>}

              <div className="mt-3 grid gap-4 border-t border-gray-100 pt-3 md:grid-cols-2">
                <div>
                  <h3 className="mb-1 text-sm font-medium text-gray-700">Dates not to miss</h3>
                  {dates.length === 0 ? (
                    <p className="text-xs text-gray-500">None recorded.</p>
                  ) : (
                    <ul className="space-y-1 text-sm">
                      {dates.map((d) => {
                        const days = d.due_on ? daysUntil(d.due_on, now) : null
                        return (
                          <li key={d.id} className={`flex flex-wrap items-center gap-2 ${d.done_on ? 'text-gray-400 line-through' : ''}`}>
                            <span>
                              {DATE_KINDS[d.kind]}: {d.label} — {d.due_on ?? 'date not recorded'}
                              {days !== null && !d.done_on ? ` (${days < 0 ? `${-days} days ago` : `in ${days} days`})` : ''}
                            </span>
                            <form action={setVendorDateDone.bind(null, d.id, !d.done_on)}>
                              <button className="text-xs text-blue-600 hover:underline">{d.done_on ? 'reopen' : 'mark done'}</button>
                            </form>
                            <form action={deleteVendorDate.bind(null, d.id)}>
                              <button className="text-xs text-red-600 hover:underline">delete</button>
                            </form>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                  <form action={addVendorDate.bind(null, a.id)} className="mt-2 flex flex-wrap items-center gap-1">
                    <select name="kind" className={inputCls} defaultValue="key_expiry">
                      {Object.entries(DATE_KINDS).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <input name="label" placeholder="what (e.g. VERCEL_TOKEN expires)" className={`${inputCls} w-56`} />
                    <input name="due_on" type="date" className={inputCls} />
                    <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">Add date</button>
                  </form>
                </div>

                <div>
                  <h3 className="mb-1 text-sm font-medium text-gray-700">Where its credentials are kept (names only)</h3>
                  {creds.length === 0 ? (
                    <p className="text-xs text-gray-500">None recorded.</p>
                  ) : (
                    <ul className="space-y-0.5 text-sm">
                      {creds.map((c) => (
                        <li key={c.id} className="flex items-center gap-2">
                          <span>
                            {CREDENTIAL_STORES[c.store]}
                            {c.name ? (
                              <>
                                {' → '}
                                <code className="text-xs">{c.name}</code>
                              </>
                            ) : null}
                          </span>
                          <form action={deleteVendorCredential.bind(null, c.id)}>
                            <button className="text-xs text-red-600 hover:underline">remove</button>
                          </form>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form action={addVendorCredential.bind(null, a.id)} className="mt-2 flex flex-wrap items-center gap-1">
                    <select name="store" className={inputCls} defaultValue="env_deploy">
                      {Object.entries(CREDENTIAL_STORES).map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                    <input
                      name="name"
                      placeholder="VARIABLE_NAME (never the value)"
                      pattern="[A-Z][A-Z0-9]*(_[A-Z0-9]+)*"
                      className={`${inputCls} w-56 font-mono`}
                    />
                    <button className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">Add</button>
                  </form>
                </div>
              </div>

              <details className="mt-3 border-t border-gray-100 pt-3">
                <summary className="cursor-pointer text-sm text-blue-600">Edit {a.service}</summary>
                <div className="mt-2">
                  <AccountForm account={a} />
                </div>
              </details>
              <p className="mt-2 text-xs text-gray-400">Last edited {fmtDateTime(a.updated_at)} UTC</p>
            </section>
          )
        })}
      </div>

      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-2 text-lg font-medium">Add an account</h2>
        <p className="mb-2 text-xs text-gray-600">
          docs/28: before adopting a new outside service, give it a row here and a Part B plan, in the same session.
        </p>
        <AccountForm account={null} />
      </section>
    </div>
  )
}
