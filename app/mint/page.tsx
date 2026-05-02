import { MintTabs } from '@/components/MintTabs'

export const metadata = {
  title: 'mint — Kismet Art',
  description: 'mint moments and create collections on Kismet Art',
}

interface Props {
  searchParams: Promise<{ collection?: string; name?: string }>
}

export default async function MintPage({ searchParams }: Props) {
  const { collection, name } = await searchParams
  return (
    <div className="max-w-lg mx-auto px-4 py-12">
      <MintTabs initialCollection={collection} initialCollectionName={name} />
    </div>
  )
}
