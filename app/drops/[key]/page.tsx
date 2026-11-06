import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DropView } from '@/components/DropView'
import { isEntityKey, normalizeEntityKey } from '@/lib/drops'
import { isDropsEnabled } from '@/lib/dropsStore'
import { SITE_URL } from '@/lib/siteUrl'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ key: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params
  const canonicalKey = isEntityKey(key) ? normalizeEntityKey(key) : key
  return {
    title: 'claim drop — Kismet',
    description: 'A free-to-claim drop on Kismet. Claim with one signature — no gas, no fee.',
    // One URL per drop whatever the key's letter case; noindex while drops
    // are a flag-gated beta (and a drop's page lives only as long as its
    // Arkiv record).
    alternates: { canonical: `${SITE_URL}/drops/${canonicalKey}` },
    robots: { index: false },
  }
}

export default async function DropPage({ params }: Props) {
  const { key } = await params
  if (!isEntityKey(key) || !(await isDropsEnabled())) notFound()
  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      <DropView dropKey={normalizeEntityKey(key)} />
    </div>
  )
}
