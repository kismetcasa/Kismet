import Link from 'next/link'
import type { Metadata } from 'next'
import { SITE_URL } from '@/lib/siteUrl'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { listMachines } from '@/lib/experience/store'
import { machineCards } from '@/lib/experience/cards'
import { MachineCards } from '@/components/MachineCards'

// Every machine: people find the live ones in the Discover "play" tab; this
// list — reached from the studio, the sitemap and shared links — also keeps
// the closed ones. The old /experience list redirects here (next.config.mjs).
export const metadata: Metadata = {
  title: 'play — Kismet',
  description:
    'Play a capsule machine or pull a reveal machine and collect an artwork from a Kismet artist. Published odds, every play returns a real artwork.',
  alternates: { canonical: `${SITE_URL}/play` },
  other: buildFarcasterEmbed({
    imageUrl:
      process.env.NEXT_PUBLIC_FARCASTER_EMBED_IMAGE_URL ?? `${SITE_URL}/embed-default.png`,
    buttonTitle: 'Open a capsule',
    action: { url: `${SITE_URL}/play` },
  }),
}

export const dynamic = 'force-dynamic'

export default async function PlayPage() {
  const machines = await listMachines(['live', 'ended']).catch(() => [])

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-mono tracking-wider text-ink">play</h1>
          <p className="text-[11px] font-mono text-muted mt-1">
            capsule machines and reveal machines · published odds
          </p>
        </div>
        <Link
          href="/play/create"
          className="shrink-0 px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink"
        >
          build gachapon
        </Link>
      </header>

      {machines.length === 0 ? (
        <div className="border border-line p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-muted">no machines running yet</p>
          <p className="text-xs font-mono text-subtle mt-2">
            any Pass holder can{' '}
            <Link href="/play/create" className="text-dim hover:text-ink underline">
              build one
            </Link>
          </p>
        </div>
      ) : (
        <MachineCards machines={await machineCards(machines)} />
      )}
    </div>
  )
}
