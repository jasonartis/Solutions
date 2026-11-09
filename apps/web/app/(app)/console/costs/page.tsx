import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProfile } from '@/lib/platform'
import CostsCalculator from '@/components/costs-calculator'

// Owner Console cost model (docs/costs). Superadmin only; reads no database tables.
export default async function CostsPage() {
  const profile = await getProfile()
  if (!profile?.is_superadmin) notFound()

  return (
    <div>
      <p className="mb-2 text-sm">
        <Link href="/console" className="text-blue-600 hover:underline">
          ← Owner Console
        </Link>
      </p>
      <h1 className="mb-1 text-2xl font-semibold">Platform costs</h1>
      <p className="mb-6 max-w-3xl text-sm text-gray-600">
        What the platform costs per month and per year, by module, at any size, and what it would have to charge. Built from the vendor price sheet below (each price dated) and the
        usage assumptions in <code>docs/costs/assumptions.md</code>. Above ~5 million users the architecture changes, so those rows are not the small-scale bill multiplied. Staff costs
        are not included.
      </p>
      <CostsCalculator />
    </div>
  )
}
