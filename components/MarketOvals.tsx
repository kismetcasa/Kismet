'use client'

import { memo, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import Link from 'next/link'
import { Star } from 'lucide-react'
import { useAccount, useReadContract } from 'wagmi'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useMomentSale } from '@/hooks/useMomentSale'
import { useInViewDwell } from '@/hooks/useInViewDwell'
import { useWatchlist } from '@/hooks/useWatchlist'
import { trackFunnel } from '@/lib/funnel'
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
  corner,
  rootRef,
}: {
  href: string
  title: string
  /** Right-aligned aside on the title line (e.g. the sale close date). */
  titleRight?: ReactNode
  subtitle: ReactNode
  artwork: ReactNode
  action: ReactNode
  /** Floating control on the oval's top edge (the watchlist star). */
  corner?: ReactNode
  rootRef?: Ref<HTMLElement>
}) {
  return (
    <article ref={rootRef} className={OVAL_CLASS}>
      {/* Stretched link — one crawlable /moment anchor covering the whole
          oval. data-oval-nav is the j/k keyboard-navigation hook; the ring
          renders only for keyboard focus (focus-visible), never on click. */}
      <Link
        href={href}
        prefetch={false}
        aria-label={title}
        data-oval-nav
        className="absolute inset-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-[#0d0d0d]"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3">
        {artwork}
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex min-w-0 items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate font-mono text-[13px] text-ink">{title}</p>
            {titleRight && <span className="shrink-0 font-mono text-[10px] text-dim">{titleRight}</span>}
          </div>
          {/* flex (not a truncating <p>) so a caller can pair a truncating
              primary with a shrink-0 aside — e.g. the mint oval's supply line
              that yields space to a fixed listing link. */}
          <div className="flex min-w-0 items-center gap-1 font-mono text-[10.5px] text-muted">{subtitle}</div>
        </div>
      </div>
      {/* pointer-events-none so the price + gaps fall through to the stretched
          link (the whole oval navigates); the actionable button inside
          re-enables pointer-events to win its own click. z-10 keeps it painted
          above the link. A disabled button stays pass-through → still navigates. */}
      <div className="pointer-events-none relative z-10 flex shrink-0 flex-col items-end gap-1">{action}</div>
      {/* -top-2: the star's arc must clear the price's cap height in the
          two-line action cluster (audited ~2px kiss at -top-1.5). */}
      {corner && <div className="absolute -top-2 right-4 z-10">{corner}</div>}
    </article>
  )
}

