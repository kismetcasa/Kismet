'use client'

import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { formatEther } from 'viem'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { useEthUsd } from '@/hooks/useEthUsd'
import { useSweep, type SweepRow, type SweepStatus } from '@/hooks/useSweep'
import { MomentImage } from './MomentImage'
import { formatPrice, shortAddress } from '@/lib/inprocess'
import { SWEEP_DEFAULT_N, SWEEP_MAX_N } from '@/lib/sweepIndexCore'

// The sweep sheet (SWEEP_IMPLEMENTATION.md §1.2): the trust surface. Every
// artwork, its live price, and the exact ETH the wallet will be asked for are
// on screen before the prompt. Centered scrollable card in the
// PatronInfoModal pattern; dismisses on backdrop, Escape, or the X.

const SIZES: readonly number[] = [SWEEP_DEFAULT_N, SWEEP_MAX_N]

function buttonLabel(status: SweepStatus, basketCount: number, totalWei: bigint, n: number, unaffordable: number): string {
  switch (status) {
    case 'idle':
      return 'connect wallet'
    case 'loading':
      return 'loading…'
    case 'verifying':
      return 'verifying…'
    case 'minting':
      return 'confirm in wallet…'
    case 'confirming':
      return 'confirming…'
    case 'recording':
      return 'finalizing…'
    case 'done':
      return `sweep the next ${n}`
    case 'error':
      return 'retry'
    case 'empty':
      return unaffordable > 0 ? 'add ETH, then re-check' : 're-check'
    case 'ready':
      return basketCount === 0 ? 'nothing to sweep' : `sweep ${basketCount} for ${formatPrice(totalWei.toString(), 'eth')}`
    default:
      return 'sweep'
  }
}

