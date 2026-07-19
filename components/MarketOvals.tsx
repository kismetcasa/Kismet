'use client'

import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import Link from 'next/link'
import { useAccount, useReadContract } from 'wagmi'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useMomentSale } from '@/hooks/useMomentSale'
import { useInViewDwell } from '@/hooks/useInViewDwell'
import { fetchCollectionChip } from '@/lib/collectionCache'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '@/lib/zoraMint'
import {
  formatPrice,
  inferCollectCurrency,
  shortAddress,
  getSaleWindow,
  formatSaleWindowLabel,
  DEFAULT_COLLECT_COMMENT,
  type Moment,
} from '@/lib/inprocess'
import type { Listing } from '@/lib/listings'
import { MomentImage } from './MomentImage'
import { BuyButton } from './BuyButton'

// ── Shared oval shell ────────────────────────────────────────────────────────
// A horizontal "rounded oval" (stadium) card: artwork · title · subtitle on the
// left, a price/action cluster on the right. The whole oval is one crawlable
// link to the moment (a stretched <Link> covering the card), while the
// collect/buy button floats above it (pointer-events + z) so it stays its own
// click target. The left content is pointer-events-none so a tap anywhere on it
// falls through to the link.
const OVAL_CLASS =
  'group relative flex items-center gap-3 h-16 pl-2.5 pr-3 rounded-full border border-line bg-[#151515] hover:border-accent/40 hover:bg-[#1b1616] transition-colors'

function OvalShell({
  href,
  title,
  titleRight,
  subtitle,
  artwork,
  action,
  rootRef,
}: {
  href: string
  title: string
  /** Right-aligned aside on the title line (e.g. the sale close date). */
  titleRight?: ReactNode
  subtitle: ReactNode
  artwork: ReactNode
  action: ReactNode
  rootRef?: Ref<HTMLElement>
}) {
  return (
    <article ref={rootRef} className={OVAL_CLASS}>
      {/* Stretched link — one crawlable /moment anchor covering the whole oval. */}
      <Link href={href} prefetch={false} aria-label={title} className="absolute inset-0 rounded-full" />
      <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3">
        {artwork}
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{title}</p>
            {titleRight && <span className="shrink-0 font-mono text-[10px] text-dim">{titleRight}</span>}
          </div>
          <p className="truncate font-mono text-[10.5px] text-muted">{subtitle}</p>
        </div>
      </div>
      {/* pointer-events-none so the price + gaps fall through to the stretched
          link (the whole oval navigates); the actionable button inside
          re-enables pointer-events to win its own click. z-10 keeps it painted
          above the link. A disabled button stays pass-through → still navigates. */}
      <div className="pointer-events-none relative z-10 flex shrink-0 flex-col items-end gap-1">{action}</div>
    </article>
  )
}

