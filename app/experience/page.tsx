import Link from 'next/link'
import type { Metadata } from 'next'
import { SITE_URL } from '@/lib/siteUrl'
import { buildFarcasterEmbed } from '@/lib/farcasterEmbed'
import { listMachines } from '@/lib/experience/store'
import { shortAddress } from '@/lib/inprocess'

// The Experience is a top-level destination, not a Discover sub-tab — the same
// call the codebase already made for /market ("keeps the discover page's
// horizontal tab strip from overflowing on mobile / Mini App"), and for the same
// reason: a machine needs room for its lineup, its odds table and its reveal.
export const metadata: Metadata = {
  title: 'experience — Kismet',
  description:
    'Play a capsule machine and receive an artwork from a Kismet artist. Published odds, every play returns a real artwork.',
  alternates: { canonical: `${SITE_URL}/experience` },
  other: buildFarcasterEmbed({
    imageUrl:
      process.env.NEXT_PUBLIC_FARCASTER_EMBED_IMAGE_URL ?? `${SITE_URL}/embed-default.png`,
    buttonTitle: 'Open a capsule',
    action: { url: `${SITE_URL}/experience` },
  }),
}

export const dynamic = 'force-dynamic'

export default async function ExperiencePage() {
  const machines = await listMachines(['live', 'ended']).catch(() => [])

  return (
    <div className="max-w-3xl mx-auto px-4 py-8">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-mono tracking-wider text-ink">experience</h1>
          <p className="text-[11px] font-mono text-muted mt-1">
            capsule machines · published odds · every play returns an artwork
          </p>
        </div>
        <Link
          href="/experience/new"
          className="shrink-0 px-4 py-2 text-[10px] font-mono uppercase tracking-wider border border-line text-dim hover:text-ink"
        >
          open a machine
        </Link>
      </header>

      {machines.length === 0 ? (
        <div className="border border-line p-8 sm:p-16 text-center">
          <p className="text-sm font-mono text-muted">no machines running yet</p>
          <p className="text-xs font-mono text-subtle mt-2">
            any Pass holder can open one in the{' '}
            <Link href="/experience/new" className="text-dim hover:text-ink underline">
              capsule studio
            </Link>
          </p>
        </div>
      ) : (
        <div className="border border-line divide-y divide-line">
          {machines.map((m) => (
            <Link
              key={m.id}
              href={`/experience/${m.id}`}
              className="flex items-center gap-3 px-4 py-3.5 hover:bg-raised transition-colors"
            >
              <span className="flex-1 min-w-0 text-sm font-mono text-ink truncate">{m.name}</span>
              <span className="text-[10px] font-mono text-subtle shrink-0">
                {shortAddress(m.creator)}
              </span>
              <span
                className={`text-[10px] font-mono uppercase tracking-wider shrink-0 ${
                  m.state === 'live' ? 'text-accent' : 'text-subtle'
                }`}
              >
                {m.state === 'live' ? 'live' : 'closed'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
