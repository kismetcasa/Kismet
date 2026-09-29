import type { Metadata } from 'next'
import { SITE_URL } from '@/lib/siteUrl'
import { CapsuleStudio } from '@/components/CapsuleStudio'

export const metadata: Metadata = {
  title: 'capsule studio — Kismet',
  description:
    'Open a capsule machine of your own work: load artworks, set the rarity, and the odds are derived and published automatically.',
  alternates: { canonical: `${SITE_URL}/play/create-capsule` },
}

export default function CreateCapsulePage() {
  return (
    <div className="px-4 py-8">
      <CapsuleStudio />
    </div>
  )
}
