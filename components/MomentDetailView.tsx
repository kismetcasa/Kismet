'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount, usePublicClient, useReadContract, useSignMessage, useWriteContract } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { ArrowLeft, Copy, Check, ChevronDown, ChevronUp, Star, X, Pencil, Eye, EyeOff, Send } from 'lucide-react'
import { isAddress } from 'viem'
import { resolveUri, formatPrice, shortAddress, formatRelativeTime, inferCollectCurrency, DEFAULT_COLLECT_COMMENT, type MomentDetail, type MomentComment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { fetchCollectionChip } from '@/lib/collectionCache'
import { useTextContent } from '@/lib/textCache'
import { getCachedDetail, setCachedDetail, getCachedComments, setCachedComments } from '@/lib/momentCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_TOKEN_INFO_ABI, isOpenEdition } from '@/lib/zoraMint'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useMomentSplits } from '@/hooks/useMomentSplits'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { extractVideoPoster } from '@/lib/media/extractPoster'
import { proxyUrl } from '@/lib/media/gateway'
import { ListButton } from './ListButton'
import { MomentImage, MomentImg } from './MomentImage'
import { MomentVideo } from './MomentVideo'
import { isVideoMoment } from '@/lib/media/isVideo'
import { ProfileAvatar } from './ProfileAvatar'
import { CopyAddress } from './CopyAddress'
import { SplitsPanel } from './SplitsPanel'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'
import { pickFirstNonOperatorAdmin } from '@/lib/momentAuthz'

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
}

