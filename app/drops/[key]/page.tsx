import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { DropView } from '@/components/DropView'
import { isDropOpen, isEntityKey, normalizeEntityKey } from '@/lib/drops'
import { getDropRecord, isDropsEnabled } from '@/lib/dropsStore'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { SITE_URL } from '@/lib/siteUrl'

// DROPS_ENABLED is read per request: a page prerendered at build time would
// freeze whatever the build environment said.
export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ key: string }>
}

// Cast into a feed, a drop renders as its artwork with a button that opens it
// in the Mini App — where claiming is one signature (lib/farcasterEmbed).
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { key } = await params
  const canonicalKey = isEntityKey(key) ? normalizeEntityKey(key) : key
  const drop = isEntityKey(key) && isDropsEnabled() ? await getDropRecord(normalizeEntityKey(key)).catch(() => null) : null
  const url = `${SITE_URL}/drops/${canonicalKey}`
  return {
    title: drop ? `${drop.title} — claim drop — Kismet` : 'claim drop — Kismet',
    description: 'A free-to-claim drop on Kismet. Claim with one signature — no gas, no fee.',
    // One URL per drop whatever the key's letter case; noindex while drops
    // are a flag-gated beta (and a drop's page lives only as long as its
    // Arkiv record).
    alternates: { canonical: url },
    robots: { index: false },
    ...(drop && {
      other: buildFarcasterEmbed({
        imageUrl: `${url}/opengraph-image`,
        buttonTitle: isDropOpen(drop.closesAt, Math.floor(Date.now() / 1000)) ? 'Claim — free' : 'See the drop',
        action: { url },
      }),
    }),
  }
}

export default async function DropPage({ params }: Props) {
  const { key } = await params
  if (!isEntityKey(key) || !isDropsEnabled()) notFound()
  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      <DropView dropKey={normalizeEntityKey(key)} />
    </div>
  )
}
