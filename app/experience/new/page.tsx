import Link from 'next/link'
import type { Metadata } from 'next'
import { SITE_URL } from '@/lib/siteUrl'
import { CapsuleStudio } from '@/components/CapsuleStudio'
import { RevealStudio } from '@/components/RevealStudio'

export const metadata: Metadata = {
  title: 'machine studio — Kismet',
  description:
    'Open a machine: a capsule machine of your own work at one price, or a reveal machine curated from any artist, collected at each piece’s price.',
  alternates: { canonical: `${SITE_URL}/experience/new` },
}

export const dynamic = 'force-dynamic'

const KINDS = [
  {
    kind: 'capsule',
    title: 'capsule machine',
    body: 'Your own work at one price. Players pay your capsule price once and get one of your pieces. You set the rarity.',
  },
  {
    kind: 'reveal',
    title: 'reveal machine',
    body: 'Any artist’s work. Players pull for free, see one piece, and collect it at its own price. Every piece on sale is equally likely.',
  },
] as const

export default async function StudioPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind } = await searchParams
  if (kind === 'capsule') return <div className="px-4 py-8"><CapsuleStudio /></div>
  if (kind === 'reveal') return <div className="px-4 py-8"><RevealStudio /></div>
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">open a machine</h1>
        <p className="text-[11px] font-mono text-muted mt-1">two kinds — pick the one that fits what you&apos;re putting in</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        {KINDS.map((k) => (
          <Link
            key={k.kind}
            href={`/experience/new?kind=${k.kind}`}
            className="border border-line p-5 hover:bg-raised transition-colors"
          >
            <p className="text-xs font-mono uppercase tracking-widest text-ink">{k.title}</p>
            <p className="text-[11px] font-mono text-muted mt-2 leading-relaxed">{k.body}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
