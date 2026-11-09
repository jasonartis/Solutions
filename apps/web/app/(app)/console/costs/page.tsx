import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getProfile } from '@/lib/platform'
import { createClient } from '@/lib/supabase/server'
import { getRealNumbers } from '@/lib/costs-real'
import CostsCalculator from '@/components/costs-calculator'

// Owner Console cost model (docs/costs). Superadmin only. The only database access is
// read-only counts for the "Use my real numbers" button (lib/costs-real.ts).
export default async function CostsPage() {
  const profile = await getProfile()
  if (!profile?.is_superadmin) notFound()
  const real = await getRealNumbers(await createClient())

  return (
    <div>
      <p className="mb-2 text-sm">
        <Link href="/console" className="text-blue-600 hover:underline">
          ← Owner Console
        </Link>
      </p>
      <h1 className="mb-1 text-2xl font-semibold">Platform costs</h1>
      <p className="mb-6 max-w-3xl text-sm text-gray-600">
        What the platform costs per month and per year, by module, at any size, and what to charge. Built from the vendor price sheet below (each price dated) and the usage
        assumptions in <code>docs/costs/assumptions.md</code>. Above ~5 million users the architecture changes, so those rows are not the small-scale bill multiplied. Your own costs
        (legal, accountant, your time) are lines you add in section 5; they start at $0.
      </p>
      <CostsCalculator real={real} />
    </div>
  )
}
