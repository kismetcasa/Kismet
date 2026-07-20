'use client'

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { useReadContract } from 'wagmi'
import { DEFAULT_COLLECT_COMMENT, type Moment } from '@/lib/inprocess'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { thumbhashToBlurDataURL, thumbhashToRatio } from '@/lib/media/thumbhash'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '@/lib/zoraMint'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useMomentSale } from '@/hooks/useMomentSale'
import { MomentImage } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { MaybeLazy } from './LazyMount'
import { PATRON_PASS_DESCRIPTION } from '@/lib/patronCollection'

// Pre-load guess until the thumbhash (then the loaded image) reports the real
// shape — mirrors the Mint Pass Display so the box never letterboxes.
const DEFAULT_RATIO = 1.5
const MIN_RATIO = 0.2
const MAX_RATIO = 5
const clampRatio = (r: number) => Math.min(MAX_RATIO, Math.max(MIN_RATIO, r))
// Cap the artwork's rendered HEIGHT so portrait/tall pieces don't tower off the
// screen. Applied as a max-WIDTH of (cap × ratio): a wide/landscape piece's cap
// exceeds the column so it just fills the width (height stays well under the
// cap, unchanged from before); a portrait piece is capped at this height and
// centered. `min(80vh, …)` keeps it inside the viewport on any device; the px
// ceiling stops it dominating huge monitors.
const MAX_ART_HEIGHT = 'min(80vh, 760px)'

/**
 * One Patron artwork — the image alone (no frame, badges, price, or text),
 * given a large display. The box hugs the image's own aspect ratio (sized from
 * the thumbhash up front, corrected to the natural ratio on load) so there's no
 * crop and no letterbox; the height cap keeps portrait pieces from towering.
 * Clicking opens the moment, where the edition can be collected.
 */
