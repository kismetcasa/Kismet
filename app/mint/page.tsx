import { MintTabs } from '@/components/MintTabs'
import { SITE_URL } from '@/lib/siteUrl'

export const metadata = {
  title: 'mint — Kismet',
  description: 'mint artworks and create collections on Kismet',
  // Prefill links (?collection=&name=&tab=) are all the same page — collapse
  // every variant onto one indexable URL.
  alternates: { canonical: `${SITE_URL}/mint` },
}

interface Props {
  searchParams: Promise<{ collection?: string; name?: string; tab?: string }>
}

export default async function MintPage({ searchParams }: Props) {
  const { collection, name, tab } = await searchParams
  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      <MintTabs
        initialCollection={collection}
        initialCollectionName={name}
        initialTab={tab}
      />
    </div>
  )
}