// Watchlist star — floats on the oval's top edge. Starred is always-on accent
// (it's signal). Unstarred splits by pointer capability, not breakpoint:
// hover-capable devices rest invisible (a wall of faint stars read as visual
// debris) and reveal on oval hover or keyboard focus — hovering any part of
// the star itself also fires group-hover, since :hover propagates to DOM
// ancestors, so a mouse can never click it unseen. Touch devices (phones AND
// ipads, which sit above the sm breakpoint) keep the resting opacity as their
// only affordance.
function WatchStar({ watched, name, onToggle }: { watched: boolean; name: string; onToggle: () => void }) {
  return (
    <button
      aria-pressed={watched}
      aria-label={watched ? `Remove ${name} from watchlist` : `Add ${name} to watchlist`}
      onClick={onToggle}
      className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border bg-[#141414] transition-opacity ${
        watched
          ? 'border-accent text-accent opacity-100'
          : 'border-line text-subtle [@media(hover:none)]:opacity-60 [@media(hover:hover)]:opacity-0 hover:text-dim group-hover:opacity-100 focus-visible:opacity-100'
      }`}
    >
      <Star size={11} strokeWidth={1.5} className={watched ? 'fill-accent' : ''} />
    </button>
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
// `resaleCount` is the cross-market bridge: how many live secondary listings
// this moment has (from the page's one /api/listings?keys=1 read).
function MomentOvalImpl({
  moment,
  ethUsd,
  resaleCount,
}: {
  moment: Moment
  ethUsd?: number | null
  resaleCount?: number
}) {
  const rootRef = useRef<HTMLElement>(null)
  const inView = useInViewDwell(rootRef, { rootMargin: '200px', dwellMs: 150 })
  const { address: connectedAddress } = useAccount()
  const ensureConnected = useEnsureConnected()
  const { collect, status } = useDirectCollect()
  const collecting = status !== 'idle' && status !== 'done' && status !== 'error'
  const [collected, setCollected] = useState(false)
  const { has: isWatched, toggle: toggleWatch } = useWatchlist()

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
  const uncapped = maxSupply !== undefined && isOpenEdition(maxSupply)
  // Sold-out supersedes the clock: the close date is an urgency cue for a live
  // collect action, and on a mint with nothing left it reads as "you have
  // until X" — a dead promise. Cards drop it; the artwork page keeps the full
  // window for provenance (MomentDetailView's SaleWindow is ungated).
  const windowLabel = !mintedOut ? formatSaleWindowLabel(saleWindow, { withTime: false }) : null
  // Uncapped editions carry the dated window INSIDE the supply line (it
  // replaced the redundant "timed edition" tag), so the titleRight chip only
  // serves capped rows — one dated edge per oval, never both.
  const closeLabel = !uncapped && saleWindow?.state === 'closing' ? windowLabel : null
  const disabled = collecting || mintedOut || saleNotStarted || saleEnded
  const label = collecting
    ? 'collecting…'
    : mintedOut
      ? 'sold out'
      : saleNotStarted
        ? 'not started'
        : saleEnded
          ? 'sale ended'
          : hasCollected
            ? 'collect+'
            : 'collect'

  // Supply line: "sold" framing — "3/100 sold" for limited editions. An
  // uncapped edition leads with its dated sale window when one exists
  // ("sale ends Jul 31" / "opens Aug 1" / "ended Jun 25" — supply is set by
  // the clock, and the words "timed edition" were redundant next to a visible
  // date); only a truly unbounded one reads "open edition". Until the sale
  // config resolves (same dwell fetch as the price) an uncapped edition reads
  // "open edition" and upgrades in place — same progressive fill as the price
  // slot. Lowercased to sit in the subtitle's register ("sale ends Jul 31",
  // not "Sale ends Jul 31").
  const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1)
  const supplyLabel =
    maxSupply === undefined
      ? '…'
      : uncapped
        ? `${windowLabel ? lcFirst(windowLabel) : 'open edition'} · ${(totalMinted ?? 0n).toLocaleString()} sold`
        : `${(totalMinted ?? 0n).toLocaleString()}/${maxSupply.toLocaleString()} sold`

  async function handleCollect() {
    // Discover-scoped collect intent (the global collect_attempt fires inside
    // useDirectCollect) — the numerator of the discover→collect conversion.
    trackFunnel('discover_collect_attempt')
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
          {/* Supply is the line's whole job — truncate IT, never the listing
              link beside it. Long collection names were eating the supply
              figure on real rows; collection context lives one click away on
              the moment page. */}
          <span className="min-w-0 truncate">{supplyLabel}</span>
          {/* Cross-market bridge: this mint has live secondary listings. There
              are no per-listing pages yet, so the arrow links to the market
              (the floor listing is the future target). Rendered as just the ↗ —
              not "N listings ↗" — so it can never crowd the supply figure; the
              count rides in the title/aria-label. pointer-events-auto + z-10
              wins the click over the oval's stretched link, like the action
              button does. */}
          {!!resaleCount && (
            <Link
              href="/market"
              prefetch={false}
              title={`${resaleCount} listing${resaleCount > 1 ? 's' : ''} on the market`}
              aria-label={`${resaleCount} listing${resaleCount > 1 ? 's' : ''} — view on the market`}
              className="pointer-events-auto relative z-10 shrink-0 text-dim transition-colors hover:text-accent"
            >
              ↗
            </Link>
          )}
        </>
      }
      artwork={<OvalArt src={stillSrc} alt={meta.name ?? 'artwork'} thumbhash={meta.kismet_thumbhash} />}
      corner={
        <WatchStar
          watched={isWatched(moment.address, moment.token_id)}
          name={meta.name ?? 'artwork'}
          onToggle={() =>
            toggleWatch({
              address: moment.address,
              tokenId: moment.token_id,
              name: meta.name,
              image: stillSrc,
              creator: moment.creator?.address,
              createdAt: moment.created_at,
            })
          }
        />
      }
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
                ? 'border-line/60 text-subtle'
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

// ── Secondary market oval (a listing) ────────────────────────────────────────
// Reuses BuyButton wholesale (the Seaport fulfill flow), so the action carries
// its own price ("buy 0.01 ETH"). onRemove drops the oval from the grid once
// the sale confirms (PaginatedGrid's optimistic remove). The subtitle names the
// seller ("listed by …") — no collection segment, same doctrine as the primary
// ovals. Royalty share is dropped from the row: it's the same on every listing
// (creator royalties are always enforced on Kismet), so per-row it was noise.
function ListingOvalImpl({ listing, onRemove }: { listing: Listing; onRemove?: () => void }) {
  const rootRef = useRef<HTMLElement>(null)
  const inView = useInViewDwell(rootRef, { rootMargin: '200px', dwellMs: 150 })
  const { has: isWatched, toggle: toggleWatch } = useWatchlist()

  // Below-mint deal signal — the listing price vs the moment's live mint
  // price, via the same dwell-gated coalesced batch the primary ovals use.
  // Same-currency comparisons only: a wei-vs-USDC compare is meaningless, so
  // cross-currency pairs simply never show the badge (fail-closed).
  const { data: mintSale } = useMomentSale(listing.collectionAddress, listing.tokenId, inView)
  const belowMint = useMemo(() => {
    if (!mintSale) return false
    try {
      // Only against a mint you could actually pay instead: an ended or
      // not-yet-open sale's price isn't obtainable, so "below mint" against
      // it would flatter the listing with a dead comparison.
      const windowState = getSaleWindow(mintSale)?.state
      if (windowState === 'ended' || windowState === 'scheduled') return false
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

  return (
    <OvalShell
      rootRef={rootRef}
      href={`/moment/${listing.collectionAddress}/${listing.tokenId}`}
      title={listing.name || `#${listing.tokenId}`}
      titleRight={expiresLabel || undefined}
      subtitle={<span className="min-w-0 truncate">listed by {shortAddress(listing.seller)}</span>}
      artwork={<OvalArt src={listing.image} alt={listing.name ?? 'artwork'} />}
      corner={
        <WatchStar
          watched={isWatched(listing.collectionAddress, listing.tokenId)}
          name={listing.name ?? 'artwork'}
          onToggle={() =>
            toggleWatch({
              address: listing.collectionAddress,
              tokenId: listing.tokenId,
              name: listing.name,
              image: listing.image,
              creator: listing.creatorAddress,
            })
          }
        />
      }
      // pointer-events-auto: the cluster is pointer-events-none (so the rest of
      // the oval navigates), so the buy button must opt back in to be clickable.
      action={
        <>
          {belowMint && (
            <span className="font-mono text-[10px] text-[#4ade80]" title="listed below its live mint price">
              ↓ below mint
            </span>
          )}
          {/* rounded-full: a sharp rectangle looked out of place inside the
              rounded oval — matches the mint oval's stadium collect button. */}
          <BuyButton listing={listing} compact className="pointer-events-auto rounded-full" onBought={onRemove} />
        </>
      }
    />
  )
}
export const ListingOval = memo(ListingOvalImpl)