// Artwork thumbnail. object-contain renders the FULL artwork (never a
// pfp-style circle crop) — letterboxed in a rounded square against the page bg
// for non-square pieces. Falls back to the thumbhash blur, then a flat tile.
//
// STATIC COVER (bloat): we never pass the gif mime, so MomentImage routes the
// source through the optimizer, which flattens an animated gif to its first
// frame; video callers pass the poster still. Either way an oval wall renders
// zero animated decoders — the page stays light no matter how many are minted
// as gif/video.
function OvalArt({
  src,
  alt,
  thumbhash,
}: {
  src?: string
  alt: string
  thumbhash?: string
}) {
  const blur = useMemo(
    () => (!src && thumbhash ? thumbhashToBlurDataURL(thumbhash) : undefined),
    [src, thumbhash],
  )
  return (
    <div className="relative h-11 w-11 shrink-0 overflow-hidden rounded-lg bg-[#0d0d0d]">
      {src ? (
        <MomentImage src={src} alt={alt} fill className="object-contain" sizes="44px" thumbhash={thumbhash} />
      ) : blur ? (
        <span aria-hidden className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${blur})` }} />
      ) : (
        <span aria-hidden className="absolute inset-0 bg-raised" />
      )}
    </div>
  )
}

// Display window for the listing-expiry aside. Mirrors the server's
// "expiring soon" filter window (EXPIRING_SOON_MS in app/api/listings/route.ts)
// so the chip and the filter agree on what "soon" means.
const EXPIRES_SOON_MS = 48 * 60 * 60 * 1000

// ── Primary market oval (a mint) ─────────────────────────────────────────────
// Mirrors MomentCard's collect data-path (dwell-gated price + on-chain
// supply/ownership reads, on-chain-authoritative collect) in the oval layout.
// The price/supply/RPC reads all gate on an in-view dwell so a fast scroll
// past never fires them — same lever the feed uses.
// `ethUsd` (Chainlink rate from the page's one platform-stats read) powers a
// hover-only USD approximation on ETH prices — a tooltip, never a sub-label,
// so the price column can't layout-shift when the rate arrives.
function MomentOvalImpl({ moment, ethUsd }: { moment: Moment; ethUsd?: number | null }) {
  const rootRef = useRef<HTMLElement>(null)
  const inView = useInViewDwell(rootRef, { rootMargin: '200px', dwellMs: 150 })
  const { address: connectedAddress } = useAccount()
  const ensureConnected = useEnsureConnected()
  const { collect, status } = useDirectCollect()
  const collecting = status !== 'idle' && status !== 'done' && status !== 'error'
  const [collected, setCollected] = useState(false)

  const meta = useMemo(() => moment.metadata ?? {}, [moment.metadata])
  const media = useMemo(() => resolveMomentMedia(meta), [meta])
  // Static cover: video → poster; gif → poster if present, else the gif itself
  // (the optimizer flattens it to a still — see OvalArt); image → the still.
  const stillSrc =
    media.kind === 'video'
      ? media.poster
      : media.kind === 'gif'
        ? media.poster ?? media.src
        : media.kind === 'image'
          ? media.src
          : undefined

  // Collection name — seed from the server-stitched chip, else resolve client-side.
  const [collectionName, setCollectionName] = useState<string | null>(() => moment.kismetCollection?.name ?? null)
  useEffect(() => {
    if (moment.kismetCollection !== undefined) return
    fetchCollectionChip(moment.address).then(({ name }) => setCollectionName(name)).catch(() => {})
  }, [moment.address, moment.kismetCollection])

  // Display price (dwell-gated batch fetch). Collect re-reads the authoritative
  // price on-chain at click time, so the button never depends on this resolving.
  const { data: saleData } = useMomentSale(moment.address, moment.token_id, inView && !moment.saleConfig)
  const activeSale = moment.saleConfig ?? saleData ?? null
  const price = useMemo(() => {
    if (!activeSale) return null
    try {
      return formatPrice(activeSale.pricePerToken, inferCollectCurrency(activeSale))
    } catch {
      return null
    }
  }, [activeSale])
  const usdTitle = useMemo(() => {
    if (!activeSale || !ethUsd) return undefined
    try {
      if (inferCollectCurrency(activeSale) !== 'eth') return undefined
      const wei = BigInt(activeSale.pricePerToken)
      if (wei <= 0n) return undefined
      const usd = (Number(wei) / 1e18) * ethUsd
      return `≈ $${usd < 1 ? usd.toFixed(2) : usd.toLocaleString('en-US', { maximumFractionDigits: 2 })} at today's ETH price`
    } catch {
      return undefined
    }
  }, [activeSale, ethUsd])

  // On-chain supply + ownership (gated on dwell). maxSupply/totalMinted arrive
  // together from getTokenInfo, so either both are defined or neither is.
  const { data: tokenInfo, refetch: refetchTokenInfo } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ZORA_1155_TOKEN_INFO_ABI,
    functionName: 'getTokenInfo',
    args: [BigInt(moment.token_id)],
    query: { enabled: inView, staleTime: 30_000 },
  })
  const maxSupply = tokenInfo?.maxSupply
  const totalMinted = tokenInfo?.totalMinted
  const { data: ownedBalance, refetch: refetchOwned } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(moment.token_id)] : undefined,
    query: { enabled: inView && !!connectedAddress, staleTime: 30_000 },
  })
  const owned = ownedBalance ? Number(ownedBalance) : 0
  const hasCollected = collected || owned > 0

  // Sold-out: same check as MomentCard — both on-chain reads must land before
  // flagging, so it never flashes "sold out" before tokenInfo resolves.
  const mintedOut =
    maxSupply !== undefined && totalMinted !== undefined && !isOpenEdition(maxSupply) && totalMinted >= maxSupply
  // Sale-window state via the canonical classifier. Result-equivalent to
  // MomentCard's raw saleStart/saleEnd compares for the disable gate (verified:
  // both read the max-uint64 "no end" sentinel as open-ended); used here because
  // it ALSO yields the 'closing' state that drives the close-date label. This
  // derivation is deliberately NOT shared with MomentCard — a shared hook would
  // edit the feed's hottest component; isolation over DRY for a no-regression feature.
  const nowSec = Math.floor(Date.now() / 1000)
  const saleWindow = getSaleWindow(activeSale, nowSec)
  const saleNotStarted = saleWindow?.state === 'scheduled'
  const saleEnded = saleWindow?.state === 'ended'
  const closeLabel =
    saleWindow?.state === 'closing' ? formatSaleWindowLabel(saleWindow, { withTime: false }) : null
  const disabled = collecting || mintedOut || saleNotStarted || saleEnded
  const label = collecting
    ? 'collecting…'
    : saleNotStarted
      ? 'not started'
      : saleEnded
        ? 'mint ended'
        : mintedOut
          ? 'sold out'
          : hasCollected
            ? 'collect+'
            : 'collect'

  // Supply line: "sold" framing — "3/100 sold" for limited editions,
  // "open edition · N sold" for open ones.
  const supplyLabel =
    maxSupply === undefined
      ? '…'
      : isOpenEdition(maxSupply)
        ? `open edition · ${(totalMinted ?? 0n).toLocaleString()} sold`
        : `${(totalMinted ?? 0n).toLocaleString()}/${maxSupply.toLocaleString()} sold`

  async function handleCollect() {
    const account = await ensureConnected()
    if (!account) return
    const result = await collect({
      collectionAddress: moment.address as `0x${string}`,
      tokenId: moment.token_id,
      amount: 1,
      comment: DEFAULT_COLLECT_COMMENT,
      share: { momentName: meta.name ?? null, creatorAddress: moment.creator?.address ?? null },
    })
    if (result) {
      setCollected(true)
      refetchOwned().catch(() => {})
      refetchTokenInfo().catch(() => {})
    }
  }

  return (
    <OvalShell
      rootRef={rootRef}
      href={`/moment/${moment.address}/${moment.token_id}`}
      title={meta.name || `#${moment.token_id}`}
      // Sale close date to the right of the title (only for a real upcoming
      // deadline — see closeLabel).
      titleRight={closeLabel || undefined}
      subtitle={
        <>
          {collectionName && <span className="text-dim">{collectionName}</span>}
          {collectionName && ' · '}
          {supplyLabel}
        </>
      }
      artwork={<OvalArt src={stillSrc} alt={meta.name ?? 'artwork'} thumbhash={meta.kismet_thumbhash} />}
      action={
        <>
          <span title={usdTitle} className="font-mono text-[12px] accent-grad tabular-nums">{price ?? '…'}</span>
          <button
            onClick={handleCollect}
            disabled={disabled}
            aria-label={`${label} ${meta.name ?? 'artwork'}`}
            // Re-enable pointer events only when the button is an actionable
            // target; a disabled button inherits the cluster's none and lets the
            // click fall through to the oval's navigate link.
            className={`${disabled ? '' : 'pointer-events-auto'} rounded-full border px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors disabled:cursor-not-allowed ${
              mintedOut || saleEnded
                ? 'border-line/60 text-faint'
                : hasCollected
                  ? 'border-accent bg-accent/10 text-accent hover:bg-accent/20'
                  : 'border-line text-dim accent-grad-hover disabled:opacity-50'
            }`}
          >
            {label}
          </button>
        </>
      }
    />
  )
}
export const MomentOval = memo(MomentOvalImpl)

