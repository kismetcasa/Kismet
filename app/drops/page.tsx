import { notFound } from 'next/navigation'
import { DropsFeed } from '@/components/DropsFeed'
import { isDropsEnabled } from '@/lib/dropsStore'
import { SITE_URL } from '@/lib/siteUrl'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'claim drops — Kismet',
  description: 'Free-to-claim drops on Kismet: claim with one signature, receive the artwork when the drop settles.',
  alternates: { canonical: `${SITE_URL}/drops` },
}

export default async function DropsPage() {
  if (!(await isDropsEnabled())) notFound()
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <DropsFeed />
    </div>
  )
}
