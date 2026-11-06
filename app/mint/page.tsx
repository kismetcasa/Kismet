import { MintTabs } from '@/components/MintTabs'
import { SITE_URL } from '@/lib/siteUrl'
import { isEntityKey, normalizeEntityKey, settlementRecipients } from '@/lib/drops'
import { isDropsEnabled } from '@/lib/dropsStore'
import { listClaims } from '@/lib/arkiv/drops'

export const metadata = {
  title: 'mint — Kismet',
  description: 'mint artworks and create collections on Kismet',
  // Prefill links (?collection=&name=&tab=&drop=) are all the same page —
  // collapse every variant onto one indexable URL.
  alternates: { canonical: `${SITE_URL}/mint` },
}

interface Props {
  searchParams: Promise<{ collection?: string; name?: string; tab?: string; drop?: string }>
}

/**
 * A settling claim drop links here as ?tab=airdrop&drop=<key>: the claim list
 * is read from Arkiv and handed to the airdrop form, so the artist sends one
 * airdrop to exactly the wallets that claimed (each claim's current owner).
 * Any failure just opens the form empty — the artist can still paste.
 */
async function dropRecipients(drop: string | undefined): Promise<string[] | undefined> {
  if (!drop || !isEntityKey(drop)) return undefined
  try {
    if (!(await isDropsEnabled())) return undefined
    return settlementRecipients(await listClaims(normalizeEntityKey(drop)))
  } catch (err) {
    console.error('[mint] could not read drop claims', err)
    return undefined
  }
}

export default async function MintPage({ searchParams }: Props) {
  const { collection, name, tab, drop } = await searchParams
  const [initialRecipients, dropsEnabled] = await Promise.all([
    dropRecipients(drop),
    isDropsEnabled().catch(() => false),
  ])
  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      <MintTabs
        initialCollection={collection}
        initialCollectionName={name}
        initialTab={initialRecipients ? 'airdrop' : tab}
        initialRecipients={initialRecipients}
        dropsEnabled={dropsEnabled}
      />
    </div>
  )
}