function Row({
  row,
  locked,
  onRemove,
  onRestore,
}: {
  row: SweepRow
  /** Remove / undo are inert while a sweep is in flight and after it landed. */
  locked: boolean
  onRemove: () => void
  onRestore: () => void
}) {
  const it = row.item
  const name = it.name?.trim() || `#${it.tokenId}`
  const username = it.creatorProfile.username
  const artist = username || (it.creator ? shortAddress(it.creator) : 'unknown artist')
  const dimmed = row.state === 'dropped' || row.state === 'unaffordable' || row.state === 'removed' || row.state === 'pending'
  return (
    <li className={`flex items-center gap-3 ${dimmed ? 'opacity-50' : ''}`}>
      <div className="relative h-10 w-10 shrink-0 overflow-hidden bg-raised">
        {it.image ? (
          <MomentImage src={it.image} alt={name} fill className="object-cover" sizes="40px" thumbhash={it.thumbhash} />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-ink">{name}</div>
        {/* Usernames are set in the feeds' uppercase style; an address fallback keeps its case ("0x…", not "0X…"). */}
        <div className={`truncate font-mono text-[10px] tracking-wider text-muted ${username ? 'uppercase' : ''}`}>{artist}</div>
      </div>
      {/* Capped at half the row so a long reason ("sold out, ended, or already
          yours") wraps instead of squeezing the name column to nothing. */}
      <div className="max-w-[48%] shrink-0 text-right font-mono text-xs leading-tight tabular-nums text-dim">
        {row.state === 'pending' ? (
          <span className="text-muted">verifying…</span>
        ) : row.state === 'dropped' || row.state === 'unaffordable' ? (
          <span className="text-muted">{row.reason}</span>
        ) : row.state === 'swept' ? (
          <span className="text-accent">swept</span>
        ) : (
          <>
            {formatPrice(row.priceWei.toString(), 'eth')}
            <span className="text-muted"> + fee</span>
          </>
        )}
      </div>
      {row.state === 'basket' && (
        <button
          type="button"
          onClick={onRemove}
          disabled={locked}
          aria-label={`Remove ${name}`}
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-muted transition-colors hover:text-ink disabled:opacity-60"
        >
          <X size={14} />
        </button>
      )}
      {row.state === 'removed' && (
        <button
          type="button"
          onClick={onRestore}
          disabled={locked}
          className="min-h-[44px] shrink-0 px-2 font-mono text-[10px] uppercase tracking-wider text-accent disabled:opacity-60"
        >
          undo
        </button>
      )}
    </li>
  )
}

export function SweepSheet({ onClose, initialN = SWEEP_DEFAULT_N }: { onClose: () => void; initialN?: number }) {
  const { status: hookStatus, rows, n, totalWei, unaffordable, result, open, remove, restore, confirm } = useSweep()
  const ethUsd = useEthUsd()
  const dialogRef = useRef<HTMLDivElement>(null)
  useBodyScrollLock()
  useEscapeKey(onClose)
  useFocusTrap(dialogRef, true)

  // Open once on mount. `open` is re-created when wallet state changes; the
  // ref keeps this effect from re-running (and re-fetching) on those renders.
  const openRef = useRef(open)
  openRef.current = open
  const startedRef = useRef(false)
  useEffect(() => {
    startedRef.current = true
    void openRef.current(initialN)
  }, [initialN])
  // Until the mount effect has called open() the hook still reads `idle`
  // (the sheet arrives through a lazy chunk, so that render is painted).
  // Show it as loading, so a connected user never sees a one-frame
  // "connect wallet". After a declined connect, `idle` is the real state.
  const status: SweepStatus = hookStatus === 'idle' && !startedRef.current ? 'loading' : hookStatus

  const busy =
    status === 'loading' ||
    status === 'verifying' ||
    status === 'minting' ||
    status === 'confirming' ||
    status === 'recording'
  const rowsLocked = busy || status === 'done'
  const basketCount = rows.filter((r) => r.state === 'basket').length
  const visibleRows = rows.filter((r) => r.state !== 'reserve')
  const usd = ethUsd != null && totalWei > 0n ? ` ≈ $${(Number(formatEther(totalWei)) * ethUsd).toFixed(2)}` : ''
  const label = buttonLabel(status, basketCount, totalWei, n, unaffordable)
  const primaryDisabled = busy || (status === 'ready' && basketCount === 0)

  function onPrimary() {
    if (status === 'ready') void confirm()
    // Every other settled state re-opens: a retry after a revert must
    // re-verify, and "re-check" after adding ETH is the same path.
    else if (!busy) void open(n)
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Sweep the floor"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/80 p-4 sm:items-center"
      onClick={onClose}
    >
      <div
        className="my-auto flex w-full max-w-md flex-col border border-line bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 p-5 pb-3 sm:p-6 sm:pb-3">
          <div>
            <h2 className="font-mono text-sm uppercase tracking-widest text-ink">sweep the floor</h2>
            <p className="mt-1 font-mono text-xs text-muted">Kismet patrons always bring a broom</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-full border border-line p-0.5" role="group" aria-label="Basket size">
              {SIZES.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-pressed={n === size}
                  disabled={busy}
                  onClick={() => {
                    if (size !== n) void open(size)
                  }}
                  className={`rounded-full px-2.5 py-1 font-mono text-[11px] tabular-nums transition-colors disabled:opacity-60 ${
                    n === size ? 'bg-accent font-semibold text-surface' : 'text-muted hover:text-dim'
                  }`}
                >
                  {size}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="flex min-h-[44px] min-w-[44px] items-center justify-center text-muted transition-colors hover:text-ink"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="max-h-[50vh] overflow-y-auto px-5 sm:px-6">
          {visibleRows.length === 0 ? (
            <p className="py-6 text-center font-mono text-xs text-muted">
              {status === 'loading'
                ? 'loading the pool…'
                : status === 'idle'
                  ? 'connect a wallet to sweep'
                  : status === 'error'
                    ? 'something went wrong'
                    : 'nothing to sweep right now'}
            </p>
          ) : (
            <ul className="flex flex-col gap-2 py-2">
              {visibleRows.map((row) => (
                <Row key={row.key} row={row} locked={rowsLocked} onRemove={() => remove(row.key)} onRestore={() => restore(row.key)} />
              ))}
            </ul>
          )}
        </div>

        <div className="border-t border-line p-5 pt-3 sm:p-6 sm:pt-3">
          <div aria-live="polite" className="mb-3 font-mono text-xs tabular-nums text-dim">
            {status === 'done' && result ? (
              <>
                swept {result.minted} artwork{result.minted === 1 ? '' : 's'} ·{' '}
                <a
                  href={`https://basescan.org/tx/${result.hash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="accent-grad-text-hover underline"
                >
                  view on basescan
                </a>
              </>
            ) : (
              <>
                {basketCount} artwork{basketCount === 1 ? '' : 's'}
                {totalWei > 0n ? ` · ${formatPrice(totalWei.toString(), 'eth')}${usd}` : ''}
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onPrimary}
            disabled={primaryDisabled}
            className="w-full border border-accent/40 py-2.5 font-mono text-xs uppercase tracking-widest text-accent transition-colors hover:border-accent hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60"
          >
            {label}
          </button>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-wider text-muted">
            one edition each
            {unaffordable > 0 ? ` · ${unaffordable} more need more ETH` : ''}
          </p>
        </div>
      </div>
    </div>
  )
}
