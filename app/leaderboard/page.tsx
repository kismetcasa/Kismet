import type { Metadata } from 'next'
import Link from 'next/link'
import { ProfileAvatar } from '@/components/ProfileAvatar'
import { shortAddress } from '@/lib/inprocess'
import { getEarningsLeaderboard } from '@/lib/stats'
import { formatEarningsValue, type EarningsMetric } from '@/lib/earningsFormat'

// Always reflect current Redis state — the board changes on every sale, and the
// USD view tracks the live ETH price.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Top artists · Kismet',
  description: 'Top artists on Kismet by primary sales.',
}

const TABS: { id: EarningsMetric; label: string }[] = [
  { id: 'usd', label: 'USD' },
  { id: 'eth', label: 'ETH' },
  { id: 'usdc', label: 'USDC' },
]

export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ metric?: string }>
}) {
  const { metric: m } = await searchParams
  const metric: EarningsMetric = m === 'eth' || m === 'usdc' || m === 'usd' ? m : 'usd'
  const artists = await getEarningsLeaderboard(metric, 50)

  const rankedBy = metric === 'usd' ? 'USD value' : metric.toUpperCase()

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 font-mono">
      <header className="mb-5">
        <h1 className="text-xl text-ink">Top artists</h1>
        <p className="mt-1 text-xs text-dim">Ranked by {rankedBy} earned. Primary sales only.</p>
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
          {artists.map((a, i) => (
            <li key={a.address}>
              <Link
                href={`/profile/${a.address}`}
                className="flex items-center gap-3 border-b border-line py-3 hover:bg-raised transition-colors"
              >
                <span className="w-5 shrink-0 text-right text-xs text-muted tabular-nums">{i + 1}</span>
                <ProfileAvatar address={a.address} avatarUrl={a.avatarUrl} size={36} />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {a.username || shortAddress(a.address)}
                </span>
                <div className="flex shrink-0 flex-col items-end">
                  <span className="text-sm text-accent tabular-nums">
                    {formatEarningsValue(metric, a)}
                  </span>
                  <span className="text-[10px] uppercase tracking-wider text-muted tabular-nums">
                    {a.mints.toLocaleString('en-US')} {a.mints === 1 ? 'mint' : 'mints'}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </main>
  )
}