export function MomentDetailView({ address, tokenId, initialDetail, fallbackMeta, initialCollectionMeta, kvCreatorAddress, initialTextContent, inOverlay }: Props) {
  const router = useRouter()
  const { address: connectedAddress, isConnected } = useAccount()

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
  const { openConnectModal } = useConnectModal()
  const { signMessageAsync } = useSignMessage()
  const { isAdmin, featuredKeys, toggleFeatured } = useAdmin()

  const [detail, setDetail] = useState<MomentDetail | null>(
    initialDetail ?? getCachedDetail(address, tokenId) ?? null
  )
  const textContentUri =
    detail?.metadata?.content?.mime === 'text/plain'
      ? detail.metadata.content.uri
      : undefined
  const textContent = useTextContent(textContentUri, initialTextContent)
  const [comments, setComments] = useState<MomentComment[]>(
    () => getCachedComments(address, tokenId) ?? []
  )
  const [commentsLoading, setCommentsLoading] = useState(
    () => getCachedComments(address, tokenId) === undefined
  )
  const [commentSenderNames, setCommentSenderNames] = useState<Record<string, string>>({})
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
      kvCreatorAddress
      ?? initialDetail?.creator?.address
      ?? pickFirstNonOperatorAdmin(initialDetail?.momentAdmins)
      ?? ''
    return initialDetail?.creator?.username || (seedAddr ? shortAddress(seedAddr) : '')
  })
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(undefined)
  const [linkCopied, setLinkCopied] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [showFullDesc, setShowFullDesc] = useState(false)
  const [descOverflows, setDescOverflows] = useState(false)
  const [imgError, setImgError] = useState(false)
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
  const {
    file: editFile,
    preview: editPreview,
    inputRef: editFileInputRef,
    onChange: handleEditFile,
    clear: clearEditFile,
  } = useFileUpload({
    maxBytes: 420 * 1024 * 1024,
    onTooLarge: () => toast.error('File too large', { description: 'Max 420 MB' }),
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
        const resolved = await mainnetClient.getEnsAddress({ name: trimmedSendTo.toLowerCase() })
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
  // Resolution order for the moment's creator EOA:
  //   1. kvCreatorAddress — the EOA mint-proxy wrote to KV moment-meta
  //      at mint time. For Kismet-minted moments inprocess often
  //      reports the platform smart wallet as creator.address (the
  //      on-chain msg.sender of the mint), which has no Kismet
  //      profile and breaks the display-name / avatar / profile-link
  //      chain. KV is authoritative for who actually minted.
  //   2. detail.creator.address — inprocess timeline's dedicated
  //      creator field. Used for moments not minted through Kismet's
  //      proxy (no KV entry) — there inprocess is the only signal.
  //   3. first non-operator entry in detail.momentAdmins — last-resort
  //      fallback. The list is unordered and may contain the operator
  //      smart wallet (filtered out here) or a 0xSplits contract;
  //      kept for moments where neither (1) nor (2) is populated.
  const creatorAddress =
    kvCreatorAddress
    ?? detail?.creator?.address
    ?? pickFirstNonOperatorAdmin(detail?.momentAdmins)
    ?? ''
  const isHidden = detail?.hidden === true
  const [hidePending, setHidePending] = useState(false)
  const isCreator =
    !!connectedAddress &&
    !!creatorAddress &&
    connectedAddress.toLowerCase() === creatorAddress.toLowerCase()

  const { hasSplits, recipients: splitRecipients, splitAddress, distribute, distributing, distributeHash } = useMomentSplits({
    address,
    tokenId,
    isCreator,
  })

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
    const MAX_ATTEMPTS = 12 // 12 × 5s = 60s of polling

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
        setTimeout(tryFetch, 5000)
      }
    }
    tryFetch()
    return () => { cancelled = true }
  }, [address, tokenId, initialDetail])

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

  // Fetch comments — skip if already seeded from shared cache
  const fetchComments = useCallback(async () => {
    if (getCachedComments(address, tokenId)) return
    setCommentsLoading(true)
    try {
      const params = new URLSearchParams({ collectionAddress: address, tokenId, chainId: '8453' })
      const res = await fetch(`/api/moment/comments?${params}`)
      if (res.ok) {
        const data = await res.json()
        const fetched = data.comments ?? []
        setCachedComments(address, tokenId, fetched)
        setComments(fetched)
      }
    } catch {
      // comments are non-critical
    } finally {
      setCommentsLoading(false)
    }
  }, [address, tokenId])

  useEffect(() => { fetchComments() }, [fetchComments])

  // Batch-resolve comment sender display names via shared profile cache
  useEffect(() => {
    if (comments.length === 0) return
    let cancelled = false
    const senders = Array.from(new Set(comments.map((c) => c.sender.toLowerCase())))
    Promise.all(senders.map((a) => fetchCreatorProfile(a))).then((profiles) => {
      if (cancelled) return
      setCommentSenderNames((prev) => {
        const next = { ...prev }
        for (let i = 0; i < senders.length; i++) next[senders[i]] = profiles[i].name
        return next
      })
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
    if (!isConnected || !connectedAddress) { openConnectModal?.(); return }
    if (!detail) return
    const result = await collect({
      collectionAddress: address as `0x${string}`,
      tokenId,
      pricePerToken: BigInt(detail.saleConfig.pricePerToken),
      currency: inferCollectCurrency(detail.saleConfig),
      amount: 1,
      comment: commentText.trim() || DEFAULT_COLLECT_COMMENT,
    })
    if (result) {
      setCollected(true)
      setCommentText('')
      setTimeout(fetchComments, 3000)
      // Refresh on-chain state immediately rather than waiting for the
      // 30s poll — chain state has moved one tick at this point.
      refetchTokenInfo().catch(() => {})
      refetchOwnedBalance().catch(() => {})
    }
  }

  const hasCollected = alreadyOwned || collected
  // Wait for both reads before flagging — otherwise we'd flash "minted out"
  // before tokenInfo lands.
  const mintedOut =
    maxSupply !== undefined &&
    totalMinted !== undefined &&
    !isOpenEdition(maxSupply) &&
    totalMinted >= maxSupply
  const collectLabel = collecting
    ? 'collecting…'
    : mintedOut
      ? hasCollected ? 'collected' : 'minted out'
      : hasCollected ? 'collect+' : 'collect'

  async function handleDistribute() {
    if (!detail) { toast.error('Moment details still loading'); return }
    await distribute(inferCollectCurrency(detail.saleConfig))
  }

  function handleCopyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/moment/${address}/${tokenId}`).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
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
      toast.success(next ? 'Hidden from public feeds' : 'Visible again', { id: 'hide' })
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
    clearEditFile()
    setEditing(true)
  }

  function closeEditor() {
    clearEditFile()
    setEditing(false)
  }

  async function handleSaveMetadata() {
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    if (!detail) return
    if (!editName.trim()) { toast.error('Title required'); return }

    setSavingMeta(true)
    try {
      await ensureSession()

      // Reuse the existing image URI when the creator didn't pick a new
      // file — Arweave is content-addressed so the original ar:// stays
      // valid forever. Preserve the existing thumbhash by default so a
      // name/description-only edit doesn't strip the blur placeholder.
      let imageUri = detail.metadata.image
      let thumbhash = detail.metadata.kismet_thumbhash
      if (editFile) {
        // Picker accepts video/* so the creator can re-upload the
        // moment's source video to fix a broken meta.image — extract
        // the first frame and use that as the cover, never store the
        // video URL itself as the image (same constraint as MintForm).
        let uploadFile: File = editFile
        if (editFile.type.startsWith('video/')) {
          toast.loading('Extracting poster from video…', { id: 'edit-meta' })
          const poster = await extractVideoPoster(editFile)
          if (!poster) {
            throw new Error('Could not extract a poster frame from this video — try uploading an image instead')
          }
          uploadFile = poster
        }
        toast.loading('Uploading image…', { id: 'edit-meta' })
        // Hash and upload in parallel — the encode is bounded by 100px
        // downscale and finishes well before the Arweave POST does, so
        // it's free latency. Falls back to the previous hash on encode
        // failure rather than stripping the placeholder.
        const thumbhashPromise = generateThumbhash(uploadFile)
        imageUri = await uploadToArweave(uploadFile)
        thumbhash = (await thumbhashPromise) ?? thumbhash
      }

      // Build the new metadata JSON. Preserve animation_url + content
      // fields from the existing metadata so video/writing moments keep
      // their media bindings intact when only name/description changed.
      const newMetadata: Record<string, unknown> = {
        name: editName.trim(),
        description: editDesc.trim(),
        ...(imageUri ? { image: imageUri } : {}),
        ...(detail.metadata.animation_url ? { animation_url: detail.metadata.animation_url } : {}),
        ...(detail.metadata.content ? { content: detail.metadata.content } : {}),
        ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
      }

      toast.loading('Uploading metadata…', { id: 'edit-meta' })
      const newUri = await uploadJson(newMetadata)

      // Fail-fast on Arweave propagation lag — same pre-commit gate
      // MintForm uses. Without this, the on-chain URI updates to point
      // at an unpropagated bundle and every viewer (not just the editor)
      // sees broken metadata until the gateway pool catches up. Image
      // budget mirrors MintForm's 90s for large uploads.
      toast.loading('Verifying Arweave propagation…', { id: 'edit-meta' })
      const verifies: Promise<boolean>[] = [verifyArweaveAvailable(newUri)]
      if (editFile && imageUri?.startsWith('ar://')) {
        verifies.push(verifyArweaveAvailable(imageUri, 90_000))
      }
      const [metaOk, imageOk = true] = await Promise.all(verifies)
      if (!metaOk || !imageOk) {
        const failed: string[] = []
        if (!imageOk) failed.push('image')
        if (!metaOk) failed.push('metadata')
        throw new Error(
          `Arweave still settling (${failed.join(' + ')} not yet propagated) — try again in a minute`,
        )
      }

      toast.loading('Sign update in wallet…', { id: 'edit-meta' })
      const nonceRes = await fetch(`/api/profile/${connectedAddress}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce')
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
      if (editFile && imageUri?.startsWith('ar://')) {
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
  const isTextMoment = meta.content?.mime === 'text/plain'
  const isVideo = isVideoMoment(meta)
  // Truthy when there's any media to show — controls the lightbox affordance.
  const hasMedia = !!meta.image || !!(isVideo && meta.animation_url)
  const price = detail
    ? formatPrice(detail.saleConfig.pricePerToken, inferCollectCurrency(detail.saleConfig))
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
          <EyeOff size={20} className="text-[#444]" />
          <p className="text-sm font-mono text-dim">this moment has been hidden by the creator</p>
        </div>
      </div>
    )
  }

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
              className={`relative aspect-square bg-surface ${hasMedia && !isVideo ? 'cursor-zoom-in' : ''}`}
              onClick={() => { if (hasMedia && !isVideo) setLightboxOpen(true) }}
            >
              {isVideo && meta.animation_url ? (
                <MomentVideo
                  src={meta.animation_url}
                  poster={meta.image}
                  thumbhash={meta.kismet_thumbhash}
                  showPosterLayer
                  controls
                  className="w-full h-full object-contain"
                />
              ) : meta.image && !imgError ? (
                <MomentImage
                  src={meta.image}
                  alt={meta.name ?? 'moment'}
                  fill
                  className="object-contain"
                  sizes="(max-width: 768px) 100vw, 50vw"
                  priority
                  mime={meta.content?.mime}
                  thumbhash={meta.kismet_thumbhash}
                  onAllError={() => setImgError(true)}
                />
              ) : !detail ? (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-faint font-mono text-xs">loading…</span>
                </div>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-line font-mono text-xs">no preview</span>
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
                {meta.name ?? `#${tokenId}`}
              </h1>
              <div className="flex items-center gap-3 flex-shrink-0">
                {/* Edit metadata — admin-only. Pencil icon expands into a
                    full inline panel below the title to preserve spatial
                    locality (you edit what you're looking at). Share +
                    send moved to a single row beneath the action panel
                    so secondary actions group together visually. */}
                {isCreator && !editing && detail && (
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
                    className="bg-surface border border-line px-2.5 py-2 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50"
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
                    className="bg-surface border border-line px-2.5 py-2 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50 resize-y min-h-[3.5rem] overflow-auto"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-muted">image (optional)</label>
                  <div className="flex items-center gap-2">
                    {/* Show whatever's currently selected: new file preview > existing on-chain image > nothing.
                        MomentImg handles both — a blob URL from the file picker passes through unchanged,
                        an ar:// URI walks the gateway pool on error. */}
                    {(editPreview || meta.image) && (
                      <MomentImg
                        src={editPreview ?? meta.image ?? ''}
                        alt="preview"
                        className="w-12 h-12 object-cover bg-surface border border-line"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => editFileInputRef.current?.click()}
                      disabled={savingMeta}
                      className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-dim border border-line px-2.5 py-1.5 disabled:opacity-50"
                    >
                      {editFile ? 'replace' : 'change image'}
                    </button>
                    {editFile && (
                      <button
                        type="button"
                        onClick={clearEditFile}
                        disabled={savingMeta}
                        className="text-[10px] font-mono uppercase tracking-widest text-muted hover:text-dim disabled:opacity-50"
                      >
                        keep current
                      </button>
                    )}
                    <input
                      ref={editFileInputRef}
                      type="file"
                      accept="image/*,video/*"
                      onChange={handleEditFile}
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
                <p className="text-[10px] font-mono text-faint uppercase tracking-wider">description</p>
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
                <p className="text-[10px] font-mono text-faint uppercase tracking-wider">comments</p>
                <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
                  {comments.map((c, i) => (
                    <div key={i} className="flex gap-2 items-baseline">
                      <Link
                        href={`/profile/${c.sender}`}
                        className="text-[11px] font-mono text-muted flex-shrink-0 hover:text-dim transition-colors"
                      >
                        {commentSenderNames[c.sender.toLowerCase()] ?? shortAddress(c.sender)}
                      </Link>
                      <span className="text-xs font-mono text-dim flex-1 break-words leading-relaxed">
                        {c.comment}
                      </span>
                      <span className="text-[10px] font-mono text-faint flex-shrink-0">
                        {formatRelativeTime(c.timestamp)}
                      </span>
                    </div>
                  ))}
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
                className="w-full bg-surface border border-line px-3 py-2 text-xs text-ink font-mono placeholder-faint focus:outline-none focus:border-muted resize-none disabled:opacity-50"
              />
            )}
          </div>

          {/* Spacer — pushes bottom group down when content is short */}
          <div className="flex-1 min-h-6" />

          {/* Distribute earnings (floats above collect) */}
          {isCreator && hasSplits && (
            <div className="px-5 pb-4 flex flex-col gap-2">
              <p className="text-[10px] font-mono text-faint uppercase tracking-wider">distribute earnings</p>
              <button
                onClick={handleDistribute}
                disabled={distributing || !splitAddress}
                className="text-xs font-mono px-3 py-2 border border-line text-muted hover:border-muted hover:text-ink transition-colors disabled:opacity-40"
              >
                {distributing ? 'distributing…' : splitAddress ? 'distribute' : 'loading…'}
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
          {totalMinted !== undefined && (
            <div className="px-5 pb-1 flex items-center gap-3">
              <p className="text-[10px] font-mono text-[#444] uppercase tracking-widest">
                {Number(totalMinted).toLocaleString()}{' '}
                {detail && BigInt(detail.saleConfig.pricePerToken) > 0n ? 'sold' : 'collected'}
              </p>
              {ownedCount > 0 && (
                <p className="text-[10px] font-mono text-muted uppercase tracking-widest">
                  ×{ownedCount} own
                </p>
              )}
            </div>
          )}

          {/* Action row: [price|supply] [list] [collect] */}
          <div className="px-5 py-4 flex gap-2 items-stretch">
            <div className="flex border border-line flex-none">
              <div className="px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono accent-grad">{price ?? '…'}</span>
              </div>
              <div className="border-l border-line px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono text-[#444]">
                  {maxSupply === undefined
                    ? '…'
                    : isOpenEdition(maxSupply)
                      ? 'open'
                      : maxSupply.toLocaleString()}
                </span>
              </div>
            </div>
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
              disabled={collecting || mintedOut || !detail}
              className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase border transition-all disabled:opacity-50 ${collecting ? 'cursor-not-allowed' : ''} ${
                hasCollected
                  ? 'text-accent bg-accent/10 border-accent hover:bg-accent/20'
                  : 'text-muted border-line hover:bg-gradient-to-r hover:from-accent hover:to-accent hover:text-white hover:border-accent'
              }`}
            >
              {collectLabel}
            </button>
          </div>

          {/* Secondary actions row: share + (send when owned). Share
              always renders so every viewer has a one-click way to copy
              the moment link; send sits to its right for holders only. */}
          <div className="px-5 pb-4">
            <div className="flex items-center gap-3">
              <button
                onClick={handleCopyLink}
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
                  className="flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim transition-colors w-fit"
                >
                  <Send size={12} strokeWidth={1.5} />
                  {sendOpen ? 'cancel' : 'send'}
                </button>
              )}
            </div>
            {alreadyOwned && sendOpen && (
              <div className="mt-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={sendTo}
                    onChange={(e) => setSendTo(e.target.value)}
                    placeholder="0x address or name.eth"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 bg-surface border border-line px-3 py-2 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!sendToValid || sending}
                    className="flex-none px-4 py-2 text-xs font-mono tracking-wider uppercase border border-line text-muted hover:bg-gradient-to-r hover:from-accent hover:to-accent hover:text-white hover:border-accent transition-all disabled:opacity-50 disabled:hover:bg-none disabled:hover:text-muted disabled:hover:border-line"
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
                      <span className="text-[#666]">→ {shortAddress(resolvedSendTo)}</span>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Site admin — feature/unfeature */}
          {isAdmin && (
            <div className="px-5 pb-4">
              <button
                onClick={() => toggleFeatured(address, tokenId)}
                className={`flex items-center gap-1.5 text-xs font-mono transition-colors w-fit ${
                  isFeatured ? 'text-yellow-400' : 'text-muted hover:text-dim'
                }`}
              >
                <Star size={12} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
                {isFeatured ? 'unfeature' : 'feature'}
              </button>
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
          {meta.image && (
            <MomentImg
              src={meta.image}
              alt={meta.name ?? 'moment'}
              className="max-h-[95vh] max-w-[95vw] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          )}
        </div>
      )}
    </div>
  )
}
