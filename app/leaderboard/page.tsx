import type { Metadata } from 'next'
import Link from 'next/link'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import { shortAddress } from '@/lib/inprocess'
import { getLeaderboard, type EarningsMetric } from '@/lib/stats'

// Always reflect current Redis state — the board changes on every collect.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Top artists · Kismet',
  description: 'Top artists on Kismet by primary sales.',
}

const TABS: { id: EarningsMetric; label: string }[] = [
  { id: 'eth', label: 'ETH earned' },
  { id: 'usdc', label: 'USDC earned' },
  { id: 'sold', label: 'Artworks sold' },
]

const fmtCount = (n: number) => Math.round(n).toLocaleString('en-US')
const fmtEth = (n: number) =>
  n ? n.toLocaleString('en-US', { maximumFractionDigits: 4 }) : '0'
const fmtUsdc = (n: number) =>
  n ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '0'

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ metric?: string }>
}) {
  const { metric: m } = await searchParams
  const metric: EarningsMetric = m === 'sold' || m === 'usdc' || m === 'eth' ? m : 'eth'
  const artists = await getLeaderboard(metric, 50)

  const activeLabel = TABS.find((t) => t.id === metric)?.label.toLowerCase() ?? 'earnings'

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 font-mono">
      <header className="mb-5">
        <h1 className="text-xl text-ink">Top artists</h1>
        <p className="mt-1 text-xs text-dim">Ranked by {activeLabel}. Primary sales only.</p>
      </header>

      <nav className="mb-2 flex gap-4 text-xs">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/leaderboard?metric=${t.id}`}
            className={t.id === metric ? 'text-ink' : 'text-dim hover:text-ink transition-colors'}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {artists.length === 0 ? (
        <p className="py-12 text-center text-sm text-dim">No sales recorded yet.</p>
      ) : (
        <ol>
          {artists.map((a, i) => {
            const primary =
              metric === 'sold'
                ? { value: fmtCount(a.sold), label: 'sold' }
                : metric === 'eth'
                  ? { value: `${fmtEth(a.earnedEth)} ETH`, label: 'earned' }
                  : { value: `$${fmtUsdc(a.earnedUsdc)}`, label: 'earned' }

            // Context line: the metrics NOT being ranked on (skip zeros).
            const rest: string[] = []
            if (metric !== 'sold') rest.push(`${fmtCount(a.sold)} sold`)
            if (metric !== 'eth' && a.earnedEth) rest.push(`${fmtEth(a.earnedEth)} ETH`)
            if (metric !== 'usdc' && a.earnedUsdc) rest.push(`$${fmtUsdc(a.earnedUsdc)}`)

            return (
              <li key={a.address}>
                <Link
                  href={`/profile/${a.address}`}
                  className="flex items-center gap-3 border-b border-line py-3 hover:bg-raised transition-colors"
                >
                  <span className="w-5 shrink-0 text-right text-xs text-muted tabular-nums">
                    {i + 1}
                  </span>
                  <ProfileAvatar address={a.address} avatarUrl={a.avatarUrl} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">
                      {a.username || shortAddress(a.address)}
                    </p>
                    {rest.length > 0 && (
                      <p className="truncate text-[11px] text-dim">{rest.join(' · ')}</p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end">
                    <span className="text-sm text-accent tabular-nums">{primary.value}</span>
                    <span className="text-[10px] uppercase tracking-wider text-muted">
                      {primary.label}
                    </span>
                  </div>
                </Link>
              </li>
            )
          })}
        </ol>
      )}
    </main>
  )
}
