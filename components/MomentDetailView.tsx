'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount, usePublicClient, useReadContract, useSignMessage, useWriteContract } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { toast } from 'sonner'
import { ArrowLeft, Copy, Check, ChevronDown, ChevronUp, Star, X, Pencil, Eye, EyeOff, Send, Square, Clock, Paperclip } from 'lucide-react'
import { isAddress } from 'viem'
import { normalize } from 'viem/ens'
import { useQueryClient } from '@tanstack/react-query'
import { resolveUri, formatPrice, shortAddress, inferCollectCurrency, DEFAULT_COLLECT_COMMENT, getSaleWindow, parseRealSaleEnd, type MomentDetail } from '@/lib/inprocess'
import { isPatronCollection } from '@/lib/patronCollection'
import { GiftRecipientForm } from './GiftRecipientForm'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { resolveMomentCreator } from '@/lib/statsMath'
import { fetchCollectionChip } from '@/lib/collectionCache'
import { useTextContent } from '@/lib/textCache'
import { getCachedDetail, setCachedDetail } from '@/lib/momentCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '@/lib/zoraMint'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useComment } from '@/hooks/useComment'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { usePendingAction } from '@/hooks/usePendingAction'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useMomentSplits } from '@/hooks/useMomentSplits'
import { useMomentEditPermission, useMomentSaleEditPermission } from '@/hooks/useMomentEditPermission'
import { useUpdateMomentSale } from '@/hooks/useUpdateMomentSale'
import type { WindowFieldEdit } from '@/lib/saleEdit'
import type { OnchainSaleConfig } from '@/lib/saleConfig'
import { toLocalInput, parseLocalInputSec } from '@/lib/datetimeLocal'
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
import { CollectedActions } from './CollectedActions'
import { CollectorFileCard } from './CollectorFileCard'
import { CollectorFileManagePanel } from './CollectorFileManagePanel'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import type { CfilePublic } from '@/lib/collectorFileTypes'
import { RaffleAdminPanel } from './RaffleAdminPanel'
import { SaleWindow } from './SaleWindow'
import { RaffleCallout } from './RaffleCallout'
import { MomentImage, MomentImg } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { resolveMomentMedia } from '@/lib/media/resolveMomentMedia'
import { normalizeMediaUrl, guessMediaTypeFromUrl } from '@/lib/media/normalizeMediaUrl'
import { ProfileAvatar } from './ProfileAvatar'
import { CopyAddress } from './CopyAddress'
import { SplitsPanel } from './SplitsPanel'
import { MomentActivity } from './MomentActivity'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError, TERMINAL_TOAST_DURATION_MS } from '@/lib/toast'
import { composeMomentShareCast } from '@/lib/collectShare'
import { pickFirstNonOperatorAdmin } from '@/lib/momentAuthz'
import { useFarcaster } from '@/providers/FarcasterProvider'

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
  // SSR-hydrated collector-file descriptor (public facts only — never the
  // storage pointer). undefined = unknown (overlay mount) and the card
  // fetches its own status; null = known-absent, which lets the card skip
  // that fetch entirely on the hot anonymous path.
  initialCfile?: CfilePublic | null
  // This token's live secondary listing (the page's React-cached
  // getActiveListing) — informs the card's sold-out state. undefined =
  // unknown (overlay), null = none listed.
  initialListing?: { price: string; currency: 'eth' | 'usdc' } | null
}

