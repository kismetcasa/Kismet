'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount, usePublicClient, useReadContract, useSignMessage, useWriteContract } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { toast } from 'sonner'
import { ArrowLeft, Copy, Check, ChevronDown, ChevronUp, Star, X, Pencil, Eye, EyeOff, Send, Square } from 'lucide-react'
import { isAddress } from 'viem'
import { normalize } from 'viem/ens'
import { resolveUri, formatPrice, shortAddress, formatRelativeTime, inferCollectCurrency, isPlatformCollectComment, normalizeTimestampMs, DEFAULT_COLLECT_COMMENT, getSaleWindow, type MomentDetail, type MomentComment } from '@/lib/inprocess'
import { isPatronCollection } from '@/lib/patronCollection'
import { fetchCreatorProfile, fetchCreatorProfilesBatch } from '@/lib/profileCache'
import { resolveMomentCreator } from '@/lib/statsMath'
import { fetchCollectionChip } from '@/lib/collectionCache'
import { useTextContent } from '@/lib/textCache'
import { getCachedDetail, setCachedDetail, getCachedComments, setCachedComments } from '@/lib/momentCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '@/lib/zoraMint'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { usePendingAction } from '@/hooks/usePendingAction'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useMomentSplits } from '@/hooks/useMomentSplits'
import { useMomentEditPermission } from '@/hooks/useMomentEditPermission'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import {
  loadPersistedEditMedia,
  savePersistedEditMedia,
  loadPersistedCover,
  savePersistedCover,
  loadPersistedJson,
  savePersistedJson,
} from '@/lib/arweave/uploadPersistence'
import { generateThumbhash, thumbhashToBlurDataURL } from '@/lib/media/thumbhash'
import { extractVideoPoster } from '@/lib/media/extractPoster'
import { canTranscode, transcodeGifToMp4 } from '@/lib/media/transcodeGif'
import { serverTranscodeGif } from '@/lib/media/serverTranscodeGif'
import { remuxToFaststartMp4 } from '@/lib/media/remuxFaststart'
import { proxyUrl } from '@/lib/media/gateway'
import { ListButton } from './ListButton'
import { SaleWindow } from './SaleWindow'
import { MomentImage, MomentImg } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { normalizeMediaUrl, guessMediaTypeFromUrl } from '@/lib/media/normalizeMediaUrl'
import { ProfileAvatar } from './ProfileAvatar'
import { CopyAddress } from './CopyAddress'
import { SplitsPanel } from './SplitsPanel'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError, TERMINAL_TOAST_DURATION_MS } from '@/lib/toast'
import { composeMomentShareCast } from '@/lib/collectShare'
import { pickFirstNonOperatorAdmin } from '@/lib/momentAuthz'
import { useFarcaster } from '@/providers/FarcasterProvider'

// Stable identity for one activity row across paginated fetches. Collect
// comments and the airdrop rows the route folds onto page 0 share the
// sender+timestamp space, so `kind` disambiguates. Used as the React key AND
// for cross-page dedup, so a new collect shifting the newest-first feed can't
// surface a boundary row twice.
function activityRowKey(c: MomentComment): string {
  return `${c.sender.toLowerCase()}:${c.timestamp}:${c.kind ?? 'collect'}`
}

