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

      <div className="space-y-4 text-sm leading-relaxed text-gray-700">
        <p>
          We keep track of what happens on the platform — like when you sign in and what you do
          within your organization — to keep things running smoothly and to help keep your
          account safe.
        </p>
        <p>
          If anyone on our staff ever needs to look at your account (for example, to help with a
          support question), that's tracked too — so there's always a record of who looked, and
          when.
        </p>
        <p>
          You can ask us to delete your account and personal info at any time. The one exception
          is that staff-access record — it stays on file permanently, even after your account is
          deleted, so it's no longer tied to your name, but the fact that someone looked, and
          when, is kept. That's on purpose: a record of staff access that could be erased
          wouldn't really protect anyone.
        </p>
        <p>Questions? Contact [FOUNDER EMAIL].</p>
      </div>

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
