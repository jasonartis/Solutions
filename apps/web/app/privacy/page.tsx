// DRAFT — not linked from any nav yet (docs/18 item 3). Founder owns the
// final wording; this is Claude's first pass for review, not published
// copy. Reachable directly at /privacy for review purposes only.
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-12 text-gray-800">
      <p className="mb-6 rounded border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-900">
        DRAFT — for founder review, not yet published or linked anywhere.
      </p>

      <h1 className="mb-2 text-2xl font-semibold">Privacy Policy</h1>
      <p className="mb-8 text-sm text-gray-500">Last updated: [DATE]</p>

      <Section title="What we collect">
        <p>When you use this platform, we collect:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Your account information</strong> — email address, and any profile
            information you provide (such as your name).
          </li>
          <li>
            <strong>Authentication events</strong> — a record of when you sign in. This helps us
            keep accounts secure and understand whether the platform is being used.
          </li>
          <li>
            <strong>Activity within your organizations</strong> — for the organizations you
            belong to, we record what you did and when (for example, that you registered for an
            event, submitted an assignment, or booked an appointment). This helps administrators
            of your organization see participation and helps us operate the platform reliably.
          </li>
          <li>
            <strong>Administrative access records</strong> — if platform staff ever need to look
            at your account to help with a support request or investigate an issue, we keep a
            permanent record that this happened (who looked, when, whose account). You cannot be
            looked at without this being recorded.
          </li>
        </ul>
      </Section>

      <Section title="How long we keep it">
        <p>
          Authentication and activity records are kept in detail for 90 days, then reduced to a
          summary (for example, "last seen" and basic counts) that we keep permanently. The
          administrative access record described above is kept permanently and cannot be
          shortened or deleted — see below for why.
        </p>
      </Section>

      <Section title="Who can see it">
        <p>
          Ordinary members of your organization cannot see this data about you. It is visible
          only to your organization's administrators (for participation summaries) and to
          platform staff (for security and support purposes).
        </p>
      </Section>

      <Section title="Deletion requests">
        <p>
          You can ask us to delete your account and personal information at any time. When you
          do, we will remove your profile information and disconnect it from your activity
          history.
        </p>
        <p>
          <strong>One deliberate exception:</strong> the administrative access record described
          above (who looked at an account, and when) is never deleted, even for accounts that
          are removed — it becomes anonymous (no longer linked to your name), but the fact that a
          lookup happened, on that date, is kept permanently. This is by design: a security
          record that can be erased on request isn't a meaningful security record. It exists to
          protect you — so that any access to your account is independently auditable, including
          after the fact.
        </p>
      </Section>

      <Section title="Questions">
        <p>
          Contact [FOUNDER EMAIL] with any questions about this policy or to make a data
          request.
        </p>
      </Section>

      <hr className="my-10 border-gray-200" />

      <h1 className="mb-2 text-2xl font-semibold">Terms of Service</h1>
      <p className="mb-8 text-sm text-gray-500">Last updated: [DATE]</p>

      <Section title="The short version">
        <p>
          This platform is provided by [FOUNDER/COMPANY NAME] to power the organization you're a
          member of (shown in your account). Your organization's administrators manage your
          membership and access; we provide the underlying technology and are responsible for
          keeping it running and your data secure.
        </p>
      </Section>

      <Section title="Acceptable use">
        <p>
          Use the platform only for its intended purpose within your organization. Don't attempt
          to access data or accounts that aren't yours, disrupt the service, or use it for
          anything unlawful.
        </p>
      </Section>

      <Section title="No warranty / limitation of liability">
        <p>
          The service is provided "as is." We work to keep it reliable and your data safe, but we
          don't guarantee uninterrupted availability, and [FOUNDER/COMPANY NAME]'s liability for
          any issue is limited to the extent permitted by law.
        </p>
      </Section>

      <Section title="Changes">
        <p>
          We may update these terms or the privacy policy as the platform evolves. Material
          changes will be reflected here with an updated date.
        </p>
      </Section>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-gray-700">{children}</div>
    </section>
  )
}
