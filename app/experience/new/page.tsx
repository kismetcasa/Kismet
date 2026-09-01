import type { Metadata } from 'next'
import { SITE_URL } from '@/lib/siteUrl'
import { CapsuleStudio } from '@/components/CapsuleStudio'

export const metadata: Metadata = {
  title: 'capsule studio — Kismet',
  description:
    'Build a capsule machine: choose the capsule, load the lineup, set weights and supplies. Odds are derived and published automatically.',
  alternates: { canonical: `${SITE_URL}/experience/new` },
}

export const dynamic = 'force-dynamic'

export default function CapsuleStudioPage() {
  return (
    <div className="px-4 py-8">
      <CapsuleStudio />
    </div>
  )
}