// ── Secondary market oval (a resale listing) ─────────────────────────────────
// Reuses BuyButton wholesale (the Seaport fulfill flow), so the action carries
// its own price ("buy 0.01 ETH"). onRemove drops the oval from the grid once
// the sale confirms (PaginatedGrid's optimistic remove). The subtitle is the
// trade trust line: collection · who's selling · the enforced royalty share.
function ListingOvalImpl({ listing, onRemove }: { listing: Listing; onRemove?: () => void }) {
  const rootRef = useRef<HTMLElement>(null)
  const inView = useInViewDwell(rootRef, { rootMargin: '200px', dwellMs: 150 })
  const [collectionName, setCollectionName] = useState<string | null>(null)
  useEffect(() => {
    fetchCollectionChip(listing.collectionAddress).then(({ name }) => setCollectionName(name)).catch(() => {})
  }, [listing.collectionAddress])

  // Below-mint deal signal — the listing price vs the moment's live mint
  // price, via the same dwell-gated coalesced batch the primary ovals use.
  // Same-currency comparisons only: a wei-vs-USDC compare is meaningless, so
  // cross-currency pairs simply never show the badge (fail-closed).
  const { data: mintSale } = useMomentSale(listing.collectionAddress, listing.tokenId, inView)
  const belowMint = useMemo(() => {
    if (!mintSale) return false
    try {
      if ((listing.currency ?? 'eth') !== inferCollectCurrency(mintSale)) return false
      const mint = BigInt(mintSale.pricePerToken)
      return mint > 0n && BigInt(listing.price) < mint
    } catch {
      return false
    }
  }, [mintSale, listing.price, listing.currency])

  // Expiry aside — only inside the 48h urgency window, so it's never forced.
  const expiresLabel = useMemo(() => {
    const msLeft = listing.expiresAt - Date.now()
    if (msLeft <= 0 || msLeft > EXPIRES_SOON_MS) return null
    const hours = Math.ceil(msLeft / 3_600_000)
    return hours <= 24 ? `expires ${hours}h` : `expires ${Math.ceil(hours / 24)}d`
  }, [listing.expiresAt])

  // Royalty share of the sale price, from the stored display fields (never
  // settlement math). Hidden when unparseable or zero.
  const royaltyPct = useMemo(() => {
    try {
      const price = BigInt(listing.price)
      if (price <= 0n) return null
      const bps = Number((BigInt(listing.royaltyAmount) * 10000n) / price)
      if (bps <= 0) return null
      return bps % 100 === 0 ? String(bps / 100) : (bps / 100).toFixed(1)
    } catch {
      return null
    }
  }, [listing.price, listing.royaltyAmount])

  return (
    <OvalShell
      rootRef={rootRef}
      href={`/moment/${listing.collectionAddress}/${listing.tokenId}`}
      title={listing.name || `#${listing.tokenId}`}
      titleRight={expiresLabel || undefined}
      subtitle={
        <>
          {collectionName && (
            <>
              <span className="text-dim">{collectionName}</span>
              {' · '}
            </>
          )}
          resale by {shortAddress(listing.seller)}
          {royaltyPct && ` · ${royaltyPct}% royalty`}
        </>
      }
      artwork={<OvalArt src={listing.image} alt={listing.name ?? 'artwork'} />}
      // pointer-events-auto: the cluster is pointer-events-none (so the rest of
      // the oval navigates), so the buy button must opt back in to be clickable.
      action={
        <>
          {belowMint && (
            <span className="font-mono text-[10px] text-[#4ade80]" title="listed below its live mint price">
              ↓ below mint
            </span>
          )}
          <BuyButton listing={listing} compact className="pointer-events-auto" onBought={onRemove} />
        </>
      }
    />
  )
}
export const ListingOval = memo(ListingOvalImpl)