export function MomentDetailView({ address, tokenId, initialDetail, fallbackMeta, initialCollectionMeta, kvCreatorAddress, initialTextContent, inOverlay, ssrWebKit, initialCfile, initialListing }: Props) {
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
  const { isAdmin, featuredKeys, toggleFeatured, raffleEnabledKeys } = useAdmin()
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
  // Paging, rows, and sender-profile resolution for the activity panel all
  // live in MomentActivity (render-isolated — see its header). The one
  // parent→child signal is this nonce: bumped after a collect / on-chain
  // comment to force the panel's page-0 refresh once In Process has indexed.
  const [activityRefreshNonce, setActivityRefreshNonce] = useState(0)
  const [commentText, setCommentText] = useState('')
  const [collected, setCollected] = useState(false)
  const { collect, status: collectStatus } = useDirectCollect()
  const collecting = collectStatus !== 'idle' && collectStatus !== 'done' && collectStatus !== 'error'
  // On-chain comment (Zora Comments contract) — the post-collect path for
  // holders. Separate from `commentText`, which rides a collect tx.
  const { submitComment, status: commentStatus } = useComment()
  const commenting = commentStatus !== 'idle' && commentStatus !== 'done' && commentStatus !== 'error'
  const [onchainComment, setOnchainComment] = useState('')
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
  // Edit-sale flow: visible only to holders of the on-chain ADMIN|SALES bits
  // (a different gate than the metadata pencil — see useMomentSaleEditPermission).
  // Inputs are datetime-local strings; the dirty flags distinguish "untouched
  // prefill" (keep the on-chain value exactly) from "cleared" (open now /
  // never expires) — the prefill is minute-granular, so parsing it back would
  // drift by the dropped seconds and misread a no-op as an edit.
  const [editingSale, setEditingSale] = useState(false)
  // Collector-file state: the page card's descriptor (SSR-hydrated, panel
  // writes reflect into it) + whether the artist's manage panel is open —
  // a third inline panel alongside editing/editingSale, same mutual
  // exclusion so an open draft is never silently discarded.
  const [cfile, setCfile] = useState<CfilePublic | null>(initialCfile ?? null)
  const [managingFile, setManagingFile] = useState(false)
  const [saleStartInput, setSaleStartInput] = useState('')
  const [saleEndInput, setSaleEndInput] = useState('')
  const [saleStartDirty, setSaleStartDirty] = useState(false)
  const [saleEndDirty, setSaleEndDirty] = useState(false)
  const [savingSale, setSavingSale] = useState(false)
  // Two-tap confirm for "end sale now" — closing a live sale is the one
  // destructive action in the panel, so the first tap only arms it.
  const [endSaleArmed, setEndSaleArmed] = useState(false)
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
  // Pass pieces: sending is self-revocation (any-transfer-revokes — the gate
  // decrements the sender and the recipient's copy proves nothing, see
  // lib/pass-validity.processTransfer), and this button is the one in-app
  // route to it with no warning. First confirm tap ARMS instead of sending —
  // the endSaleArmed pattern — so the consequence is on screen before the
  // irreversible tx. Trigger is the static Patron check, consistent with
  // every other Patron special-case in this file; it tracks the configured
  // gate collection's production value alongside those statics.
  const isPassPiece = isPatronCollection(address)
  const [sendArmed, setSendArmed] = useState(false)
  // Collect-and-gift: same mint, `mintTo` pointed at someone else (see
  // lib/gift.ts). Surfaced HERE and on the Patron showcase only — cards and
  // the market swipe UI all link to this page, so gifting stays one tap away
  // everywhere without adding a second CTA to the collect funnel.
  const [giftOpen, setGiftOpen] = useState(false)
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
    // Pass piece: the first tap only arms. The warning line rendered by
    // sendForm (keyed on sendArmed) states what the second tap will cost.
    if (isPassPiece && !sendArmed) {
      setSendArmed(true)
      return
    }
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
      setSendArmed(false)
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
  // Sale-window edit authorization — the ADMIN|SALES twin of canEditMeta,
  // mirroring the exact bits Zora's callSale enforces. Deliberately NO
  // `skip: isCreator` shortcut (unlike the metadata pencil): update-uri has a
  // server preflight that turns an unauthorized creator into a clean 403, but
  // a sale edit is a direct wallet write whose only backstop is a gas-
  // estimation revert — so the affordance must not outrun the on-chain read.
  // A resolved creator without the bits (e.g. a MINTER-only grant in someone
  // else's collection) correctly sees no button instead of a wallet error.
  const canEditSale = useMomentSaleEditPermission(address, tokenId)
  const { updateWindow: updateSaleWindow, endNow: endSaleNow } = useUpdateMomentSale()
  const queryClient = useQueryClient()

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
    splitAddresses,
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

  async function handlePostComment() {
    const text = onchainComment.trim()
    if (!text) return
    const result = await submitComment({
      collectionAddress: address as `0x${string}`,
      tokenId,
      text,
    })
    if (result) {
      setOnchainComment('')
      // Give In Process a moment to index the Commented event, then have the
      // activity panel refresh so the new comment appears (same force-refresh
      // the collect path uses; the panel's 60s cache expiry backstops it if
      // indexing runs long).
      setTimeout(() => setActivityRefreshNonce((n) => n + 1), 5000)
    }
  }

  // `recipient` set = gift (mint straight to them, signer pays); unset = the
  // ordinary collect every existing caller runs.
  async function handleCollect(recipient?: `0x${string}`) {
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
      armPendingAction(() => { void handleCollect(recipient) })
      return
    }
    // No price passed — the hook reads the live sale on-chain (authoritative).
    const result = await collect({
      collectionAddress: address as `0x${string}`,
      tokenId,
      amount: 1,
      comment: commentText.trim() || DEFAULT_COLLECT_COMMENT,
      ...(recipient ? { recipient } : {}),
      // Post-collect share prompt (Mini App only — the hook gates; also
      // ignored for gifts, whose toast names the recipient instead).
      // creatorName is the display fallback; the share flow re-resolves the
      // creator's raw FC username for a real @mention (see lib/collectShare).
      share: {
        momentName: detail.metadata?.name ?? null,
        creatorAddress: creatorAddress || null,
        creatorName,
      },
      // Names the included download in the success toast — the moment of
      // maximum delight should say the perk arrived (design §8.1).
      ...(cfile ? { successDescription: 'Your download is ready below.' } : {}),
    })
    if (result && recipient) {
      // A gift is NOT a collect for the signer: they hold nothing, so the
      // owned/collected state must not flip (setCollected would surface the
      // owned-edition actions for an edition they don't have). Supply and
      // activity did move on-chain, so those refresh as usual.
      setGiftOpen(false)
      setTimeout(() => setActivityRefreshNonce((n) => n + 1), 3000)
      refetchTokenInfo().catch(() => {})
      return
    }
    if (result) {
      setCollected(true)
      setCommentText('')
      // Collect success gets the same native haptic the mint/follow/raffle
      // successes already fire (pre-gated per lib/farcasterHaptics's contract).
      if (isInMiniApp) hapticNotifySuccess()
      // Have the activity panel force past its cache so the just-added
      // comment lands (and its pagination resets to the newest page); 3s
      // lets inprocess index the collect.
      setTimeout(() => setActivityRefreshNonce((n) => n + 1), 3000)
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
  // the SOLD OUT label keeps its gradient letters with no disabled dimming (a
  // statement, not a greyed-out control); the price stays the quiet subtle
  // tier. A collected viewer's sold-out state takes the normal dimmed path.
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
    // The hook settles every funded (payout target × currency) pot itself —
    // the moment's sale currency is no longer the selector, because a split
    // can hold the other currency too and a moment has two payout pointers.
    await distribute()
  }

  // In a Mini App, share = open the Farcaster cast composer prefilled with the
  // moment-page copy — "<title>" by @creator (no "on @kismet" tail; the cast
  // already posts to /kismet, so the channel mention would be redundant) —
  // plus the moment embed, posted to /kismet (see lib/collectShare). On the
  // web, share = copy-to-clipboard (no host composer to call). The Mini App
  // path falls through to copy if the SDK throws so the button never becomes a
  // dead click.
  async function handleShare() {
    const url = `${window.location.origin}/artwork/${address}/${tokenId}`
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
          { titleLead: true },
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
    setEditingSale(false) // one inline panel at a time
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

  // Pre-populate the sale editor from the displayed saleConfig: a SCHEDULED
  // start prefills its date (an already-open sale shows an empty "opens" —
  // there is nothing scheduled to show), a REAL close date prefills, and an
  // open-ended sale shows an empty "closes" (= never expires). parseRealSaleEnd
  // is the shared classifier, so the prefill can't disagree with the SaleWindow
  // pill about which sales have a real deadline.
  function openSaleEditor() {
    if (!detail || !saleConfig) return
    const nowSec = Math.floor(Date.now() / 1000)
    const startNum = saleConfig.saleStart ? Number(saleConfig.saleStart) : 0
    const realEnd = parseRealSaleEnd(saleConfig.saleEnd)
    // prefill guards: a hand-crafted on-chain row can hold a "real" (sub-
    // sentinel) instant past JS Date range (~year 275760); toLocalInput on an
    // Invalid Date would prefill NaN garbage. Such fields prefill empty and
    // stay 'keep' (untouched ≠ dirty), so the bogus value is never rewritten.
    const startDate = new Date(startNum * 1000)
    setSaleStartInput(
      Number.isFinite(startNum) && startNum > nowSec && !Number.isNaN(startDate.getTime())
        ? toLocalInput(startDate)
        : '',
    )
    const endDate = realEnd !== null ? new Date(realEnd * 1000) : null
    setSaleEndInput(endDate && !Number.isNaN(endDate.getTime()) ? toLocalInput(endDate) : '')
    setSaleStartDirty(false)
    setSaleEndDirty(false)
    setEndSaleArmed(false)
    setEditing(false) // one inline panel at a time
    setEditingSale(true)
  }

  function closeSaleEditor() {
    setEndSaleArmed(false)
    setEditingSale(false)
  }

  // Post-edit propagation — the receipt is on-chain truth, so reflect it
  // everywhere the old window could linger:
  //  1. optimistic detail swap (this page + the no-TTL client detail LRU,
  //     which the refetch effect early-returns on);
  //  2. react-query price cache (feed cards' useMomentSale entry);
  //  3. fire-and-forget server re-sync of the Redis sale indexes from chain
  //     (ending-soon / free feeds — browse-time write-through would otherwise
  //     only converge when someone next browses this token).
  // Collect correctness needs none of this: useDirectCollect re-reads chain
  // at click time. Everything here is display freshness.
  function applySaleOutcome(config: OnchainSaleConfig) {
    if (detail) {
      const optimistic: MomentDetail = { ...detail, saleConfig: config }
      setCachedDetail(address, tokenId, optimistic)
      setDetail(optimistic)
    }
    queryClient.invalidateQueries({
      queryKey: ['moment-sale', `${address.toLowerCase()}:${tokenId}`],
    })
    void fetch('/api/moment/sale-refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collectionAddress: address, tokenId }),
    }).catch(() => {})
  }

  async function handleSaveSale() {
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    if (!detail || !saleConfig || savingSale) return
    // Dirty-flag mapping: untouched → keep the on-chain value exactly;
    // cleared → the field's open semantics; typed → the picked instant.
    let start: WindowFieldEdit = { kind: 'keep' }
    if (saleStartDirty) {
      if (!saleStartInput) {
        start = { kind: 'clear' }
      } else {
        const sec = parseLocalInputSec(saleStartInput)
        if (sec === null) { toast.error('Invalid sale start'); return }
        start = { kind: 'set', sec }
      }
    }
    let end: WindowFieldEdit = { kind: 'keep' }
    if (saleEndDirty) {
      if (!saleEndInput) {
        end = { kind: 'clear' }
      } else {
        const sec = parseLocalInputSec(saleEndInput)
        if (sec === null) { toast.error('Invalid sale end'); return }
        end = { kind: 'set', sec }
      }
    }
    setSavingSale(true)
    try {
      toast.loading('Confirm in wallet…', { id: 'edit-sale' })
      const outcome = await updateSaleWindow({
        collection: address as `0x${string}`,
        tokenId: BigInt(tokenId),
        start,
        end,
        onTxSubmitted: () => toast.loading('Updating sale…', { id: 'edit-sale' }),
      })
      if (outcome.status === 'unchanged') {
        toast.success('Sale unchanged', { id: 'edit-sale' })
      } else {
        applySaleOutcome(outcome.config)
        toast.success('Sale updated', { id: 'edit-sale' })
      }
      closeSaleEditor()
    } catch (err) {
      toastError('Sale update', err, { id: 'edit-sale' })
    } finally {
      setSavingSale(false)
    }
  }

  async function handleEndSaleNow() {
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    if (!detail || !saleConfig || savingSale) return
    if (!endSaleArmed) { setEndSaleArmed(true); return }
    setSavingSale(true)
    try {
      toast.loading('Confirm in wallet…', { id: 'edit-sale' })
      const outcome = await endSaleNow({
        collection: address as `0x${string}`,
        tokenId: BigInt(tokenId),
        onTxSubmitted: () => toast.loading('Ending sale…', { id: 'edit-sale' }),
      })
      if (outcome.status === 'updated') applySaleOutcome(outcome.config)
      toast.success('Sale ended', { id: 'edit-sale' })
      closeSaleEditor()
    } catch (err) {
      toastError('End sale', err, { id: 'edit-sale' })
    } finally {
      setSavingSale(false)
      setEndSaleArmed(false)
    }
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
          onClick={() => { setSendOpen((v) => !v); setSendArmed(false) }}
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
  //
  // A live raffle also claims this slot (RaffleCallout replaces the date with
  // "Collect to enter raffle …"), so the row must render for raffle-enabled
  // artworks even when the sale is open-ended and there'd be no date. The set
  // is synchronous (loaded once by AdminContext), so no extra request here.
  const hasRaffle = raffleEnabledKeys.has(`${address.toLowerCase()}:${tokenId}`)
  const showSaleWindowRow =
    mounted && (getSaleWindow(detail?.saleConfig)?.atSec != null || hasRaffle)

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
          onChange={(e) => { setSendTo(e.target.value); setSendArmed(false) }}
          placeholder="0x address or name.eth"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          className="flex-1 min-w-0 bg-surface border border-line px-3 py-2 text-xs font-mono text-ink placeholder-subtle focus:outline-none focus:border-muted"
        />
        <button
          onClick={handleSend}
          disabled={!sendToValid || sending}
          className={`flex-none px-4 py-2 text-xs font-mono tracking-wider uppercase border transition-colors disabled:opacity-50 ${
            sendArmed
              ? 'border-red-400/60 text-red-400'
              : 'border-line text-muted accent-grad-hover'
          }`}
        >
          {sending ? '…' : sendArmed ? 'confirm send' : isPassPiece ? 'send…' : 'confirm'}
        </button>
      </div>
      {/* Pass-piece consequence, in the Ruleset's own terms ("Transfer the
          artwork to another wallet" is listed invalid). Always visible while
          the form is open — armed state sharpens it to the second-tap ask. */}
      {isPassPiece && (
        <p className={`mt-1.5 text-[10px] font-mono leading-relaxed ${sendArmed ? 'text-red-400' : 'text-muted'}`}>
          {sendArmed
            ? 'press confirm to send — this pass will no longer be valid for minting, for you or the recipient'
            : 'sending a pass invalidates it for minting — yours ends, and it does not transfer to the recipient'}
        </p>
      )}
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
        <span className="text-[11px] font-mono text-subtle">{price ?? '…'}</span>
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
                  // intercepting route at app/@modal/(.)artwork and lands on
                  // the canonical full-page detail route instead of just
                  // re-opening the overlay we're already in.
                  <a
                    href={`/artwork/${address}/${tokenId}`}
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
                {(isCreator || canEditMeta) && !editing && !editingSale && !managingFile && detail && (
                  <button
                    onClick={openEditor}
                    className="flex items-center gap-1 text-xs font-mono text-muted hover:text-dim transition-colors"
                    title="edit metadata"
                  >
                    <Pencil size={11} />
                    edit
                  </button>
                )}
                {/* Collector-file manager — same authorization as the
                    metadata pencil (the server re-checks the on-chain
                    ADMIN|METADATA bits), but its OWN panel: the metadata
                    editor's save path drags an Arweave wait + a second
                    signature + a chain write, none of which a zip attach
                    needs. Mutually exclusive with the sibling panels. */}
                {(isCreator || canEditMeta) && !editing && !editingSale && !managingFile && detail && (
                  <button
                    onClick={() => setManagingFile(true)}
                    className="flex items-center gap-1 text-xs font-mono text-muted hover:text-dim transition-colors"
                    title="collector download"
                  >
                    <Paperclip size={11} />
                    file
                  </button>
                )}
                {/* Edit sale — gated on the ADMIN|SALES bits (canEditSale),
                    NOT the metadata mask: the two authorizations differ on
                    chain, so the two affordances gate independently. Hidden
                    when there's no sale row to edit (saleConfig null) or the
                    edition is minted out (a window edit can't revive supply). */}
                {/* !editing too: while a metadata draft is open, switching
                    panels would silently discard typed title/description
                    (openEditor re-seeds from detail) — so each affordance
                    hides while the sibling panel is open, and the openers'
                    mutual setX(false) lines stay as defense in depth. */}
                {canEditSale && !editing && !editingSale && !managingFile && detail && saleConfig && !mintedOut && (
                  <button
                    onClick={openSaleEditor}
                    className="flex items-center gap-1 text-xs font-mono text-muted hover:text-dim transition-colors"
                    title="edit sale window"
                  >
                    <Clock size={11} />
                    sale
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

                {/* Discoverability cross-link: artists reach for the pencil to
                    "edit the artwork", so the collector download is offered
                    HERE too — but as a hand-off to its own panel, never as a
                    field of this form: this form's save takes an Arweave
                    propagation wait + a second wallet signature + an on-chain
                    write, none of which a zip attach needs (or should appear
                    to need). Swapping panels is safe — the file panel doesn't
                    touch this draft's title/description state. */}
                <div className="flex items-center justify-between gap-3 border border-line px-3 py-2">
                  <p className="text-[10px] font-mono text-muted min-w-0 truncate">
                    {cfile
                      ? `collector download · ${cfile.name} · v${cfile.v}`
                      : 'collector download · none attached'}
                  </p>
                  <button
                    type="button"
                    disabled={savingMeta}
                    onClick={() => {
                      setEditing(false)
                      setManagingFile(true)
                    }}
                    className="flex-shrink-0 text-[10px] font-mono uppercase tracking-widest text-muted hover:text-dim transition-colors disabled:opacity-50"
                  >
                    {cfile ? 'manage' : 'attach'}
                  </button>
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

            {/* Inline sale editor — the sale-window sibling of the metadata
                panel above (one open at a time; openers close the other).
                Window ONLY: price / per-address cap / payout recipient are
                deliberately read-only here — a price edit would desync the
                frozen mintPrice snapshots on open listings (lib/listings),
                and the payout recipient is the splits contract on split
                artworks. The write carries all of those through unchanged
                (lib/saleEdit). Empty fields read as the open semantics the
                mint form established: no start = open immediately, no close
                = never expires. */}
            {editingSale && detail && saleConfig && (
              <div className="flex flex-col gap-3 border border-line p-3 bg-[#0a0a0a]">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-mono uppercase tracking-widest text-dim">edit sale</p>
                  <button
                    onClick={closeSaleEditor}
                    disabled={savingSale}
                    className="text-muted hover:text-dim transition-colors disabled:opacity-40"
                    title="cancel"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-muted">sale opens</label>
                  <input
                    type="datetime-local"
                    value={saleStartInput}
                    min={toLocalInput(new Date())}
                    onChange={(e) => { setSaleStartInput(e.target.value); setSaleStartDirty(true) }}
                    disabled={savingSale}
                    aria-label="Sale opens"
                    className="bg-surface border border-line px-2.5 py-2 text-xs font-mono text-ink focus:outline-none focus:border-muted disabled:opacity-50 [color-scheme:dark]"
                  />
                  <p className="text-[10px] font-mono text-subtle">
                    {saleStartInput ? 'scheduled start' : 'open immediately'}
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-muted">sale closes</label>
                  <input
                    type="datetime-local"
                    value={saleEndInput}
                    min={saleStartInput || toLocalInput(new Date())}
                    onChange={(e) => { setSaleEndInput(e.target.value); setSaleEndDirty(true) }}
                    disabled={savingSale}
                    aria-label="Sale closes"
                    className="bg-surface border border-line px-2.5 py-2 text-xs font-mono text-ink focus:outline-none focus:border-muted disabled:opacity-50 [color-scheme:dark]"
                  />
                  <p className="text-[10px] font-mono text-subtle">
                    {saleEndInput ? 'closes at this date' : 'never expires'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveSale}
                    disabled={savingSale}
                    className="flex-1 text-xs font-mono tracking-wider uppercase py-2 btn-accent disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {savingSale ? 'saving…' : 'save sale'}
                  </button>
                  {/* Two-tap destructive action: first tap arms, second sends.
                      Disarmed on close so a stale arm can't survive a reopen.
                      Hidden once the sale is already over — "ending" an ended
                      sale would only move its close forward to now, a pure
                      gas-for-nothing tx (reopening is the save path instead). */}
                  {!saleEnded && (
                    <button
                      onClick={handleEndSaleNow}
                      disabled={savingSale}
                      className={`text-xs font-mono tracking-wider uppercase px-3 py-2 border transition-colors disabled:opacity-40 ${
                        endSaleArmed
                          ? 'border-red-400 text-red-400'
                          : 'border-line text-muted hover:border-muted hover:text-dim'
                      }`}
                    >
                      {endSaleArmed ? 'confirm end' : 'end sale now'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Collector-file manage panel — third inline panel, same spatial
                pattern as the metadata/sale editors above. */}
            {managingFile && detail && (
              <CollectorFileManagePanel
                collection={address}
                tokenId={tokenId}
                onClose={() => setManagingFile(false)}
                onFileChange={setCfile}
              />
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
            <MomentActivity address={address} tokenId={tokenId} refreshNonce={activityRefreshNonce} />
            {/* Holders post an on-chain comment (Zora Comments contract) after
                collecting — In Process indexes it into the activity feed above.
                Shown IN PLACE OF the collect-note textarea for holders, so
                there's one comment box, contextual to whether you've collected.
                The contract gates on ownership; costs one spark + gas. */}
            {alreadyOwned && (
              <div className="flex flex-col gap-1.5">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={onchainComment}
                    onChange={(e) => setOnchainComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && onchainComment.trim() && !commenting) {
                        void handlePostComment()
                      }
                    }}
                    placeholder="add a comment…"
                    maxLength={1000}
                    disabled={commenting}
                    className="flex-1 min-w-0 bg-surface border border-line px-3 py-2 text-xs text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={() => void handlePostComment()}
                    disabled={commenting || !onchainComment.trim()}
                    className="flex-none px-4 py-2 text-xs font-mono tracking-wider uppercase border border-line text-muted accent-grad-hover transition-colors disabled:opacity-50"
                  >
                    {commenting ? '…' : 'comment'}
                  </button>
                </div>
                <p className="text-[10px] font-mono text-subtle">onchain comment · you hold this piece</p>
              </div>
            )}
            {/* Comment goes with the collect — hidden once the token is minted
                out (no further collect to attach to) or when the viewer already
                holds it (they use the on-chain comment box above instead). */}
            {!mintedOut && !alreadyOwned && (
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
          {canDistribute && (hasSplits || hasPending) && (
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
                disabled={distributing || !hasPending}
                className="text-xs font-mono px-3 py-2 border border-line text-muted hover:border-muted hover:text-ink transition-colors disabled:opacity-40"
              >
                {distributing
                  ? 'distributing…'
                  : splitAddresses === undefined || pendingFormatted === undefined
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
                <CollectedActions
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
            {/* Gradient on the inner span, not the button box — see
                MomentCard.renderCollectButton (Chromium seam with
                background-clip:text on bordered flex boxes). */}
            <button
              // Explicit zero-arg call: handleCollect's optional param is the
              // GIFT recipient, and a bare onClick={handleCollect} would feed
              // it the MouseEvent.
              onClick={() => void handleCollect()}
              disabled={collecting || mintedOut || !detail || saleNotStarted || saleEnded}
              className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase border transition-colors ${collecting ? 'cursor-not-allowed' : ''} ${
                soldOutUncollected
                  ? 'border-line'
                  : 'accent-grad-hover border-line disabled:opacity-50'
              }`}
            >
              <span className="accent-grad">{collectLabel}</span>
            </button>
            {/* Gift — the same mint aimed at someone else, so it shares the
                collect button's exact availability gates: anything that rules
                out a collect (minted out, window closed) rules out a gift
                identically. Hidden rather than disabled when unavailable —
                a dead "gift" button teaches nothing, unlike the collect
                button whose label explains itself (sold out / not started). */}
            {!mintedOut && !saleNotStarted && !saleEnded && detail && (
              <button
                onClick={() => setGiftOpen((v) => !v)}
                disabled={collecting}
                className="flex-none px-4 py-2.5 text-xs font-mono tracking-wider uppercase border border-line text-muted hover:text-ink transition-colors disabled:opacity-50"
              >
                {giftOpen ? 'cancel' : 'gift'}
              </button>
            )}
          </div>
          {giftOpen && !mintedOut && !saleNotStarted && !saleEnded && (
            <div className="px-5 pb-3">
              <GiftRecipientForm
                signer={connectedAddress ?? null}
                pending={collecting}
                onGift={(recipient) => handleCollect(recipient)}
                onCancel={() => setGiftOpen(false)}
              />
            </div>
          )}

          {/* Collector download card — the perk advertisement for non-holders
              and the download surface for holders. Gated on the OPTIMISTIC
              hasCollected (not alreadyOwned) so it flips the instant a collect
              succeeds instead of waiting out the balanceOf refetch; the
              server-side grace marker makes that first click actually work.
              Renders nothing when no file is attached. */}
          <CollectorFileCard
            collection={address}
            tokenId={tokenId}
            initial={cfile}
            descriptorKnown={initialCfile !== undefined}
            hasCollected={hasCollected}
            soldOut={mintedOut}
            justCollected={collected}
            listing={initialListing}
          />

          {/* Mobile / mini-app: sale-window date centered under the action row.
              Its own full-width centered line — the detail label (date + time +
              zone) is too long to sit under the collect column alone on a phone,
              so it centers across the whole row. Desktop centers the date under
              the collect button in the utility row (below), so this line is
              mobile-only. Gated on showSaleWindowRow so nothing shows for a live
              open-ended sale. */}
          {showSaleWindowRow && (
            <div className="px-5 pt-1 pb-3 flex justify-center sm:hidden">
              <RaffleCallout
                collection={address}
                tokenId={tokenId}
                fallback={<SaleWindow saleConfig={detail?.saleConfig} variant="detail" />}
              />
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
                  <RaffleCallout
                    collection={address}
                    tokenId={tokenId}
                    fallback={<SaleWindow saleConfig={detail?.saleConfig} variant="detail" />}
                  />
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

          {/* Per-moment raffle controls — self-serve for the moment's creator /
              a moment admin / the platform admin (self-hides for anyone else).
              Enabling snapshots the sale end as the entries auto-close time.
              (The feature/unfeature toggle lives in the action toolbar above.) */}
          {(isCreator || isMomentAdmin || isAdmin) && (
            <div className="px-5 pb-4">
              <RaffleAdminPanel
                collection={address}
                tokenId={tokenId}
                canManage
                defaultCloseAt={parseRealSaleEnd(detail?.saleConfig?.saleEnd)}
              />
            </div>
          )}
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
