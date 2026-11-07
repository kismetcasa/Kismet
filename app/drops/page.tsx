import { notFound } from 'next/navigation'
import { DropsFeed } from '@/components/DropsFeed'
import { isDropsEnabled } from '@/lib/dropsStore'
import { SITE_URL } from '@/lib/siteUrl'

// DROPS_ENABLED is read per request: a page prerendered at build time would
// freeze whatever the build environment said.
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'claim drops — Kismet',
  description: 'Free-to-claim drops on Kismet: claim with one signature, receive the artwork when the artist delivers it.',
  alternates: { canonical: `${SITE_URL}/drops` },
}

export default function DropsPage() {
  if (!isDropsEnabled()) notFound()
  return (
    <div className="max-w-3xl mx-auto px-4 py-12">
      <DropsFeed />
    </div>
  )
}