function PatronArtwork({ moment, priority }: { moment: Moment; priority?: boolean }) {
  const [naturalRatio, setNaturalRatio] = useState<number | null>(null)
  const [mediaError, setMediaError] = useState(false)

  const meta = moment.metadata ?? {}
  const media = resolveMomentMedia(meta)
  const isVideo = media.kind === 'video'
  const blurPreview = useMemo(
    () => thumbhashToBlurDataURL(meta.kismet_thumbhash),
    [meta.kismet_thumbhash],
  )
  const thumbRatio = useMemo(
    () => thumbhashToRatio(meta.kismet_thumbhash),
    [meta.kismet_thumbhash],
  )
  const aspectRatio = clampRatio(naturalRatio ?? thumbRatio ?? DEFAULT_RATIO)
  const handleNaturalSize = useCallback((w: number, h: number) => {
    if (w > 0 && h > 0) setNaturalRatio(w / h)
  }, [])

  const title = meta.name ?? `#${moment.token_id}`
  const momentHref = `/artwork/${moment.address}/${moment.token_id}`

  return (
    // `mx-auto` centers a height-capped portrait in the column (its used width
    // < 100% via max-width); a full-width landscape is unaffected. Plain block
    // centering avoids the flex `align-items: stretch` vs aspect-ratio gotcha.
    <Link
      href={momentHref}
      className="relative block w-full mx-auto overflow-hidden"
      style={{ aspectRatio, maxWidth: `calc(${MAX_ART_HEIGHT} * ${aspectRatio})` }}
    >
      {isVideo && media.src && !mediaError ? (
        <MomentVideo
          src={media.src}
          poster={media.poster}
          thumbhash={meta.kismet_thumbhash}
          showPosterLayer
          className="w-full h-full object-contain"
          priority={priority}
          onAllError={() => setMediaError(true)}
        />
      ) : (media.kind === 'image' || media.kind === 'gif') && media.src && !mediaError ? (
        <MomentImage
          src={media.src}
          alt={title}
          fill
          className="object-contain"
          sizes="(max-width: 896px) 100vw, 896px"
          mime={media.kind === 'gif' ? 'image/gif' : meta.content?.mime}
          thumbhash={meta.kismet_thumbhash}
          priority={priority}
          // Every Patron piece is a heavy physical-art scan that 413s the
          // optimizer; go straight to the downscaling proxy and skip the wasted
          // round-trip on each one.
          preferProxy
          onNaturalSize={handleNaturalSize}
          onAllError={() => setMediaError(true)}
        />
      ) : blurPreview ? (
        <span
          aria-hidden
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url(${blurPreview})` }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-surface">
          <span className="text-line font-mono text-xs">no preview</span>
        </div>
      )}
    </Link>
  )
}

/**
 * The Patron Pass Description panel's "collect artwork" CTA — an inline collect
 * for the primary artwork (the same edition tapping the artwork above would
 * collect), NOT a link to the moment page. Flips to a disabled "sold out" once
 * the bounded edition is fully minted OR its sale window has closed.
 *
 * State sources mirror MomentCard/MomentDetailView so the label agrees with the
 * rest of the app: supply from the on-chain getTokenInfo read, the sale window
 * from the moment's saleConfig (fetched lazily via useMomentSale — /api/timeline
 * doesn't stitch one). Both default to "available" until they resolve, so the
 * button never flashes "sold out" before the reads land. The collect itself
 * goes through useDirectCollect, which re-reads the live sale on-chain and
 * refuses cleanly outside [saleStart, saleEnd] — the authoritative backstop, so
 * a stale label can never let a bad collect through.
 */
function PatronCollectButton({ moment }: { moment: Moment }) {
  const { collect, status } = useDirectCollect()
  const ensureConnected = useEnsureConnected()

  // Reads use the public RPC (no wallet needed), so the sold-out/closed state
  // resolves for signed-out visitors too.
  const { data: tokenInfo } = useReadContract({
    address: moment.address as `0x${string}`,
    abi: ZORA_1155_TOKEN_INFO_ABI,
    functionName: 'getTokenInfo',
    args: [BigInt(moment.token_id)],
  })
  const { data: saleData } = useMomentSale(moment.address, moment.token_id, !moment.saleConfig)

  const collecting = status !== 'idle' && status !== 'done' && status !== 'error'

  // Sold out: a bounded edition fully minted. Undefined read → not sold out yet.
  const info = tokenInfo as { maxSupply: bigint; totalMinted: bigint } | undefined
  const soldOut = !!info && !isOpenEdition(info.maxSupply) && info.totalMinted >= info.maxSupply

  // Window closed: past saleEnd. saleEnd is a unix-second string; "0"/absent/the
  // max-uint64 sentinel mean "no end", and Number() fails open (NaN/huge → not
  // closed) so malformed data never wrongly blocks collect. Matches the
  // saleEnded gate in MomentCard/MomentDetailView.
  const activeSale = moment.saleConfig ?? saleData ?? null
  const saleEndNum = activeSale?.saleEnd ? Number(activeSale.saleEnd) : 0
  const saleClosed =
    Number.isFinite(saleEndNum) && saleEndNum > 0 && saleEndNum <= Math.floor(Date.now() / 1000)

  const unavailable = soldOut || saleClosed

  async function handleCollect() {
    if (unavailable || collecting) return
    // Host wallet inside a Mini App, RainbowKit picker on web; null = the user
    // didn't connect, so stay put (see useEnsureConnected).
    const account = await ensureConnected()
    if (!account) return
    // No price passed — useDirectCollect reads the live sale on-chain. No share
    // offer: the Patron "creator" is the platform treasury, so a post-collect
    // "by @creator" mention would misattribute the real artist.
    await collect({
      collectionAddress: moment.address as `0x${string}`,
      tokenId: moment.token_id,
      amount: 1,
      comment: DEFAULT_COLLECT_COMMENT,
    })
  }

  return (
    <button
      onClick={handleCollect}
      disabled={unavailable || collecting}
      className={`shrink-0 border px-3 py-1.5 text-xs font-mono uppercase tracking-widest transition-colors ${
        unavailable
          ? 'border-line text-muted cursor-not-allowed'
          : collecting
            ? 'border-accent/40 text-accent opacity-70 cursor-wait'
            : 'border-accent/40 text-accent hover:border-accent hover:bg-accent/10'
      }`}
    >
      {collecting ? 'collecting…' : unavailable ? 'sold out' : 'collect artwork'}
    </button>
  )
}

/**
 * Patron Collection showcase — the bespoke presentation for the Kismet Patron
 * Collection page: every artwork gets the same large borderless display (the
 * standard for this collection, so there's no per-moment discrepancy), followed
 * once by the "Patron Pass Description" panel.
 *
 * Only the first artwork loads eagerly as the LCP (priority={i === 0}). On
 * mobile the rest are windowed via MaybeLazy so they don't all mount at once:
 * without it every artwork's MomentImage mounts on first paint and — inside the
 * miniapp iframe/WebKit, where MomentImage force-eagers via skipDirectWalk — all
 * of them fetch full-resolution art simultaneously at fetchPriority="auto",
 * saturating the iframe's shared HTTP/2 pool (the same failure mode the
 * featured-tab fixes target). MaybeLazy defers MOUNT past EAGER_MOUNT_COUNT, so
 * a lazy artwork never even creates its MomentImage until it nears the viewport.
 * Harmless today (this collection is a single token, so only the LCP renders)
 * but keeps the surface correct if it grows to multiple distinct artworks.
 * Desktop runs lazy=false and mounts every artwork eagerly, unchanged.
 */
export function PatronArtworkShowcase({ moments, isMobile = false }: { moments: Moment[]; isMobile?: boolean }) {
  // The description panel's "collect artwork" CTA collects the primary artwork
  // inline (see PatronCollectButton). Guarded so it never renders without a
  // moment if the showcase is ever handed an empty list.
  const primaryMoment = moments[0]
  return (
    <div className="flex flex-col gap-6">
      {moments.map((m, i) => (
        // Key on MaybeLazy itself, not PatronArtwork — its mounted/placeholder
        // branches are different React types, so the key must live on the stable
        // outer position (see LazyMount).
        <MaybeLazy
          key={m.id || `${m.address}-${m.token_id}`}
          index={i}
          lazy={isMobile}
        >
          {() => <PatronArtwork moment={m} priority={i === 0} />}
        </MaybeLazy>
      ))}

      {/* Patron Pass Description */}
      <div className="border border-line bg-[#0d0d0d] p-4 sm:p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-xs font-mono text-muted uppercase tracking-widest">
            patron pass description
          </h3>
          {primaryMoment && <PatronCollectButton moment={primaryMoment} />}
        </div>
        <p className="text-sm font-mono text-dim leading-relaxed whitespace-pre-line">
          {PATRON_PASS_DESCRIPTION.split('Kismet Casa')[0]}
          <a
            href="https://kismetcasa.xyz"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-ink transition-colors"
          >
            Kismet Casa
          </a>
          {PATRON_PASS_DESCRIPTION.split('Kismet Casa')[1]}
        </p>
      </div>
    </div>
  )
}
