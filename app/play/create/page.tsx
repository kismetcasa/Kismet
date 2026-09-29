import Link from 'next/link'
import type { Metadata } from 'next'
import { SITE_URL } from '@/lib/siteUrl'

export const metadata: Metadata = {
  title: 'machine studio — Kismet',
  description:
    'Open a machine: a capsule machine of your own work at one price, or a reveal machine curated from any artist, collected at each piece’s price.',
  alternates: { canonical: `${SITE_URL}/play/create` },
}

const KINDS = [
  {
    href: '/play/create-capsule',
    title: 'capsule machine',
    body: 'Your own work at one price. Players pay your capsule price once and get one of your pieces. You set the rarity.',
  },
  {
    href: '/play/create-reveal',
    title: 'reveal machine',
    body: 'Any artist’s work. Players pull for free, see one piece, and collect it at its own price. Every piece on sale is equally likely.',
  },
] as const

export default function CreatePage() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-mono tracking-wider text-ink">open a machine</h1>
        <p className="text-[11px] font-mono text-muted mt-1">two kinds — pick the one that fits what you&apos;re putting in</p>
      </header>
      <div className="grid gap-3 sm:grid-cols-2">
        {KINDS.map((k) => (
          <Link key={k.href} href={k.href} className="border border-line p-5 hover:bg-raised transition-colors">
            <p className="text-xs font-mono uppercase tracking-widest text-ink">{k.title}</p>
            <p className="text-[11px] font-mono text-muted mt-2 leading-relaxed">{k.body}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