// Drop rows sharing an activityRowKey, preserving first-seen order. The fetch
// and append paths dedupe as they go; this also covers the initial state
// seeded from the shared cache (MomentCard writes the raw page-0), so
// `comments` is dup-free on every entry path and row keys stay unique by
// construction.
function dedupeActivity(rows: MomentComment[]): MomentComment[] {
  const seen = new Set<string>()
  return rows.filter((c) => {
    const k = activityRowKey(c)
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

interface Props {
  address: string
  tokenId: string
  initialDetail?: MomentDetail | null
  // Optional name/image/description we already have locally (from KV at deploy
  // time for cover tokens). Renders instantly while inprocess catches up; gets
  // overwritten as soon as the client poll lands the real MomentDetail.
  // Shape matches MomentDetail.metadata so callers can substitute without
  // narrowing — animation_url + content are always undefined from KV.
  fallbackMeta?: {
    name?: string
    image?: string
    description?: string
    animation_url?: string
    content?: { mime?: string; uri?: string }
    kismet_thumbhash?: string
  }
  // Server-side hydration for the collection chip below the title. Without
  // this the chip pops in once the client-side /api/collections fetch lands;
  // pre-loading from KV at SSR time keeps it on the first paint.
  initialCollectionMeta?: { name?: string; image?: string }
  // EOA creator address from KV moment-meta (mint-proxy writes this at
  // mint time). Authoritative for Kismet-minted moments before the
  // inprocess timeline indexes them. We prefer it over momentAdmins[0]
  // because that fallback is typically the platform/smart-wallet admin
  // — looking up a Kismet profile against a smart wallet finds nothing
  // and the chip degrades to a raw address even when the user has a
  // username set against their EOA.
  kvCreatorAddress?: string
  // Server-prefetched body for text moments — warms the module-level cache
  // so the writing panel renders on first paint without a client fetch.
  initialTextContent?: string
  // Rendered inside the intercepting-route overlay (vs the canonical
  // full-page route). Suppresses the in-page "back" affordance because
  // the overlay already provides three dismissal paths (X, Escape,
  // backdrop click) and the in-page link would navigate to "/" instead
  // of closing the overlay.
  inOverlay?: boolean
  // Server-computed isWebKitOnlyUA(), passed only by the canonical
  // (hard-navigation / share-link) page — the one path that SSRs this view
  // with data. Threaded to the video so its SSR <video src> is proxy-first
  // for WebKit-only surfaces (iOS Safari, the warpcast RN host) instead of
  // emitting the direct url and wasting a doomed fetch on hydration. The IR
  // overlay mounts client-side (soft nav), where client detection already
  // handles it, so it leaves this false.
  ssrWebKit?: boolean
}

export function MomentDetailView({ address, tokenId, initialDetail, fallbackMeta, initialCollectionMeta, kvCreatorAddress, initialTextContent, inOverlay, ssrWebKit }: Props) {
  const router = useRouter()
  const { address: connectedAddress } = useAccount()

  // When rendered inside the IR overlay, clicks on the outer wrapper's
  // padding regions (the breathing room around the detail card) dismiss
  // the same way the X / Escape / backdrop click do. ModalOverlay's own
  // handler only catches clicks on the parent scroll container — clicks
  // on this wrapper's padding land on the wrapper itself, so the dismiss
  // has to happen here. Target-equals-currentTarget filters out bubbled
  // clicks from any descendant (back-nav, media, comments, etc.) so the
  // actual content stays interactive.
  const outerClick = inOverlay
    ? (e: React.MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget) router.back()
      }
    : undefined
  const ensureConnected = useEnsureConnected()
  const armPendingAction = usePendingAction()
  const { signMessageAsync } = useSignMessage()
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()
  const { isInMiniApp } = useFarcaster()

  const [detail, setDetail] = useState<MomentDetail | null>(
    initialDetail ?? getCachedDetail(address, tokenId) ?? null
  )
  // Set when the indexer-lag poll below exhausts its attempts without data —
  // drives the "couldn't load — retry" pane. Bumping the nonce restarts the poll.
  const [detailExhausted, setDetailExhausted] = useState(false)
  const [detailRetryNonce, setDetailRetryNonce] = useState(0)
  // Client-only mount flag — the sale-window date row (like SaleWindow itself)
  // is locale/timezone-formatted, so it renders only post-mount to avoid a
  // hydration mismatch AND to keep the row from reserving height before there's
  // a date to show (see showSaleWindowRow below).
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const textContentUri =
    detail?.metadata?.content?.mime === 'text/plain'
      ? detail.metadata.content.uri
      : undefined
  const textContent = useTextContent(textContentUri, initialTextContent)
  const [comments, setComments] = useState<MomentComment[]>(
    () => dedupeActivity(getCachedComments(address, tokenId) ?? [])
  )
  const [commentsLoading, setCommentsLoading] = useState(
    () => getCachedComments(address, tokenId) === undefined
  )
  const [loadingMoreComments, setLoadingMoreComments] = useState(false)
  // Seeded true when comments come from the shared cache (depth is unknown, so
  // allow a load-more that self-terminates on the first empty page); a cold
  // page-0 fetch overwrites this with the real signal.
  const [hasMoreComments, setHasMoreComments] = useState(
    () => (getCachedComments(address, tokenId)?.length ?? 0) > 0
  )
  // Row offset into inprocess's comment feed for the NEXT page. Excludes the
  // airdrop rows the route folds onto page 0, and advances by each page's RAW
  // returned count (never the deduped/displayed count) so a boundary re-fetch
  // can't stall it. null until page 0 (or a cache-restore load-more) seeds it.
  const commentOffsetRef = useRef<number | null>(null)
  const seenCommentsRef = useRef<Set<string> | null>(null)
  const [commentSenderProfiles, setCommentSenderProfiles] = useState<Record<string, { name: string; avatarUrl?: string }>>({})
  const [commentText, setCommentText] = useState('')
  const [collected, setCollected] = useState(false)
  const { collect, status: collectStatus } = useDirectCollect()
  const collecting = collectStatus !== 'idle' && collectStatus !== 'done' && collectStatus !== 'error'
  // Seed from the inprocess-provided username (or short address) up front so
  // we don't flash a raw address before fetchCreatorProfile resolves —
  // matches the seeding MomentCard already does on the discover grid.
  // Same EOA-preferring resolution as creatorAddress below: KV first so
  // Kismet-minted moments display the real EOA short-address (and the
  // profile lookup hits a real Kismet profile) instead of the platform
  // smart wallet that inprocess returns as creator.address.
  const [creatorName, setCreatorName] = useState(() => {
    const seedAddr =
      resolveMomentCreator({
        kvCreator: kvCreatorAddress,
        feedCreator:
          initialDetail?.creator?.address
          ?? pickFirstNonOperatorAdmin(initialDetail?.momentAdmins),
      }).address ?? ''
    return initialDetail?.creator?.username || (seedAddr ? shortAddress(seedAddr) : '')
  })
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(undefined)
  const [linkCopied, setLinkCopied] = useState(false)
  const [scanCopied, setScanCopied] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [showFullDesc, setShowFullDesc] = useState(false)
  const [descOverflows, setDescOverflows] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [videoError, setVideoError] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)
  // Seeded from server-prefetched KV metadata when available so the
  // collection chip renders on first paint instead of popping in after
  // the client-side /api/collections fetch lands.
  const [collectionName, setCollectionName] = useState<string | null>(
    initialCollectionMeta?.name ?? null,
  )
  // Raw URI (ar://, ipfs://, https://) — MomentImage walks the gateway
  // pool internally so a freshly-uploaded cover doesn't go missing while
  // ipfs.io catches up.
  const [collectionImage, setCollectionImage] = useState<string | null>(
    initialCollectionMeta?.image ?? null,
  )
  const [collectionImageFailed, setCollectionImageFailed] = useState(false)
  // Edit-metadata flow: visible only to moment admins. Pre-populated from
  // the loaded MomentDetail so they can fix typos / replace the image
  // without re-typing everything.
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  // "Change media" — replaces the primary content (image / gif / video).
  // Two sources: upload a new file, or re-point at content already on
  // Arweave/IPFS (no re-upload — Arweave is content-addressed and permanent,
  // so the original ar:// is valid forever and re-uploading it only burns
  // Turbo credits → the "Insufficient balance" 402 artists hit when restoring
  // a large video they'd previously minted).
  const {
    file: mediaFile,
    inputRef: mediaInputRef,
    onChange: handleMediaFile,
    clear: clearMedia,
  } = useFileUpload({
    maxBytes: 420 * 1024 * 1024,
    onTooLarge: () => toast.error('File too large', { description: 'Max 420 MB' }),
  })
  const [mediaMode, setMediaMode] = useState<'upload' | 'url'>('upload')
  const [existingMediaUrl, setExistingMediaUrl] = useState('')
  const [existingMediaType, setExistingMediaType] = useState<'video' | 'gif' | 'image'>('video')
  // "Change cover" — replaces only the poster/thumbnail (image or gif),
  // never the main media. A GIF cover is stored as-is (animates).
  const {
    file: coverFile,
    preview: coverPreview,
    inputRef: coverInputRef,
    onChange: handleCoverFile,
    clear: clearCover,
  } = useFileUpload({
    maxBytes: 100 * 1024 * 1024,
    onTooLarge: () => toast.error('Cover too large', { description: 'Max 100 MB' }),
  })
  const [savingMeta, setSavingMeta] = useState(false)
  const { ensureSession } = useUploadSession()

  const { data: ownedBalance, refetch: refetchOwnedBalance } = useReadContract({
    address: address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(tokenId)] : undefined,
    query: { enabled: !!connectedAddress },
  })
  const ownedCount = ownedBalance ? Number(ownedBalance) : 0
  const alreadyOwned = ownedCount > 0

  // Hardcoded amount=1: covers 1/1 gifting and matches the airdrop pattern.
  // Edition holders sending multiples can use a wallet directly.
  const [sendOpen, setSendOpen] = useState(false)
  const [sendTo, setSendTo] = useState('')
  // Resolved 0x for the recipient. For a raw address this matches the
  // input; for an ENS name this is the mainnet resolver's answer. We
  // gate the send button on this so users can't fire the tx until the
  // .eth name actually resolves — otherwise an unresolved ENS would
  // either revert or, worse, send to an unintended address.
  const [resolvedSendTo, setResolvedSendTo] = useState<`0x${string}` | null>(null)
  const [resolvingSendTo, setResolvingSendTo] = useState(false)
  const [sendToError, setSendToError] = useState<string | null>(null)
  const { writeContractAsync: writeSend, isPending: sending } = useWriteContract()
  const publicClient = usePublicClient()
  // Mainnet client for ENS resolution. Wagmi already configures a
  // mainnet transport in lib/wagmi.ts purely for ENS, so we reuse it
  // here instead of standing up a duplicate viem client.
  const mainnetClient = usePublicClient({ chainId: mainnet.id })
  const trimmedSendTo = sendTo.trim()
  const looksLikeEns = trimmedSendTo.toLowerCase().endsWith('.eth') && trimmedSendTo.length > 4
  // Resolve recipient input (0x or ENS) as the user types, debounced so
  // we don't hammer the mainnet RPC on every keystroke. Effect is keyed
  // on `trimmedSendTo` and bails via `cancelled` on each re-run so a
  // late-arriving response from a stale query can't overwrite a fresher
  // resolution.
  useEffect(() => {
    if (!trimmedSendTo) {
      setResolvedSendTo(null)
      setResolvingSendTo(false)
      setSendToError(null)
      return
    }
    if (isAddress(trimmedSendTo)) {
      setResolvedSendTo(trimmedSendTo.toLowerCase() as `0x${string}`)
      setResolvingSendTo(false)
      setSendToError(null)
      return
    }
    if (!looksLikeEns) {
      setResolvedSendTo(null)
      setResolvingSendTo(false)
      setSendToError(null)
      return
    }
    if (!mainnetClient) {
      // Wagmi mounts the mainnet client async; treat the gap as
      // "still resolving" rather than a hard error so the brief
      // hydration window doesn't flash a misleading message. The
      // effect re-runs when mainnetClient becomes defined.
      setResolvedSendTo(null)
      setResolvingSendTo(true)
      setSendToError(null)
      return
    }
    let cancelled = false
    setResolvingSendTo(true)
    setResolvedSendTo(null)
    setSendToError(null)
    const handle = setTimeout(async () => {
      try {
        const resolved = await mainnetClient.getEnsAddress({ name: normalize(trimmedSendTo) })
        if (cancelled) return
        if (!resolved) {
          setResolvedSendTo(null)
          setSendToError('Name does not resolve')
        } else {
          setResolvedSendTo(resolved.toLowerCase() as `0x${string}`)
          setSendToError(null)
        }
      } catch {
        if (cancelled) return
        setResolvedSendTo(null)
        setSendToError('ENS lookup failed')
      } finally {
        if (!cancelled) setResolvingSendTo(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [trimmedSendTo, looksLikeEns, mainnetClient])
  const isSelfSend = !!resolvedSendTo
    && !!connectedAddress
    && resolvedSendTo.toLowerCase() === connectedAddress.toLowerCase()
  const sendToValid = !!resolvedSendTo && !isSelfSend && !resolvingSendTo
  const handleSend = async () => {
    if (!connectedAddress || !resolvedSendTo || !sendToValid || sending || !publicClient) return
    try {
      toast.loading('Confirm in wallet…', { id: 'send' })
      const hash = await writeSend({
        address: address as `0x${string}`,
        abi: ERC1155_ABI,
        functionName: 'safeTransferFrom',
        args: [connectedAddress, resolvedSendTo, BigInt(tokenId), 1n, '0x'],
      })
      toast.loading('Sending…', { id: 'send' })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Transfer reverted on-chain')
      toast.success('Sent', { id: 'send' })
      setSendOpen(false)
      setSendTo('')
      setResolvedSendTo(null)
      setSendToError(null)
      refetchOwnedBalance()
    } catch (err) {
      toastError('Send', err, { id: 'send' })
    }
  }

  // Polled so "X collected" updates after a fresh collect without waiting
  // for the inprocess indexer.
  const { data: tokenInfo, refetch: refetchTokenInfo } = useReadContract({
    address: address as `0x${string}`,
    abi: ZORA_1155_TOKEN_INFO_ABI,
    functionName: 'getTokenInfo',
    args: [BigInt(tokenId)],
    // Pause poll when tab hidden; refetchOnWindowFocus (TanStack default)
    // gets a fresh value the moment focus returns.
    query: { refetchInterval: 30_000, refetchIntervalInBackground: false },
  })
  const maxSupply = tokenInfo?.maxSupply
  const totalMinted = tokenInfo?.totalMinted

  const isFeatured = featuredKeys.has(`${address.toLowerCase()}:${tokenId}`)
  // Creator EOA via the SHARED precedence (lib/statsMath resolveMomentCreator
  // — same order the stats rebuild and /api/timeline use, so this page, the
  // feed, and the earnings card agree on who made the moment):
  //   kv    — the EOA mint-proxy wrote to KV moment-meta at mint time.
  //           For Kismet-minted moments inprocess often reports the platform
  //           smart wallet as creator.address (the on-chain msg.sender),
  //           which has no Kismet profile and breaks the display-name /
  //           avatar / profile-link chain. KV is authoritative.
  //   feed  — detail.creator.address (inprocess timeline's dedicated creator
  //           field), else the first non-operator momentAdmins entry as the
  //           last-resort display fallback (unordered list; may contain the
  //           operator smart wallet — filtered — or a 0xSplits contract).
  const creatorAddress =
    resolveMomentCreator({
      kvCreator: kvCreatorAddress,
      feedCreator:
        detail?.creator?.address ?? pickFirstNonOperatorAdmin(detail?.momentAdmins),
    }).address ?? ''
  const isHidden = detail?.hidden === true
  const [hidePending, setHidePending] = useState(false)
  const isCreator =
    !!connectedAddress &&
    !!creatorAddress &&
    connectedAddress.toLowerCase() === creatorAddress.toLowerCase()

  // On-chain edit authorization — the client mirror of update-uri's
  // `canUpdateUri`. Lets moment co-admins (collection defaultAdmin +
  // authorized creators, who hold ADMIN/METADATA but aren't the resolved
  // creator) see the edit affordance, matching what the backend already
  // authorizes. Skipped for the creator, whose pencil shows regardless.
  const canEditMeta = useMomentEditPermission(address, tokenId, { skip: isCreator })

  // Moment admin per inprocess's momentAdmins (unordered; may include the
  // operator smart wallet — harmless, the distribute API's signature gate is
  // authoritative). One of the roles canDistribute admits.
  const isMomentAdmin =
    !!connectedAddress &&
    Array.isArray(detail?.momentAdmins) &&
    detail.momentAdmins.some((a) => a.toLowerCase() === connectedAddress.toLowerCase())
  // saleConfig can be absent on the upstream /moment payload (a moment with no
  // active sale, or an indexer gap). Derive every sale-dependent value from
  // this one guarded read so a missing saleConfig degrades to "no price / not
  // collectible" instead of throwing mid-render — an unguarded
  // detail.saleConfig.* deref trips the error boundary, which (the @modal slot
  // having no error.tsx) paints at the very bottom of the still-mounted feed.
  const saleConfig = detail?.saleConfig ?? null
  const currency = saleConfig ? inferCollectCurrency(saleConfig) : 'eth'
  const {
    hasSplits,
    recipients: splitRecipients,
    splitAddress,
    canDistribute,
    isRecipient,
    pendingFormatted,
    pendingShareFormatted,
    hasPending,
    distribute,
    distributing,
    distributeHash,
  } = useMomentSplits({
    address,
    tokenId,
    isCreator,
    isAdmin: isMomentAdmin,
    isPlatformAdmin: isAdmin,
    currency,
  })
  // The platform admin sees distribute on any moment as a support override.
  // Flag the case where that's the *only* reason the controls show, so the
  // UI can label it rather than imply the admin is a creator/payee.
  const adminDistributeOverride = isAdmin && !isCreator && !isMomentAdmin && !isRecipient

  // Fetch moment detail. We retry on the client when initialDetail is null
  // (server-side fetch returned no data, e.g. inprocess hasn't indexed a
  // freshly-minted token yet) — the previous `!== undefined` check skipped
  // the retry because null !== undefined, leaving the page empty until the
  // server cache expired. We also poll every 5s for up to 60s after a null
  // initial so the page populates as soon as the indexer catches up.
  useEffect(() => {
    if (initialDetail) return
    if (getCachedDetail(address, tokenId)) return

    let cancelled = false
    let attempt = 0
    let visHandler: (() => void) | null = null
    const MAX_ATTEMPTS = 12 // 12 × 5s = 60s of polling

    // Schedule the next attempt — deferred while the tab is hidden. The
    // common share-link pattern is open-then-switch-away; without this the
    // 12 attempts burn out in a background tab and the user comes back to
    // the exhausted state having never really "waited" at all.
    const schedule = () => {
      if (cancelled) return
      if (document.visibilityState === 'hidden') {
        visHandler = () => {
          if (visHandler) document.removeEventListener('visibilitychange', visHandler)
          visHandler = null
          if (!cancelled) void tryFetch()
        }
        document.addEventListener('visibilitychange', visHandler)
        return
      }
      setTimeout(tryFetch, 5000)
    }

    const tryFetch = async () => {
      if (cancelled) return
      const params = new URLSearchParams({ collectionAddress: address, tokenId, chainId: '8453' })
      try {
        const res = await fetch(`/api/moment?${params}`)
        if (!res.ok) throw new Error('not ok')
        const d = await res.json()
        if (d && !cancelled) {
          setCachedDetail(address, tokenId, d)
          setDetail(d)
          return
        }
      } catch {
        // fall through to retry
      }
      attempt += 1
      if (attempt < MAX_ATTEMPTS && !cancelled) {
        schedule()
      } else if (!cancelled) {
        // Terminal: surface a retry affordance instead of an indefinite
        // "loading…" with collect dead — the frozen page hits exactly the
        // freshly-minted URLs people share.
        setDetailExhausted(true)
      }
    }
    setDetailExhausted(false)
    tryFetch()
    return () => {
      cancelled = true
      if (visHandler) document.removeEventListener('visibilitychange', visHandler)
    }
  }, [address, tokenId, initialDetail, detailRetryNonce])

  // Fetch creator profile via shared cache
  useEffect(() => {
    if (!creatorAddress) return
    // Seed from the inprocess-provided username so we don't flash a raw
    // address while Kismet's profile cache resolves. Kismet wins if it
    // has a resolved (non-fallback) name, otherwise we keep whichever
    // seeded value we had.
    const inprocessUsername = detail?.creator?.username ?? null
    if (inprocessUsername) setCreatorName(inprocessUsername)
    fetchCreatorProfile(creatorAddress).then(({ name, avatarUrl }) => {
      const resolved = !!name && name !== shortAddress(creatorAddress)
      if (resolved) setCreatorName(name)
      setCreatorAvatar(avatarUrl)
    })
  }, [creatorAddress, detail?.creator?.username])

  // Fetch page 0 of activity. Skips when already seeded from the shared cache
  // unless `force` (post-collect refresh) — which bypasses the cache to pull
  // the just-added comment and resets pagination to the newest page.
  const fetchComments = useCallback(async (force = false) => {
    if (!force && getCachedComments(address, tokenId)) return
    // A forced refresh already has the list on screen — keep it visible and
    // swap in place rather than blanking to the empty state.
    if (!force) setCommentsLoading(true)
    try {
      const params = new URLSearchParams({ collectionAddress: address, tokenId, chainId: '8453' })
      const res = await fetch(`/api/moment/comments?${params}`)
      if (res.ok) {
        const data = await res.json()
        const fetched: MomentComment[] = Array.isArray(data.comments) ? data.comments : []
        const deduped = dedupeActivity(fetched)
        seenCommentsRef.current = new Set(deduped.map(activityRowKey))
        // Next page starts after page 0's real comments; airdrop rows live only
        // in Kismet's fold, not inprocess's offset space, so exclude them.
        commentOffsetRef.current = fetched.filter((c) => c.kind !== 'airdrop').length
        setHasMoreComments(fetched.some((c) => c.kind !== 'airdrop'))
        setCachedComments(address, tokenId, deduped)
        setComments(deduped)
      }
    } catch {
      // comments are non-critical
    } finally {
      setCommentsLoading(false)
    }
  }, [address, tokenId])

  // Load the next page of activity: paginate inprocess's comment feed by row
  // offset and append. Redis-neutral — the route folds airdrops on page 0
  // only, so pages > 0 are pure upstream comments and touch no Kismet state.
  const loadMoreComments = useCallback(async () => {
    if (loadingMoreComments || !hasMoreComments) return
    // Cache-restore path: the refs were never seeded by a page-0 fetch (the
    // list came from the shared cache), so derive them from what's on screen.
    let seenInit = seenCommentsRef.current
    if (seenInit === null) {
      seenInit = new Set(comments.map(activityRowKey))
      seenCommentsRef.current = seenInit
    }
    const seen = seenInit
    const startOffset =
      commentOffsetRef.current ?? comments.filter((c) => c.kind !== 'airdrop').length
    setLoadingMoreComments(true)
    try {
      const params = new URLSearchParams({
        collectionAddress: address,
        tokenId,
        chainId: '8453',
        offset: String(startOffset),
      })
      const res = await fetch(`/api/moment/comments?${params}`)
      if (res.ok) {
        const data = await res.json()
        const page: MomentComment[] = Array.isArray(data.comments) ? data.comments : []
        // Advance by the RAW page size before deduping so an all-duplicate
        // boundary page still moves the cursor forward.
        commentOffsetRef.current = startOffset + page.length
        // An empty page is the end of the feed. Immune to the route's per-page
        // hidden-user filtering, which can shorten a page without ending it.
        if (page.length === 0) {
          setHasMoreComments(false)
        } else {
          const fresh = page.filter((c) => {
            const k = activityRowKey(c)
            if (seen.has(k)) return false
            seen.add(k)
            return true
          })
          if (fresh.length > 0) {
            setComments((prev) => {
              const next = [...prev, ...fresh]
              // Airdrop rows are folded onto page 0 only, so a later (older)
              // comment page can carry rows that belong BELOW an already-shown
              // airdrop. Re-sort by normalized timestamp — the exact comparator
              // the route applies to page 0 (lib inprocess normalizeTimestampMs,
              // `|| 0` NaN guard) — but only when an airdrop is present, so pure-
              // comment feeds keep inprocess's order untouched and never reflow.
              if (next.some((c) => c.kind === 'airdrop')) {
                next.sort(
                  (x, y) =>
                    (normalizeTimestampMs(y.timestamp) || 0) -
                    (normalizeTimestampMs(x.timestamp) || 0),
                )
              }
              setCachedComments(address, tokenId, next)
              return next
            })
          }
        }
      }
    } catch {
      // non-critical — the button remains for a retry
    } finally {
      setLoadingMoreComments(false)
    }
  }, [address, tokenId, comments, hasMoreComments, loadingMoreComments])

  useEffect(() => { fetchComments() }, [fetchComments])

  // Batch-resolve activity-row sender profiles (name + avatar) via the shared
  // cache + a single /api/profiles request, rather than one /api/profile call
  // per sender. In-process comments carry only the bare sender address, so
  // every unique sender needs identity resolution; collapsing that fan-out
  // into one round-trip is what keeps the activity list from trickling in.
  useEffect(() => {
    if (comments.length === 0) return
    let cancelled = false
    const senders = Array.from(new Set(comments.map((c) => c.sender.toLowerCase())))
    fetchCreatorProfilesBatch(senders).then((profiles) => {
      if (cancelled) return
      setCommentSenderProfiles((prev) => ({ ...prev, ...profiles }))
    })
    return () => { cancelled = true }
  }, [comments])

  useEffect(() => {
    fetchCollectionChip(address).then(({ name, image }) => {
      // Guards preserve the SSR-seeded values when inprocess returns
      // a partial response during the brief post-deploy indexing window.
      if (name) setCollectionName(name)
      if (image) {
        setCollectionImage(image)
        setCollectionImageFailed(false)
      }
    })
  }, [address])

  useEffect(() => {
    const el = descRef.current
    if (!el) return
    setDescOverflows(el.scrollHeight > el.clientHeight)
  }, [detail])

  useEscapeKey(useCallback(() => setLightboxOpen(false), []), lightboxOpen)

  async function handleCollect() {
    // No saleConfig gate — collect resolves price on-chain (see
    // useDirectCollect); gating on the display saleConfig would dead-end the
    // button. (Render-path saleConfig derefs stay guarded above.)
    if (!detail) return
    // Resolve a connected wallet (host wallet inside a Mini App, RainbowKit
    // picker on web); null = not yet connected. See useEnsureConnected.
    const account = await ensureConnected()
    if (!account) {
      // Picker is open — resume this collect once the user connects, so the
      // first tap carries through (see usePendingAction).
      armPendingAction(() => { void handleCollect() })
      return
    }
    // No price passed — the hook reads the live sale on-chain (authoritative).
    const result = await collect({
      collectionAddress: address as `0x${string}`,
      tokenId,
      amount: 1,
      comment: commentText.trim() || DEFAULT_COLLECT_COMMENT,
      // Post-collect share prompt (Mini App only — the hook gates). creatorName
      // is the display fallback; the share flow re-resolves the creator's raw
      // FC username for a real @mention (see lib/collectShare).
      share: {
        momentName: detail.metadata?.name ?? null,
        creatorAddress: creatorAddress || null,
        creatorName,
      },
    })
    if (result) {
      setCollected(true)
      setCommentText('')
      // Force past the cache so the just-added comment lands (and pagination
      // resets to the newest page); 3s lets inprocess index the collect.
      setTimeout(() => void fetchComments(true), 3000)
      // Refresh on-chain state immediately rather than waiting for the
      // 30s poll — chain state has moved one tick at this point.
      refetchTokenInfo().catch(() => {})
      refetchOwnedBalance().catch(() => {})
    }
  }

  const hasCollected = alreadyOwned || collected
  // Wait for both reads before flagging — otherwise we'd flash "sold out"
  // before tokenInfo lands.
  const mintedOut =
    maxSupply !== undefined &&
    totalMinted !== undefined &&
    !isOpenEdition(maxSupply) &&
    totalMinted >= maxSupply
  // Sold-out spotlight for viewers who HAVEN'T collected — mirrors MomentCard:
  // gradient moves price → SOLD OUT label (no disabled dimming on it).
  // Collected viewers keep today's treatment, including the gradient price.
  const soldOutUncollected = mintedOut && !hasCollected
  // Sale-window gating — see MomentCard for the rationale. saleStart/saleEnd
  // are unix-second strings on detail.saleConfig; absent, "0", or the max-
  // uint64 sentinel mean "no bound". Number() fails open so malformed data
  // can't wrongly block collect. A scheduled mint isn't collectible until it
  // opens; a closed one isn't after it ends.
  const saleNowSec = Math.floor(Date.now() / 1000)
  const saleStartNum = detail?.saleConfig?.saleStart ? Number(detail.saleConfig.saleStart) : 0
  const saleEndNum = detail?.saleConfig?.saleEnd ? Number(detail.saleConfig.saleEnd) : 0
  const saleNotStarted = Number.isFinite(saleStartNum) && saleStartNum > saleNowSec
  const saleEnded = Number.isFinite(saleEndNum) && saleEndNum > 0 && saleEndNum <= saleNowSec
  const collectLabel = collecting
    ? 'collecting…'
    : mintedOut
      ? 'sold out'
      : saleNotStarted
        ? 'not started'
        : saleEnded
          ? 'sale ended'
          : hasCollected ? 'collect+' : 'collect'

  async function handleDistribute() {
    if (!detail) { toast.error('Artwork details still loading'); return }
    await distribute(currency)
  }

  // In a Mini App, share = open the Farcaster cast composer prefilled with the
  // same copy/format as the post-collect share — "enjoy "<title>" by @creator
  // on @kismet" — plus the moment embed, posted to /kismet (see
  // lib/collectShare). On the web, share = copy-to-clipboard (no host composer
  // to call). The Mini App path falls through to copy if the SDK throws so the
  // button never becomes a dead click.
  async function handleShare() {
    const url = `${window.location.origin}/moment/${address}/${tokenId}`
    if (isInMiniApp) {
      try {
        await composeMomentShareCast(
          {
            collectionAddress: address,
            tokenId,
            momentName: detail?.metadata?.name ?? null,
            creatorAddress: creatorAddress || null,
            creatorName,
          },
          { verb: 'enjoy' },
        )
        return
      } catch { /* fall through to clipboard */ }
    }
    navigator.clipboard.writeText(url).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  function handleCopyScan() {
    const url = `https://basescan.org/token/${address}?a=${tokenId}`
    navigator.clipboard.writeText(url).catch(() => {})
    setScanCopied(true)
    setTimeout(() => setScanCopied(false), 1500)
  }

  async function handleToggleHidden() {
    if (!detail || hidePending) return
    const next = !isHidden
    setHidePending(true)
    try {
      // /api/moment/hide reads the Kismet session cookie. Wallet-connect
      // alone doesn't create one — ensureSession prompts a one-time
      // signature when the cookie is missing, matching the edit-metadata
      // flow on this same page.
      await ensureSession()
      const res = await fetch('/api/moment/hide', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionAddress: address, tokenId, hidden: next }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Hide failed')
      }
      // Patch the local detail AND the shared moment-cache so any subsequent
      // modal open or detail re-mount in the same session sees the new state.
      // The edit-metadata handler does the same below.
      setDetail((prev) => {
        if (!prev) return prev
        const updated = { ...prev, hidden: next }
        setCachedDetail(address, tokenId, updated)
        return updated
      })
      // Notify other surfaces (notably the airdrop picker in MintTabs)
      // that hide-state for SOME moment changed so they can refetch.
      // Without this the picker keeps showing the moment even though
      // it's been hidden everywhere else, until a wallet-switch or
      // page reload invalidates its cache.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kismetart:moment-hidden-changed'))
      }
      // Updates the in-flight 'hide' loading toast, which would otherwise pin
      // it on screen forever (see TERMINAL_TOAST_DURATION_MS).
      toast.success(next ? 'Hidden from public feeds' : 'Visible again', {
        id: 'hide',
        duration: TERMINAL_TOAST_DURATION_MS,
      })
    } catch (err) {
      toastError('Hide', err, { id: 'hide' })
    } finally {
      setHidePending(false)
    }
  }

  function openEditor() {
    if (!detail) return
    setEditName(detail.metadata.name ?? '')
    setEditDesc(detail.metadata.description ?? '')
    clearMedia()
    clearCover()
    setMediaMode('upload')
    setExistingMediaUrl('')
    setExistingMediaType('video')
    setEditing(true)
  }

  function closeEditor() {
    clearMedia()
    clearCover()
    setMediaMode('upload')
    setExistingMediaUrl('')
    setExistingMediaType('video')
    setEditing(false)
  }

  async function handleSaveMetadata() {
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    if (!detail) return
    if (!editName.trim()) { toast.error('Title required'); return }

    setSavingMeta(true)
    try {
      await ensureSession()

      // Existing values carry over when nothing is re-uploaded — Arweave is
      // content-addressed so the original ar:// stays valid forever, and the
      // thumbhash is preserved so a name/description-only edit doesn't strip
      // the blur placeholder.
      let imageUri = detail.metadata.image
      let animationUri = detail.metadata.animation_url
      let contentField: { uri?: string; mime?: string } | undefined = detail.metadata.content
      let thumbhash = detail.metadata.kismet_thumbhash

      // 1a) RE-POINT MEDIA — point the moment at content already on Arweave.
      // No upload: Arweave is content-addressed, so re-sending bytes only
      // burns Turbo credits (→ 402) for an identical result. content.mime is
      // set explicitly because ar:// hashes carry no extension to classify by.
      // Empty field = no change (media is optional); a non-empty bad URL errors.
      const repointUrl = mediaMode === 'url' ? normalizeMediaUrl(existingMediaUrl) : null
      if (mediaMode === 'url' && existingMediaUrl.trim() && !repointUrl) {
        throw new Error('That doesn’t look like a valid media URL — paste an ar:// URI or an https gateway link')
      }
      if (repointUrl) {
        if (existingMediaType === 'video') {
          animationUri = repointUrl
          contentField = { uri: repointUrl, mime: 'video/mp4' }
          // Poster (image) + thumbhash carry over unless a cover is set below.
        } else if (existingMediaType === 'gif') {
          animationUri = repointUrl
          contentField = { uri: repointUrl, mime: 'image/gif' }
        } else {
          // Still image → it IS the moment; drop the video binding. The old
          // thumbhash described the prior media, so clear it.
          imageUri = repointUrl
          animationUri = undefined
          contentField = undefined
          thumbhash = undefined
        }
      }

      // 1b) CHANGE MEDIA (upload) — mirrors the mint pipeline: video →
      // faststart MP4 + poster; GIF → transcoded MP4 + poster (server fallback
      // over the 100MB wasm cap); image → still moment.
      //
      // Cross-reload / retry resume: if we already uploaded THIS exact file
      // (name|size|lastModified) in a prior attempt — a wallet rejection, a
      // soft-gate lag, or a page reload — reuse its durable txids instead of
      // re-transcoding and re-uploading paid bytes under a fresh Turbo txid
      // (data-item ids are salted, so identical bytes never reuse an id). Uses
      // edit-moment's OWN store (never mint's, whose schema differs); the
      // PRESENCE of animationUri discriminates a video binding from a still image.
      let mediaResumed = false
      if (mediaMode === 'upload' && mediaFile) {
        const persisted = loadPersistedEditMedia(mediaFile)
        if (persisted) {
          if (persisted.animationUri) {
            animationUri = persisted.animationUri
            contentField = { uri: persisted.animationUri, mime: 'video/mp4' }
            // Poster only applies when no cover is set (the cover block wins).
            if (!coverFile) {
              if (persisted.imageUri) {
                imageUri = persisted.imageUri
                if (persisted.thumbhash) thumbhash = persisted.thumbhash
              } else {
                // The banked attempt had a cover, so no poster was made. Extract
                // one now from the re-selected file so a cover-removed retry
                // still gets a real video frame, not the stale pre-edit image.
                try {
                  const poster = await extractVideoPoster(mediaFile)
                  if (poster) {
                    const tp = generateThumbhash(poster)
                    imageUri = await uploadToArweave(poster)
                    thumbhash = (await tp) ?? thumbhash
                    savePersistedEditMedia(mediaFile, {
                      animationUri: persisted.animationUri,
                      imageUri: imageUri ?? null,
                      thumbhash: thumbhash ?? null,
                    })
                  }
                } catch (err) {
                  console.warn('[MomentDetailView] poster extraction on resume failed', err)
                }
              }
            }
          } else if (persisted.imageUri) {
            // Still image → it IS the moment; drop any video binding.
            imageUri = persisted.imageUri
            animationUri = undefined
            contentField = undefined
            if (persisted.thumbhash) thumbhash = persisted.thumbhash
          }
          mediaResumed = true
        }
      }
      if (mediaMode === 'upload' && mediaFile && !mediaResumed) {
        // Tracks ONLY a freshly-uploaded poster/still for THIS media — never the
        // carried-over detail.metadata.image. We bank this, not `imageUri`,
        // because banking the stale carry-over as a poster would poison the
        // resume discriminator (presence of imageUri = "a real poster exists"),
        // so a retry would reuse the stale image instead of re-extracting after
        // a transient extractVideoPoster miss.
        let freshMediaImage: string | undefined
        const isGif = mediaFile.type === 'image/gif' || mediaFile.name.toLowerCase().endsWith('.gif')
        if (mediaFile.type.startsWith('video/')) {
          toast.loading('Optimizing video…', { id: 'edit-meta' })
          let video = mediaFile
          try {
            const remuxed = await remuxToFaststartMp4(mediaFile)
            if (remuxed) video = remuxed
          } catch (err) {
            console.warn('[MomentDetailView] faststart remux failed; uploading original', err)
          }
          toast.loading('Uploading media…', { id: 'edit-meta' })
          animationUri = await uploadToArweave(video)
          contentField = { uri: animationUri, mime: 'video/mp4' }
          // Auto-extract a poster unless the creator is also setting a cover.
          if (!coverFile) {
            try {
              const poster = await extractVideoPoster(mediaFile)
              if (poster) {
                const tp = generateThumbhash(poster)
                imageUri = await uploadToArweave(poster)
                freshMediaImage = imageUri
                thumbhash = (await tp) ?? thumbhash
              }
            } catch (err) {
              console.warn('[MomentDetailView] poster extraction failed', err)
            }
          }
        } else if (isGif) {
          let done = false
          if (canTranscode(mediaFile)) {
            try {
              toast.loading('Optimizing animation for fast playback…', { id: 'edit-meta' })
              const { mp4, poster } = await transcodeGifToMp4(mediaFile)
              toast.loading('Uploading media…', { id: 'edit-meta' })
              const tp = generateThumbhash(poster)
              const [a, p] = await Promise.all([uploadToArweave(mp4), uploadToArweave(poster)])
              animationUri = a
              contentField = { uri: a, mime: 'video/mp4' }
              if (!coverFile) { imageUri = p; freshMediaImage = p; thumbhash = (await tp) ?? thumbhash }
              done = true
            } catch (err) {
              console.warn('[MomentDetailView] client GIF transcode failed; trying server', err)
            }
          }
          if (!done) {
            toast.loading('Uploading animation…', { id: 'edit-meta' })
            const rawUri = await uploadToArweave(mediaFile)
            if (!(await verifyArweaveAvailable(rawUri, 90_000))) {
              throw new Error('Source GIF not yet propagated — try again in a minute')
            }
            toast.loading('Optimizing animation on server…', { id: 'edit-meta' })
            const r = await serverTranscodeGif(rawUri)
            animationUri = r.animationUri
            contentField = { uri: r.animationUri, mime: 'video/mp4' }
            if (!coverFile) { imageUri = r.posterUri; freshMediaImage = r.posterUri; thumbhash = r.thumbhash ?? thumbhash }
          }
        } else {
          // Static image → the image IS the moment; drop any video binding.
          toast.loading('Uploading media…', { id: 'edit-meta' })
          const tp = generateThumbhash(mediaFile)
          imageUri = await uploadToArweave(mediaFile)
          freshMediaImage = imageUri
          thumbhash = (await tp) ?? thumbhash
          animationUri = undefined
          contentField = undefined
        }
        // Bank the verified upload so a retry, soft-gate lag, or reload reuses
        // these durable txids instead of re-transcoding + re-uploading paid
        // bytes. We bank freshMediaImage (a poster/still uploaded THIS run), not
        // `imageUri` — which may still hold the carried-over pre-edit image when
        // a cover is set or poster extraction missed. Banking null there lets the
        // resume re-extract instead of freezing the stale image. The resume keys
        // off animationUri's presence to tell a video binding from a still.
        if (animationUri || freshMediaImage) {
          savePersistedEditMedia(mediaFile, {
            animationUri: animationUri ?? null,
            imageUri: freshMediaImage ?? null,
            thumbhash: thumbhash ?? null,
          })
        }
      }

      // 2) CHANGE COVER — replaces only the poster/thumbnail, stored as-is (a
      // GIF cover animates). Never touches the main media (animation_url).
      // Banked by file identity (like create / edit-collection) so a retry or
      // reload reuses the durable txid instead of re-uploading the cover.
      if (coverFile) {
        const persistedCover = loadPersistedCover(coverFile)
        if (persistedCover) {
          imageUri = persistedCover.imageUri
          if (persistedCover.thumbhash) thumbhash = persistedCover.thumbhash
        } else {
          toast.loading('Uploading cover…', { id: 'edit-meta' })
          const tp = generateThumbhash(coverFile)
          imageUri = await uploadToArweave(coverFile)
          thumbhash = (await tp) ?? thumbhash
          savePersistedCover(coverFile, { imageUri, thumbhash: thumbhash ?? null, verifyFailures: 0 })
        }
      }

      // Build the new metadata JSON from the resolved bindings above —
      // unchanged fields carry their existing values, a media change updates
      // animation_url/content (or clears them for a new still image), and a
      // cover change updates only image.
      const newMetadata: Record<string, unknown> = {
        name: editName.trim(),
        description: editDesc.trim(),
        ...(imageUri ? { image: imageUri } : {}),
        ...(animationUri ? { animation_url: animationUri } : {}),
        ...(contentField ? { content: contentField } : {}),
        ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
      }

      toast.loading('Uploading metadata…', { id: 'edit-meta' })
      // Content-keyed resume: reuse the durable txid for byte-identical metadata
      // across a retry / reload instead of re-uploading it under a fresh Turbo
      // txid (matches create / edit-collection). The metadata embeds the media
      // + cover URIs, so the key changes iff anything the user edited changed.
      const metadataKey = JSON.stringify(newMetadata)
      const persistedJson = loadPersistedJson(metadataKey)
      let newUri: string
      if (persistedJson) {
        newUri = persistedJson.uri
      } else {
        newUri = await uploadJson(newMetadata)
        savePersistedJson(metadataKey, { uri: newUri, failures: 0 })
      }

      // Best-effort propagation wait, then SOFT-GATE — the conclusion the mint
      // + create flows already reached. The ar:// txids are PERMANENT the
      // moment Turbo returned them, so the old hard throw stranded legitimate
      // edits whenever arweave.net (now the pool's only gateway) hadn't yet
      // surfaced a fresh upload. We wait up to 90s for a smoother first paint,
      // but on a miss we still commit the on-chain pointer; the not-yet-
      // propagated URI self-heals on display once the pool catches up.
      toast.loading('Verifying Arweave propagation…', { id: 'edit-meta' })
      // A media change is either a fresh upload or a re-point at existing
      // content; both want their image/animation URIs verified before we
      // commit the on-chain pointer. A re-point's bytes are already live, so
      // this is a cheap sanity check that also catches a typo'd txid.
      const mediaChanged = repointUrl != null || (mediaMode === 'upload' && !!mediaFile)
      // Verify freshly-resolved URIs (image when media/cover changed, the MP4
      // when media changed). image is pushed before animation, so positional
      // destructuring stays correct.
      const verifies: Promise<boolean>[] = [verifyArweaveAvailable(newUri, 90_000, 'edit-moment:metadata')]
      if ((mediaChanged || coverFile) && imageUri?.startsWith('ar://')) {
        verifies.push(verifyArweaveAvailable(imageUri, 90_000, 'edit-moment:image'))
      }
      if (mediaChanged && animationUri?.startsWith('ar://')) {
        verifies.push(verifyArweaveAvailable(animationUri, 90_000, 'edit-moment:animation'))
      }
      const [metaOk, imageOk = true, animOk = true] = await Promise.all(verifies)
      if (!metaOk || !imageOk || !animOk) {
        // Don't strand the editor: log the lagging txids (so a genuinely-lost
        // upload is diagnosable — `curl -I` the logged ar:// id) and proceed.
        const laggy: string[] = []
        if (!imageOk) laggy.push('image')
        if (!animOk) laggy.push('media')
        if (!metaOk) laggy.push('metadata')
        console.warn('[MomentDetailView] proceeding despite Arweave propagation lag', {
          laggy,
          newUri,
          imageUri,
          animationUri,
        })
      }

      toast.loading('Sign update in wallet…', { id: 'edit-meta' })
      const nonceRes = await fetch(`/api/profile/${connectedAddress}/nonce`)
      if (!nonceRes.ok) throw new Error(`Could not fetch nonce (HTTP ${nonceRes.status})`)
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce (empty response)')
      const message = `Update Kismet metadata\nCollection: ${address.toLowerCase()}\nToken: ${tokenId}\nURI: ${newUri}\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
      const signature = await signMessageAsync({ message })

      toast.loading('Updating on-chain…', { id: 'edit-meta' })
      const res = await fetch('/api/moment/update-uri', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionAddress: address,
          tokenId,
          newUri,
          callerAddress: connectedAddress,
          signature,
          nonce,
          chainId: 8453,
          displayName: editName.trim(),
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? data.detail ?? data.message ?? 'Update failed')

      // Warm /api/img's edge cache for the new image so MomentImage's
      // proxy fallback hits cached bytes the moment the optimistic state
      // swap below re-mounts the <Image>. Fire-and-forget — failure is
      // a no-op, the existing fallback chain still walks the pool.
      if ((mediaChanged || coverFile) && imageUri?.startsWith('ar://')) {
        void fetch(proxyUrl(imageUri), { cache: 'no-store' }).catch(() => {})
      }

      // Optimistically refresh the in-memory detail so UI reflects the
      // new metadata immediately. The proper refetch from inprocess will
      // catch up within a poll cycle. Thumbhash is included so the blur
      // placeholder paints under the new image while it loads.
      const optimistic: MomentDetail = {
        ...detail,
        uri: newUri,
        metadata: {
          ...detail.metadata,
          name: editName.trim(),
          description: editDesc.trim(),
          ...(imageUri ? { image: imageUri } : {}),
          // Explicit (not spread-conditional) so a media change is reflected
          // immediately — including clearing the video for a new still image.
          animation_url: animationUri,
          content: contentField,
          ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
        },
      }
      setCachedDetail(address, tokenId, optimistic)
      setDetail(optimistic)

      toast.success('Metadata updated!', { id: 'edit-meta' })
      closeEditor()
    } catch (err) {
      toastError('Update', err, { id: 'edit-meta' })
    } finally {
      setSavingMeta(false)
    }
  }

  // Prefer real inprocess metadata once we have it; fall back to whatever we
  // wrote locally at deploy time so the image/title/description don't sit
  // blank for the 5-30s of indexer delay on a fresh mint.
  const meta = detail?.metadata ?? fallbackMeta ?? {}
  const media = resolveMomentMedia(meta)
  const isTextMoment = media.kind === 'text'
  const isVideo = media.kind === 'video'
  // Still images and gifs open the zoom lightbox; videos use native
  // fullscreen via their controls.
  const isZoomable = media.kind === 'image' || media.kind === 'gif'
  // Low-fi blur for the no-preview fallback. When every gateway is exhausted
  // or the codec is undecodable there's no poster left to show (MomentVideo
  // only surfaces onAllError once its own poster has failed too) — but the
  // ~25-byte thumbhash still decodes, so paint it behind the label instead of
  // a flat empty tile. undefined for older mints / audio (no thumbhash).
  const noPreviewBlur = thumbhashToBlurDataURL(meta.kismet_thumbhash)
  const price = saleConfig
    ? formatPrice(saleConfig.pricePerToken, currency)
    : null

  // Hidden moments are visible only to their creator (so they can unhide).
  // Non-creator viewers see a placeholder with no metadata leak so the
  // creator's intent to hide is honored even on direct URL access.
  if (isHidden && !isCreator) {
    return (
      <div className="max-w-[88rem] mx-auto px-3 sm:px-4 pt-3 sm:pt-4 pb-16" onClick={outerClick}>
        {!inOverlay && (
          <div className="px-4 py-3 border-b border-line">
            <Link
              href="/"
              className="inline-flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim transition-colors"
            >
              <ArrowLeft size={12} />
              back
            </Link>
          </div>
        )}
        <div className="flex flex-col items-center justify-center gap-3 py-24 px-6">
          <EyeOff size={20} className="text-subtle" />
          <p className="text-sm font-mono text-dim">this artwork has been hidden by the creator</p>
        </div>
      </div>
    )
  }

  // scan / share (+ send when owned). One fragment, two positions: ABOVE the
  // price row on mobile / mini-app, and inside the controls band BELOW the price
  // on desktop (see the two call sites). Sharing the fragment keeps the buttons
  // and their handlers identical across both — only one set is ever visible
  // (the other is display:none via the breakpoint), so no double-firing.
  const secondaryActionButtons = (
    <>
      <button
        onClick={handleCopyScan}
        className="flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim transition-colors w-fit"
        title="Copy BaseScan link"
      >
        <Square size={12} strokeWidth={1.5} />
        {scanCopied ? 'copied' : 'scan'}
      </button>
      <button
        onClick={handleShare}
        className="flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim transition-colors w-fit"
      >
        {linkCopied
          ? <Check size={12} className="text-[#6ee7b7]" />
          : <Copy size={12} strokeWidth={1.5} />}
        {linkCopied ? 'copied' : 'share'}
      </button>
      {alreadyOwned && (
        <button
          onClick={() => setSendOpen((v) => !v)}
          // order-first: on mobile (the "x sold" row) send leads — send → scan
          // → share. sm:order-none restores DOM order in the desktop controls
          // band, where it reads scan → share → send.
          className="order-first flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim transition-colors w-fit sm:order-none"
        >
          <Send size={12} strokeWidth={1.5} />
          {sendOpen ? 'cancel' : 'send'}
        </button>
      )}
    </>
  )

  // Whether the sale-window date should render at all. Mirrors SaleWindow's own
  // decision (mounted + a dated window) so neither the mobile date line nor the
  // desktop date column reserves space when there's no date to show. atSec is
  // set for scheduled/closing/ended and null for a live open-ended sale, so this
  // is false exactly when SaleWindow would render null.
  const showSaleWindowRow = mounted && getSaleWindow(detail?.saleConfig)?.atSec != null

  // The armed send form (input + confirm + resolver hint). One definition, two
  // breakpoint-exclusive positions: INLINE in the desktop utility row (between
  // the send button and the sale date — the row is hidden below sm, so that
  // copy self-hides on mobile) and full-width below the row on mobile
  // (sm:hidden). Both copies bind the same state; only one is ever displayed.
  const sendForm = (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          value={sendTo}
          onChange={(e) => setSendTo(e.target.value)}
          placeholder="0x address or name.eth"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="flex-1 min-w-0 bg-surface border border-line px-3 py-2 text-xs font-mono text-ink placeholder-subtle focus:outline-none focus:border-muted"
        />
        <button
          onClick={handleSend}
          disabled={!sendToValid || sending}
          className="flex-none px-4 py-2 text-xs font-mono tracking-wider uppercase border border-line text-muted accent-grad-hover transition-colors disabled:opacity-50"
        >
          {sending ? '…' : 'confirm'}
        </button>
      </div>
      {trimmedSendTo && (
        <div className="mt-1.5 text-[10px] font-mono">
          {resolvingSendTo ? (
            <span className="text-muted">resolving…</span>
          ) : isSelfSend ? (
            <span className="text-red-400">cannot send to yourself</span>
          ) : sendToError ? (
            <span className="text-red-400">{sendToError}</span>
          ) : resolvedSendTo && looksLikeEns ? (
            <span className="text-muted">→ {shortAddress(resolvedSendTo)}</span>
          ) : null}
        </div>
      )}
    </div>
  )

  // The price | supply box. Rendered real in the action row, and again as an
  // invisible WIDTH-ONLY strut (h-0) in the desktop utility row, so the sale
  // date can center under the collect button by mirroring this box's exact,
  // content-dependent width without hardcoding it.
  const priceSupplyBox = (
    <div className="flex border border-line flex-none">
      <div className="px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
        <span className={`text-[11px] font-mono ${soldOutUncollected ? 'text-muted' : 'accent-grad'}`}>{price ?? '…'}</span>
      </div>
      <div className="border-l border-line px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
        <span className="text-[11px] font-mono text-subtle">
          {maxSupply === undefined
            ? '…'
            : isOpenEdition(maxSupply)
              ? 'open'
              : maxSupply.toLocaleString()}
        </span>
      </div>
    </div>
  )

  return (
    <div className="max-w-[88rem] mx-auto px-3 sm:px-4 pt-3 sm:pt-4 pb-16" onClick={outerClick}>

      {/* Back nav — canonical only. In the overlay the X / Escape /
          backdrop-click triad already dismisses; rendering a "back"
          link that points to "/" would navigate away from the feed
          instead of just closing the overlay. */}
      {!inOverlay && (
        <div className="px-4 py-3 border-b border-line">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim transition-colors"
          >
            <ArrowLeft size={12} />
            back
          </Link>
        </div>
      )}

      {/* Creator-only banner so the creator knows their moment is hidden */}
      {isHidden && isCreator && (
        <div className="px-4 py-2 border-b border-line bg-raised flex items-center gap-2">
          <EyeOff size={11} className="text-dim" />
          <p className="text-[10px] font-mono text-dim uppercase tracking-widest">
            hidden from public — only you can see this
          </p>
        </div>
      )}

      {/* Two-column on desktop, stacked on mobile */}
      <div className="md:grid md:grid-cols-2 border-b border-line">

        {/* Left: media — sticky on desktop */}
        <div className="border-b border-line md:border-b-0 md:border-r md:border-r-line md:sticky md:top-14">
          {isTextMoment ? (
            <div className="min-h-64 flex flex-col p-6 sm:p-10 bg-surface">
              <span className="text-[10px] font-mono text-muted uppercase tracking-widest mb-3">writing</span>
              <p className="text-sm font-mono text-ink leading-relaxed whitespace-pre-wrap">
                {textContent ?? <span className="text-dim">loading from Arweave…</span>}
              </p>
            </div>
          ) : (
            <div
              className={`relative aspect-square bg-surface ${isZoomable ? 'cursor-zoom-in' : ''}`}
              onClick={() => { if (isZoomable) setLightboxOpen(true) }}
            >
              {isVideo && media.src && !videoError ? (
                <MomentVideo
                  src={media.src}
                  poster={media.poster}
                  thumbhash={meta.kismet_thumbhash}
                  showPosterLayer
                  controls
                  ssrProxyHint={ssrWebKit}
                  className="w-full h-full object-contain"
                  onAllError={() => setVideoError(true)}
                />
              ) : isZoomable && media.src && !imgError ? (
                <MomentImage
                  src={media.src}
                  alt={meta.name ?? 'artwork'}
                  fill
                  className="object-contain"
                  sizes="(max-width: 768px) 100vw, 50vw"
                  priority
                  // Force the gif mime so the optimizer is skipped and the
                  // animated bytes stream through /api/img.
                  mime={media.kind === 'gif' ? 'image/gif' : meta.content?.mime}
                  // Patron physical-art scans 413 the optimizer on every
                  // open — go straight to the downscaling proxy (same
                  // detection as MomentCard) so the detail view first-paints
                  // without the doomed round-trip.
                  preferProxy={isPatronCollection(address)}
                  thumbhash={meta.kismet_thumbhash}
                  onAllError={() => setImgError(true)}
                />
              ) : !detail ? (
                <div className="w-full h-full flex flex-col items-center justify-center gap-3">
                  {detailExhausted ? (
                    <>
                      <span className="text-muted font-mono text-xs text-center px-6">
                        this artwork hasn&rsquo;t loaded — it may still be indexing
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          setDetailExhausted(false)
                          setDetailRetryNonce((n) => n + 1)
                        }}
                        className="px-4 py-1.5 border border-line text-xs font-mono text-dim uppercase tracking-wider hover:border-muted hover:text-ink transition-colors"
                      >
                        retry
                      </button>
                    </>
                  ) : (
                    <span className="text-subtle font-mono text-xs">loading…</span>
                  )}
                </div>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {noPreviewBlur && (
                    <span
                      aria-hidden
                      className="absolute inset-0 bg-cover bg-center pointer-events-none"
                      style={{ backgroundImage: `url(${noPreviewBlur})` }}
                    />
                  )}
                  <span className="relative text-line font-mono text-xs">no preview</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right: details — scrolls within grid cell on desktop */}
        <div className="flex flex-col md:min-h-0 md:overflow-y-auto">

          {/* Info: title, creator, description, comments, textarea */}
          <div className="px-5 py-4 flex flex-col gap-3">
            <div className="flex items-start justify-between gap-4">
              <h1 className="text-sm font-mono text-ink leading-snug">
                {inOverlay ? (
                  // Hard-nav anchor (not <Link>) so the click bypasses the
                  // intercepting route at app/@modal/(.)moment and lands on
                  // the canonical full-page detail route instead of just
                  // re-opening the overlay we're already in.
                  <a
                    href={`/moment/${address}/${tokenId}`}
                    title="open full details page"
                    className="hover:text-dim transition-colors"
                  >
                    {meta.name ?? `#${tokenId}`}
                  </a>
                ) : (
                  meta.name ?? `#${tokenId}`
                )}
              </h1>
              <div className="flex items-center gap-3 flex-shrink-0">
                {/* Edit metadata — any address the update-uri backend will
                    authorize: the resolved creator, plus moment co-admins
                    (collection defaultAdmin / authorized creators) surfaced
                    by the on-chain `canEditMeta` read. Pencil expands into a
                    full inline panel below the title to preserve spatial
                    locality (you edit what you're looking at). Share +
                    send moved to a single row beneath the action panel
                    so secondary actions group together visually. */}
                {(isCreator || canEditMeta) && !editing && detail && (
                  <button
                    onClick={openEditor}
                    className="flex items-center gap-1 text-xs font-mono text-muted hover:text-dim transition-colors"
                    title="edit metadata"
                  >
                    <Pencil size={11} />
                    edit
                  </button>
                )}
                {isCreator && detail && (
                  <button
                    onClick={handleToggleHidden}
                    disabled={hidePending}
                    className={`flex items-center gap-1 text-xs font-mono transition-colors disabled:opacity-50 ${
                      isHidden ? 'text-dim hover:text-ink' : 'text-muted hover:text-dim'
                    }`}
                    title={isHidden ? 'Show on public feeds' : 'Hide from public feeds'}
                  >
                    {isHidden ? <Eye size={11} /> : <EyeOff size={11} />}
                    {isHidden ? 'hidden' : 'hide'}
                  </button>
                )}
              </div>
            </div>

            {/* Inline edit panel — pre-populated from the loaded detail.
                Image is optional: if the creator only wants to fix a typo
                in the title or description, they leave the image alone
                and we keep the existing ar:// in the new metadata JSON. */}
            {editing && detail && (
              <div className="flex flex-col gap-3 border border-line p-3 bg-[#0a0a0a]">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-mono uppercase tracking-widest text-dim">edit metadata</p>
                  <button
                    onClick={closeEditor}
                    disabled={savingMeta}
                    className="text-muted hover:text-dim transition-colors disabled:opacity-40"
                    title="cancel"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-muted">title</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    disabled={savingMeta}
                    placeholder="title"
                    className="bg-surface border border-line px-2.5 py-2 text-xs font-mono text-ink placeholder-subtle focus:outline-none focus:border-muted disabled:opacity-50"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-muted">description</label>
                  <textarea
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    disabled={savingMeta}
                    rows={3}
                    placeholder="description"
                    className="bg-surface border border-line px-2.5 py-2 text-xs font-mono text-ink placeholder-subtle focus:outline-none focus:border-muted disabled:opacity-50 resize-y min-h-[3.5rem] overflow-auto"
                  />
                </div>
                {/* Change media — upload a new file, or re-point at content
                    already on Arweave (no re-upload). */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-muted">media (optional)</label>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setMediaMode('upload')}
                      disabled={savingMeta}
                      className={`text-[10px] font-mono uppercase tracking-widest border border-line px-2.5 py-1 disabled:opacity-50 ${mediaMode === 'upload' ? 'text-ink border-muted bg-surface' : 'text-muted hover:text-dim'}`}
                    >
                      upload new
                    </button>
                    <button
                      type="button"
                      onClick={() => setMediaMode('url')}
                      disabled={savingMeta}
                      className={`text-[10px] font-mono uppercase tracking-widest border border-line px-2.5 py-1 disabled:opacity-50 ${mediaMode === 'url' ? 'text-ink border-muted bg-surface' : 'text-muted hover:text-dim'}`}
                    >
                      use existing url
                    </button>
                  </div>
                  {mediaMode === 'upload' ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => mediaInputRef.current?.click()}
                        disabled={savingMeta}
                        className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-dim border border-line px-2.5 py-1.5 disabled:opacity-50"
                      >
                        change media
                      </button>
                      {mediaFile && (
                        <>
                          <span className="text-[10px] font-mono text-dim truncate max-w-[9rem]" title={mediaFile.name}>{mediaFile.name}</span>
                          <button
                            type="button"
                            onClick={clearMedia}
                            disabled={savingMeta}
                            className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-dim disabled:opacity-50"
                          >
                            keep current
                          </button>
                        </>
                      )}
                      <input
                        ref={mediaInputRef}
                        type="file"
                        accept="image/*,video/*,.gif"
                        onChange={handleMediaFile}
                        className="hidden"
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <input
                        type="text"
                        value={existingMediaUrl}
                        onChange={(e) => {
                          const v = e.target.value
                          setExistingMediaUrl(v)
                          const guessed = guessMediaTypeFromUrl(v)
                          if (guessed) setExistingMediaType(guessed)
                        }}
                        disabled={savingMeta}
                        placeholder="ar://… or https://arweave.net/…"
                        className="bg-surface border border-line px-2.5 py-2 text-xs font-mono text-ink placeholder-subtle focus:outline-none focus:border-muted disabled:opacity-50"
                      />
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-mono uppercase tracking-widest text-subtle">type</span>
                        {(['video', 'gif', 'image'] as const).map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setExistingMediaType(t)}
                            disabled={savingMeta}
                            className={`text-[10px] font-mono uppercase tracking-widest border border-line px-2 py-1 disabled:opacity-50 ${existingMediaType === t ? 'text-ink border-muted bg-surface' : 'text-muted hover:text-dim'}`}
                          >
                            {t}
                          </button>
                        ))}
                      </div>
                      <p className="text-[10px] font-mono text-subtle leading-relaxed">
                        re-points to content already on arweave — no re-upload. the cover/poster is kept unless you also change it below.
                      </p>
                    </div>
                  )}
                </div>
                {/* Change cover — replaces only the thumbnail/poster (image or
                    gif), never the main media. */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-muted">cover (optional)</label>
                  <div className="flex items-center gap-2">
                    {/* new cover preview > existing on-chain image > nothing.
                        MomentImg passes a blob URL through unchanged and walks
                        the gateway pool for an ar:// on error. */}
                    {(coverPreview || meta.image) && (
                      <MomentImg
                        src={coverPreview ?? meta.image ?? ''}
                        alt="cover preview"
                        className="w-12 h-12 object-cover bg-surface border border-line"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => coverInputRef.current?.click()}
                      disabled={savingMeta}
                      className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-dim border border-line px-2.5 py-1.5 disabled:opacity-50"
                    >
                      {coverFile ? 'replace' : 'change cover'}
                    </button>
                    {coverFile && (
                      <button
                        type="button"
                        onClick={clearCover}
                        disabled={savingMeta}
                        className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-dim disabled:opacity-50"
                      >
                        keep current
                      </button>
                    )}
                    <input
                      ref={coverInputRef}
                      type="file"
                      accept="image/*,.gif"
                      onChange={handleCoverFile}
                      className="hidden"
                    />
                  </div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveMetadata}
                    disabled={savingMeta || !editName.trim()}
                    className="flex-1 text-xs font-mono tracking-wider uppercase py-2 btn-accent disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {savingMeta ? 'saving…' : 'save changes'}
                  </button>
                  <button
                    onClick={closeEditor}
                    disabled={savingMeta}
                    className="text-xs font-mono tracking-wider uppercase px-3 py-2 border border-line text-muted hover:border-muted hover:text-dim transition-colors disabled:opacity-40"
                  >
                    cancel
                  </button>
                </div>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <Link
                href={creatorAddress ? `/profile/${creatorAddress}` : '#'}
                className="flex items-center gap-2 group"
              >
                {creatorAddress && (
                  <ProfileAvatar address={creatorAddress} avatarUrl={creatorAvatar} size={22} />
                )}
                <span className="text-xs font-mono text-muted group-hover:text-dim transition-colors">
                  {creatorName || shortAddress(creatorAddress)}
                </span>
              </Link>
              {creatorAddress && <CopyAddress address={creatorAddress} size={11} />}
            </div>
            {collectionName && (
              <Link
                href={`/collection/${address}`}
                className="flex items-center gap-2 group w-fit"
              >
                {collectionImage && !collectionImageFailed && (
                  <div className="w-[22px] h-[22px] relative flex-shrink-0 bg-raised overflow-hidden">
                    <MomentImage
                      src={collectionImage}
                      alt=""
                      fill
                      className="object-cover"
                      sizes="22px"
                      onAllError={() => setCollectionImageFailed(true)}
                    />
                  </div>
                )}
                <span className="text-xs font-mono text-muted group-hover:text-dim transition-colors">
                  {collectionName}
                </span>
              </Link>
            )}
            {meta.description && (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10px] font-mono text-subtle uppercase tracking-wider">description</p>
                <p
                  ref={descRef}
                  className={`text-xs font-mono text-dim leading-relaxed ${showFullDesc ? '' : 'line-clamp-4'}`}
                >
                  {meta.description}
                </p>
                {(descOverflows || showFullDesc) && (
                  <button
                    onClick={() => setShowFullDesc(v => !v)}
                    className="flex items-center gap-1 text-[10px] font-mono text-muted hover:text-dim transition-colors w-fit"
                  >
                    {showFullDesc ? <><ChevronUp size={10} /> show less</> : <><ChevronDown size={10} /> show more</>}
                  </button>
                )}
              </div>
            )}
            {hasSplits && <SplitsPanel recipients={splitRecipients} />}
            {!commentsLoading && comments.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[10px] font-mono text-subtle uppercase tracking-wider">activity</p>
                <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
                  {comments.map((c) => {
                    const profile = commentSenderProfiles[c.sender.toLowerCase()]
                    const displayName = profile?.name ?? shortAddress(c.sender)
                    // Airdrop rows are gifts the recipient didn't buy. The
                    // comments route already stamped the right label into
                    // `comment` per collection — "invited to kismet" for the
                    // patron/mint-pass collection, "airdropped on kismet"
                    // otherwise — so just render it. `sender` is the recipient.
                    const isAirdrop = c.kind === 'airdrop'
                    const isDefault = isPlatformCollectComment(c.comment)
                    return (
                      <div key={activityRowKey(c)} className="flex gap-2 items-center">
                        <Link href={`/profile/${c.sender}`} className="flex-shrink-0">
                          <ProfileAvatar
                            address={c.sender}
                            avatarUrl={profile?.avatarUrl}
                            size={20}
                            clickable
                          />
                        </Link>
                        <Link
                          href={`/profile/${c.sender}`}
                          className="text-[11px] font-mono text-muted flex-shrink-0 hover:text-dim transition-colors"
                        >
                          {displayName}
                        </Link>
                        <span className="text-xs font-mono text-dim flex-1 break-words leading-relaxed">
                          {isAirdrop
                            ? c.comment
                            : isDefault
                              ? 'collected on kismet'
                              : c.comment}
                        </span>
                        <span className="text-[10px] font-mono text-subtle flex-shrink-0">
                          {formatRelativeTime(c.timestamp)}
                        </span>
                      </div>
                    )
                  })}
                  {hasMoreComments && (
                    <button
                      type="button"
                      onClick={() => void loadMoreComments()}
                      disabled={loadingMoreComments}
                      className="mt-1 self-center text-[10px] font-mono text-muted hover:text-dim transition-colors disabled:opacity-50"
                    >
                      {loadingMoreComments ? 'loading…' : 'load more'}
                    </button>
                  )}
                </div>
              </div>
            )}
            {/* Comment goes with the collect — hide the textarea once the
                token is minted out, since there's no further collect to
                attach the comment to. */}
            {!mintedOut && (
              <textarea
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                placeholder="leave a comment… (optional)"
                rows={2}
                disabled={collecting}
                className="w-full bg-surface border border-line px-3 py-2 text-xs text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted resize-none disabled:opacity-50"
              />
            )}
          </div>

          {/* Spacer — pushes bottom group down when content is short */}
          <div className="flex-1 min-h-6" />

          {/* Distribute earnings — shown to anyone who can distribute.
              Distributing pays every recipient at once (0xSplits is
              all-or-nothing), so the figures show the full pending balance
              plus the viewer's cut. */}
          {canDistribute && (
            <div className="px-5 pb-4 flex flex-col gap-2">
              <p className="text-[10px] font-mono text-subtle uppercase tracking-wider">
                distribute earnings
                {adminDistributeOverride && <span className="text-accent"> · admin override</span>}
              </p>
              {pendingFormatted !== undefined && (
                <p className="text-[11px] font-mono text-dim">
                  {hasPending ? `${pendingFormatted} to distribute` : 'nothing to distribute yet'}
                  {pendingShareFormatted && hasPending && (
                    <span className="text-muted"> · your share ≈ {pendingShareFormatted}</span>
                  )}
                </p>
              )}
              <button
                onClick={handleDistribute}
                disabled={distributing || !splitAddress || !hasPending}
                className="text-xs font-mono px-3 py-2 border border-line text-muted hover:border-muted hover:text-ink transition-colors disabled:opacity-40"
              >
                {distributing
                  ? 'distributing…'
                  : !splitAddress || pendingFormatted === undefined
                    ? 'loading…'
                    : hasPending
                      ? 'distribute'
                      : 'nothing to distribute'}
              </button>
              {distributeHash && (
                <a
                  href={`https://basescan.org/tx/${distributeHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-muted hover:text-dim"
                >
                  distributed: {distributeHash.slice(0, 10)}…{distributeHash.slice(-8)}
                </a>
              )}
            </div>
          )}

          {/* Mints line — "sold" for paid mints, "collected" for free
              mints (and as the default while detail is still loading,
              since "collected" is the broader truthful term). Owned
              count sits next to it when the viewer holds any. */}
          <div className="px-5 pb-2 flex items-center gap-3">
            {totalMinted !== undefined && (
              <>
                <p className="text-[10px] font-mono text-subtle uppercase tracking-widest">
                  {Number(totalMinted).toLocaleString()}{' '}
                  {saleConfig && BigInt(saleConfig.pricePerToken) > 0n ? 'sold' : 'collected'}
                </p>
                {ownedCount > 0 && (
                  <p className="text-[10px] font-mono text-muted uppercase tracking-widest">
                    ×{ownedCount} own
                  </p>
                )}
              </>
            )}
            {/* Mobile / mini-app: scan / share / send hug the RIGHT edge of the
                "x sold" row (ml-auto), ordered send → scan → share via the
                fragment's responsive order. Desktop shows them in the controls
                band below the price, so they're sm:hidden here. Rendered outside
                the totalMinted gate so the actions never wait on the on-chain
                supply read. */}
            <div className="ml-auto flex items-center gap-3 sm:hidden">
              {secondaryActionButtons}
            </div>
          </div>

          {/* Action row: [price|supply] [list] [collect] */}
          <div className="px-5 py-4 flex gap-2 items-stretch">
            {priceSupplyBox}
            {alreadyOwned && (
              <div className="flex-1 min-w-0">
                <ListButton
                  collectionAddress={address}
                  tokenId={tokenId}
                  name={meta.name}
                  image={meta.image ? resolveUri(meta.image) : undefined}
                  creatorAddress={creatorAddress}
                  contentUri={meta.content?.uri}
                  contentMime={meta.content?.mime}
                />
              </div>
            )}
            <button
              onClick={handleCollect}
              disabled={collecting || mintedOut || !detail || saleNotStarted || saleEnded}
              className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase border transition-colors ${collecting ? 'cursor-not-allowed' : ''} ${
                soldOutUncollected
                  ? 'accent-grad border-line'
                  : hasCollected
                    ? 'text-accent bg-accent/10 border-accent hover:bg-accent/20 disabled:opacity-50'
                    : 'text-muted border-line accent-grad-hover disabled:opacity-50'
              }`}
            >
              {collectLabel}
            </button>
          </div>

          {/* Mobile / mini-app: sale-window date centered under the action row.
              Its own full-width centered line — the detail label (date + time +
              zone) is too long to sit under the collect column alone on a phone,
              so it centers across the whole row. Desktop centers the date under
              the collect button in the utility row (below), so this line is
              mobile-only. Gated on showSaleWindowRow so nothing shows for a live
              open-ended sale. */}
          {showSaleWindowRow && (
            <div className="px-5 pt-1 pb-3 flex justify-center sm:hidden">
              <SaleWindow saleConfig={detail?.saleConfig} variant="detail" />
            </div>
          )}

          {/* Utility row — flex-col, so gap spans only rendered rows (a hidden
              desktop line reserves nothing on mobile).
              • Desktop: scan / share / send on the left, the sale date CENTERED
                UNDER THE COLLECT BUTTON — the line mirrors the action row's
                columns ([price-box width] [list flex-1 when owned] [flex-1]),
                still one line, so no empty band around the date.
              • Feature toggle: admin-only, demoted to its own line directly
                beneath the button group.
              • Send form: armed on DESKTOP it sits inline in the utility row,
                between the send button and the date (the empty list-mirror
                column); on mobile it drops in full-width below the row.
              On mobile the buttons live in the "x sold" row and the date in its
              own line above, so this row carries only feature (admin) + the form. */}
          <div className="px-5 pb-4 flex flex-col gap-2">
            {/* flex-wrap: the nowrap date label is ~228px — wider than the whole
                collect column on the narrowest md panels (info column is ~368px
                at a 768px viewport). Wrapping lets the date column drop to its
                own full-width centered line exactly when it can't fit beside the
                buttons (panel ≲ 425px), instead of overflowing the panel edge /
                overlapping the send button. At every wider width the row lays
                out single-line and the wrap is inert. */}
            <div className="hidden flex-wrap items-center gap-2 sm:flex">
              {/* Column 1 = the action row's price|supply column, by construction:
                  a grid-stacked invisible copy of the box (h-0 → contributes its
                  exact width but NO height) with the buttons in the same cell
                  (w-0 → contribute height but no width). Cell = box width ×
                  buttons height, so the columns align without a hardcoded width
                  and the row stays button-height. Buttons overflow the cell
                  rightward into the empty spacer beside it; `relative` keeps
                  those tails painted above (and clickable over) the spacer.
                  EXCEPT while the send form is armed: the form occupies that
                  spacer column, so the buttons keep their natural width (no
                  w-0) and the cell grows to hold them — the tail would
                  otherwise paint over (and steal clicks from) the input's left
                  edge. Cost: the date drifts ~20px right of collect center
                  while the form is open. */}
              <div className="grid flex-none">
                <div aria-hidden className="invisible col-start-1 row-start-1 h-0 overflow-hidden">
                  {priceSupplyBox}
                </div>
                <div className={`relative col-start-1 row-start-1 flex items-center gap-3 ${sendOpen ? '' : 'w-0'}`}>
                  {secondaryActionButtons}
                </div>
              </div>
              {/* List-mirror column: an empty spacer normally; the send form
                  when armed — sitting exactly between the send button and the
                  sale date. min-w-[12rem] floors the input at a usable width:
                  on panels too narrow to hold buttons + form + date in one
                  line, the DATE (whose min-content exceeds its flex share
                  first) wraps to its own centered line via the row's existing
                  flex-wrap fallback instead of the input crushing to ~40px. */}
              {alreadyOwned &&
                (sendOpen ? (
                  <div className="flex-1 min-w-[12rem]">{sendForm}</div>
                ) : (
                  <div aria-hidden className="flex-1" />
                ))}
              {showSaleWindowRow && (
                <div className="flex-1 flex justify-center">
                  <SaleWindow saleConfig={detail?.saleConfig} variant="detail" />
                </div>
              )}
            </div>
            {isAdmin && (
              <button
                onClick={() => toggleFeatured(address, tokenId)}
                className={`flex items-center gap-1.5 text-xs font-mono transition-colors w-fit ${
                  isFeatured ? 'text-yellow-400' : 'text-muted hover:text-dim'
                }`}
              >
                <Star size={12} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
                {isFeatured ? 'unfeature' : 'feature'}
              </button>
            )}
            {/* Mobile-only: the armed form full-width below the row (desktop
                shows it inline in the utility row above). */}
            {alreadyOwned && sendOpen && <div className="sm:hidden">{sendForm}</div>}
          </div>

        </div>
      </div>

      {/* Lightbox */}
      {lightboxOpen && (
        <div
          className="fixed inset-0 z-[200] bg-black/95 flex items-center justify-center"
          onClick={() => setLightboxOpen(false)}
        >
          <button
            onClick={() => setLightboxOpen(false)}
            className="absolute top-4 right-4 z-10 p-2 text-dim hover:text-ink transition-colors"
          >
            <X size={18} />
          </button>
          {/* Image-only lightbox. Videos don't open the lightbox — the
              cursor-zoom-in affordance above is gated on `!isVideo` and
              videos already expose native fullscreen via the controls. */}
          {media.src && (
            <MomentImg
              src={media.src}
              alt={meta.name ?? 'artwork'}
              className="max-h-[95vh] max-w-[95vw] object-contain"
              onClick={(e) => e.stopPropagation()}
              // MomentImg defaults to loading="lazy"; the lightbox
              // mounts already-visible so we need eager.
              priority
            />
          )}
        </div>
      )}
    </div>
  )
}
