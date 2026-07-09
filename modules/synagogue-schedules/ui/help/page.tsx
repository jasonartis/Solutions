import Link from 'next/link'
import { requireOrgModule } from '@/lib/module-gate'

// In-app setup guide for schedule makers (founder request 2026-07-07).

export default async function HelpPage(props: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await props.params
  const { org } = await requireOrgModule(orgSlug, 'synagogue-schedules')

  const step = 'mb-6 rounded-lg border border-gray-200 bg-white p-5'
  const h = 'mb-2 text-lg font-semibold'
  const code = 'rounded bg-gray-100 px-1 font-mono text-[13px]'

  return (
    <div className="max-w-3xl">
      <p className="mb-1 text-sm text-gray-400">{org.name}</p>
      <div className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Setting up your synagogue schedule</h1>
        <Link
          href={`/o/${orgSlug}/m/synagogue-schedules/setup`}
          className="text-sm text-blue-600 hover:underline"
        >
          Go to Setup →
        </Link>
      </div>

      <section className={step}>
        <h2 className={h}>1. The organization (done by the platform owner)</h2>
        <p className="text-sm leading-6 text-gray-700">
          Your synagogue exists as an <b>organization</b> with a name (shown on schedules) and a
          short <b>slug</b> used in web addresses. The platform owner creates it in the Owner
          Console, enables the <b>Synagogue Schedules</b> module for it, and sets the location
          (address/coordinates and timezone) that zmanim are computed from. If you&apos;re reading
          this inside your organization, this step is already done.
        </p>
      </section>

      <section className={step}>
        <h2 className={h}>2. Add your people</h2>
        <p className="text-sm leading-6 text-gray-700">
          Everyone signs up themselves at the login page first. Then the platform owner adds them
          to the organization (Owner Console → your org → &quot;Add member by email&quot;) and
          assigns module roles: <b>maker</b> for people who edit schedules (gabbai, office),{' '}
          <b>viewer</b> for members who only look. Congregants who just check times need{' '}
          <b>no account at all</b> — see the public link in step 6.
        </p>
      </section>

      <section className={step}>
        <h2 className={h}>3. Create schedule types and sections</h2>
        <p className="text-sm leading-6 text-gray-700">
          On the <Link className="text-blue-600 hover:underline" href={`/o/${orgSlug}/m/synagogue-schedules/setup`}>Setup page</Link>,
          create your documents — typically a <b>Weekday Schedule</b> (one document per week,
          triggered on <span className={code}>weekday</span>) and a <b>Shabbos Schedule</b>{' '}
          (triggered on <span className={code}>shabbat</span> + <span className={code}>erev-shabbat</span>).
          Names can include live tokens: <span className={code}>{'{shabbatTitle}'}</span> becomes
          &quot;שבת פרשת נח - שבת מברכים תשפ״ו&quot; automatically each week; also{' '}
          <span className={code}>{'{parsha}'}</span>, <span className={code}>{'{hebrewYear}'}</span>,{' '}
          <span className={code}>{'{moladText}'}</span>. Inside each schedule add <b>sections</b>{' '}
          — e.g. שחרית, מנחה ומעריב, שיעורים, ערב שבת, שבת קודש.
        </p>
      </section>

      <section className={step}>
        <h2 className={h}>4. Add lines (the actual times)</h2>
        <p className="mb-2 text-sm leading-6 text-gray-700">
          Each section holds <b>lines</b>. Open &quot;Add line&quot; and build the rule. Two
          worked examples:
        </p>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-gray-700">
          <li>
            <b>Fixed minyan:</b> name <span className={code}>Shachris (2)</span> → time kind{' '}
            <i>Fixed clock time</i> → <span className={code}>06:50</span> → check weekdays{' '}
            <i>Mon–Fri</i> (leave Sunday off so your 6:10 Sunday minyan can be its own line).
          </li>
          <li>
            <b>Zman-based:</b> name <span className={code}>Mincha &amp; Maariv</span> → kind{' '}
            <i>Zman-based</i> → zman <span className={code}>sunset</span> (or any myzmanim name
            like <span className={code}>Night50fix</span> in the free-text box) → offset{' '}
            <span className={code}>-20</span> → round <i>down</i> to <span className={code}>5</span>.
            For &quot;same time all week&quot; pick <i>earliest of week</i> or a specific day
            like <i>Friday&apos;s value</i>. &quot;Not before&quot; sets a floor (e.g. Mincha
            Gedolah never before 1:30 PM).
          </li>
        </ul>
        <p className="mt-2 text-sm leading-6 text-gray-700">
          Check the result immediately on the{' '}
          <Link className="text-blue-600 hover:underline" href={`/o/${orgSlug}/m/synagogue-schedules`}>Schedules page</Link>{' '}
          — it recomputes live as you edit, and ← / → moves between weeks.
        </p>
      </section>

      <section className={step}>
        <h2 className={h}>5. Weekly messages</h2>
        <p className="text-sm leading-6 text-gray-700">
          Sponsorships and announcements (&quot;Kiddush sponsored by…&quot;) are added per week at
          the bottom of the Setup page: pick the section, the week&apos;s Sunday date, and the
          text (Hebrew supported). They appear only on that week&apos;s schedule.
        </p>
      </section>

      <section className={step}>
        <h2 className={h}>6. Publish and share</h2>
        <p className="text-sm leading-6 text-gray-700">
          In Setup → <b>Published weeks</b>, publish each week you want visible. Congregants then
          see it — no login — at the shareable link:{' '}
          <span className={code}>solutions-platform.vercel.app/s/{orgSlug}</span>. Print/WhatsApp
          files come from the Schedules page → <b>Export this week</b>: every configured format
          (PDF for print, large JPG for the lobby screen, small JPG for WhatsApp) is generated in
          one click and listed for download.
        </p>
      </section>

      <p className="text-xs text-gray-400">
        Something you can&apos;t express with the rule builder? Tell the platform owner — the rule
        engine likely supports it already (line references, holiday conditions, fallback text).
      </p>
    </div>
  )
}
