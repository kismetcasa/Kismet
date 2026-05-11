'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import { useAccount, usePublicClient, useReadContract, useSignMessage, useWriteContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { ArrowLeft, Copy, Check, ChevronDown, ChevronUp, Star, X, Pencil, Eye, EyeOff, Send } from 'lucide-react'
import { isAddress } from 'viem'
import { resolveUri, formatPrice, shortAddress, formatRelativeTime, inferCollectCurrency, DEFAULT_COLLECT_COMMENT, type MomentDetail, type MomentComment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { useTextContent } from '@/lib/textCache'
import { getCachedDetail, setCachedDetail, getCachedComments, setCachedComments } from '@/lib/momentCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_MINT_ABI } from '@/lib/zoraMint'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useMomentSplits } from '@/hooks/useMomentSplits'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { ListButton } from './ListButton'
import { MomentImage, MomentImg } from './MomentImage'
import { ProfileAvatar } from './ProfileAvatar'
import { CopyAddress } from './CopyAddress'
import { SplitsPanel } from './SplitsPanel'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'
import { isOperatorAddress } from '@/lib/config'

// `momentAdmins[]` is unordered and may include the operator smart
// wallet (no Kismet profile) or a 0xSplits SplitWallet (no profile
// either, but detecting it needs a chain read). Filtering operator
// addresses covers the common case for moments minted outside the
// Kismet flow where the creator-fallback chain has to use this list.
function pickFirstNonOperatorAdmin(
  admins: readonly string[] | undefined,
): string | undefined {
  return admins?.find((a) => !isOperatorAddress(a))
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
  initialCollectionMeta?: { name?: string; image?: string; kismet_thumbhash?: string }
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
}

export function MomentDetailView({ address, tokenId, initialDetail, fallbackMeta, initialCollectionMeta, kvCreatorAddress, initialTextContent }: Props) {
  const { address: connectedAddress, isConnected } = useAccount()
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
  const [creatorName, setCreatorName] = useState(() => {
    const seedAddr =
      initialDetail?.creator?.address
      ?? kvCreatorAddress
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
  const { writeContractAsync: writeSend, isPending: sending } = useWriteContract()
  const publicClient = usePublicClient()
  const trimmedSendTo = sendTo.trim()
  const sendToValid = isAddress(trimmedSendTo)
    && trimmedSendTo.toLowerCase() !== connectedAddress?.toLowerCase()
  const handleSend = async () => {
    if (!connectedAddress || !sendToValid || sending || !publicClient) return
    try {
      toast.loading('Confirm in wallet…', { id: 'send' })
      const hash = await writeSend({
        address: address as `0x${string}`,
        abi: ERC1155_ABI,
        functionName: 'safeTransferFrom',
        args: [connectedAddress, trimmedSendTo as `0x${string}`, BigInt(tokenId), 1n, '0x'],
      })
      toast.loading('Sending…', { id: 'send' })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('Transfer reverted on-chain')
      toast.success('Sent', { id: 'send' })
      setSendOpen(false)
      setSendTo('')
      refetchOwnedBalance()
    } catch (err) {
      toastError('Send', err, { id: 'send' })
    }
  }

  // Total mints = collect count for this token. Authoritative count comes
  // from on-chain totalSupply (Zora 1155 maintains it per token id), which
  // sidesteps any inprocess indexer lag right after a fresh collect.
  const { data: totalMinted, refetch: refetchTotalMinted } = useReadContract({
    address: address as `0x${string}`,
    abi: ZORA_1155_MINT_ABI,
    functionName: 'totalSupply',
    args: [BigInt(tokenId)],
    query: { refetchInterval: 30_000 },
  })

  const isFeatured = featuredKeys.has(`${address.toLowerCase()}:${tokenId}`)
  // Resolution order for the moment's creator EOA:
  //   1. detail.creator.address — inprocess timeline's dedicated creator
  //      field (preferred when indexed).
  //   2. kvCreatorAddress — the EOA mint-proxy wrote to KV moment-meta
  //      at mint time. Available immediately for Kismet-minted moments,
  //      so we don't degrade to (3) during the brief window before
  //      inprocess catches up.
  //   3. first non-operator entry in detail.momentAdmins — last-resort
  //      fallback. The list is unordered and may contain the operator
  //      smart wallet (filtered out here) or a 0xSplits contract; kept
  //      for moments minted outside the Kismet flow where neither (1)
  //      nor (2) is populated.
  const creatorAddress =
    detail?.creator?.address
    ?? kvCreatorAddress
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
    if (!address) return
    fetch(`/api/collections?address=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return
        const name: string | undefined = d.metadata?.name ?? d.name
        const image: string | undefined = d.metadata?.image
        if (name) setCollectionName(name)
        if (image) {
          setCollectionImage(image)
          setCollectionImageFailed(false)
        }
      })
      .catch(() => {})
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
      // Refresh the on-chain count immediately rather than waiting for the
      // 30s poll — chain state has moved one tick at this point.
      refetchTotalMinted().catch(() => {})
    }
  }

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
      // valid forever.
      let imageUri = detail.metadata.image
      if (editFile) {
        toast.loading('Uploading image…', { id: 'edit-meta' })
        imageUri = await uploadToArweave(editFile)
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
      }

      toast.loading('Uploading metadata…', { id: 'edit-meta' })
      const newUri = await uploadJson(newMetadata)

      toast.loading('Sign update in wallet…', { id: 'edit-meta' })
      const nonceRes = await fetch(`/api/profile/${connectedAddress}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce')
      const message = `Update Kismet Art metadata\nCollection: ${address.toLowerCase()}\nToken: ${tokenId}\nURI: ${newUri}\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
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

      // Optimistically refresh the in-memory detail so UI reflects the
      // new metadata immediately. The proper refetch from inprocess will
      // catch up within a poll cycle.
      const optimistic: MomentDetail = {
        ...detail,
        uri: newUri,
        metadata: {
          ...detail.metadata,
          name: editName.trim(),
          description: editDesc.trim(),
          ...(imageUri ? { image: imageUri } : {}),
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
  const imageUrl = meta.image ? resolveUri(meta.image) : null
  const isVideo =
    meta.content?.mime?.startsWith('video/') ||
    meta.animation_url?.endsWith('.mp4') ||
    meta.animation_url?.endsWith('.webm')
  const mediaUrl = isVideo && meta.animation_url ? resolveUri(meta.animation_url) : imageUrl
  const price = detail
    ? formatPrice(detail.saleConfig.pricePerToken, inferCollectCurrency(detail.saleConfig))
    : null

  // Hidden moments are visible only to their creator (so they can unhide).
  // Non-creator viewers see a placeholder with no metadata leak so the
  // creator's intent to hide is honored even on direct URL access.
  if (isHidden && !isCreator) {
    return (
      <div className="max-w-6xl mx-auto pb-16">
        <div className="px-4 py-3 border-b border-[#2a2a2a]">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-xs font-mono text-[#555] hover:text-[#888] transition-colors"
          >
            <ArrowLeft size={12} />
            back
          </Link>
        </div>
        <div className="flex flex-col items-center justify-center gap-3 py-24 px-6">
          <EyeOff size={20} className="text-[#444]" />
          <p className="text-sm font-mono text-[#888]">this moment has been hidden by the creator</p>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto pb-16">

      {/* Back nav with owned-count callout on the right */}
      <div className="px-4 py-3 border-b border-[#2a2a2a] flex items-center justify-between gap-3">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-mono text-[#555] hover:text-[#888] transition-colors"
        >
          <ArrowLeft size={12} />
          back
        </Link>
        {ownedCount > 0 && (
          <p className="text-[10px] font-mono text-[#555] uppercase tracking-widest">
            ×{ownedCount} owned
          </p>
        )}
      </div>

      {/* Creator-only banner so the creator knows their moment is hidden */}
      {isHidden && isCreator && (
        <div className="px-4 py-2 border-b border-[#2a2a2a] bg-[#1a1a1a] flex items-center gap-2">
          <EyeOff size={11} className="text-[#888]" />
          <p className="text-[10px] font-mono text-[#888] uppercase tracking-widest">
            hidden from public — only you can see this
          </p>
        </div>
      )}

      {/* Two-column on desktop, stacked on mobile */}
      <div className="md:grid md:grid-cols-2 border-b border-[#2a2a2a]">

        {/* Left: media — sticky on desktop */}
        <div className="border-b border-[#2a2a2a] md:border-b-0 md:border-r md:border-r-[#2a2a2a] md:sticky md:top-14">
          {isTextMoment ? (
            <div className="min-h-64 flex flex-col p-6 sm:p-10 bg-[#111]">
              <span className="text-[10px] font-mono text-[#555] uppercase tracking-widest mb-3">writing</span>
              <p className="text-sm font-mono text-[#efefef] leading-relaxed whitespace-pre-wrap">
                {textContent ?? <span className="text-[#888]">loading from Arweave…</span>}
              </p>
            </div>
          ) : (
            <div
              className={`relative aspect-square bg-[#111] ${(imageUrl || (isVideo && mediaUrl)) ? 'cursor-zoom-in' : ''}`}
              onClick={() => { if (imageUrl || (isVideo && mediaUrl)) setLightboxOpen(true) }}
            >
              {isVideo && mediaUrl ? (
                <video
                  src={mediaUrl}
                  className="w-full h-full object-contain"
                  autoPlay
                  muted
                  loop
                  playsInline
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
                  <span className="text-[#333] font-mono text-xs">loading…</span>
                </div>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-[#2a2a2a] font-mono text-xs">no preview</span>
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
              <h1 className="text-sm font-mono text-[#efefef] leading-snug">
                {meta.name ?? `#${tokenId}`}
              </h1>
              <div className="flex items-center gap-3 flex-shrink-0">
                {/* Edit metadata — admin-only. Pencil icon lives next to
                    share so the visual weight stays light; expanding into
                    a full inline panel below the title preserves spatial
                    locality (you edit what you're looking at). */}
                {isCreator && !editing && detail && (
                  <button
                    onClick={openEditor}
                    className="flex items-center gap-1 text-xs font-mono text-[#555] hover:text-[#888] transition-colors"
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
                      isHidden ? 'text-[#888] hover:text-[#efefef]' : 'text-[#555] hover:text-[#888]'
                    }`}
                    title={isHidden ? 'Show on public feeds' : 'Hide from public feeds'}
                  >
                    {isHidden ? <Eye size={11} /> : <EyeOff size={11} />}
                    {isHidden ? 'hidden' : 'hide'}
                  </button>
                )}
                <button
                  onClick={handleCopyLink}
                  className="flex items-center gap-1 text-xs font-mono text-[#555] hover:text-[#888] transition-colors"
                >
                  {linkCopied ? <Check size={11} className="text-[#6ee7b7]" /> : <Copy size={11} />}
                  {linkCopied ? 'copied' : 'share'}
                </button>
              </div>
            </div>

            {/* Inline edit panel — pre-populated from the loaded detail.
                Image is optional: if the creator only wants to fix a typo
                in the title or description, they leave the image alone
                and we keep the existing ar:// in the new metadata JSON. */}
            {editing && detail && (
              <div className="flex flex-col gap-3 border border-[#2a2a2a] p-3 bg-[#0a0a0a]">
                <div className="flex items-center justify-between">
                  <p className="text-[10px] font-mono uppercase tracking-widest text-[#888]">edit metadata</p>
                  <button
                    onClick={closeEditor}
                    disabled={savingMeta}
                    className="text-[#555] hover:text-[#888] transition-colors disabled:opacity-40"
                    title="cancel"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-[#555]">title</label>
                  <input
                    type="text"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    disabled={savingMeta}
                    placeholder="title"
                    className="bg-[#111] border border-[#2a2a2a] px-2.5 py-2 text-xs font-mono text-[#efefef] placeholder-[#333] focus:outline-none focus:border-[#555] disabled:opacity-50"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-[#555]">description</label>
                  <textarea
                    value={editDesc}
                    onChange={(e) => setEditDesc(e.target.value)}
                    disabled={savingMeta}
                    rows={3}
                    placeholder="description"
                    className="bg-[#111] border border-[#2a2a2a] px-2.5 py-2 text-xs font-mono text-[#efefef] placeholder-[#333] focus:outline-none focus:border-[#555] disabled:opacity-50 resize-none"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-mono uppercase tracking-widest text-[#555]">image (optional)</label>
                  <div className="flex items-center gap-2">
                    {/* Show whatever's currently selected: new file preview > existing on-chain image > nothing.
                        MomentImg handles both — a blob URL from the file picker passes through unchanged,
                        an ar:// URI walks the gateway pool on error. */}
                    {(editPreview || meta.image) && (
                      <MomentImg
                        src={editPreview ?? meta.image ?? ''}
                        alt="preview"
                        className="w-12 h-12 object-cover bg-[#111] border border-[#2a2a2a]"
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => editFileInputRef.current?.click()}
                      disabled={savingMeta}
                      className="text-[10px] font-mono uppercase tracking-widest text-[#555] hover:text-[#888] border border-[#2a2a2a] px-2.5 py-1.5 disabled:opacity-50"
                    >
                      {editFile ? 'replace' : 'change image'}
                    </button>
                    {editFile && (
                      <button
                        type="button"
                        onClick={clearEditFile}
                        disabled={savingMeta}
                        className="text-[10px] font-mono uppercase tracking-widest text-[#555] hover:text-[#888] disabled:opacity-50"
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
                    className="text-xs font-mono tracking-wider uppercase px-3 py-2 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#888] transition-colors disabled:opacity-40"
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
                <span className="text-xs font-mono text-[#555] group-hover:text-[#888] transition-colors">
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
                  <div className="w-[22px] h-[22px] relative flex-shrink-0 bg-[#1a1a1a] overflow-hidden">
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
                <span className="text-xs font-mono text-[#555] group-hover:text-[#888] transition-colors">
                  {collectionName}
                </span>
              </Link>
            )}
            {meta.description && (
              <div className="flex flex-col gap-1.5">
                <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">description</p>
                <p
                  ref={descRef}
                  className={`text-xs font-mono text-[#888] leading-relaxed ${showFullDesc ? '' : 'line-clamp-4'}`}
                >
                  {meta.description}
                </p>
                {(descOverflows || showFullDesc) && (
                  <button
                    onClick={() => setShowFullDesc(v => !v)}
                    className="flex items-center gap-1 text-[10px] font-mono text-[#555] hover:text-[#888] transition-colors w-fit"
                  >
                    {showFullDesc ? <><ChevronUp size={10} /> show less</> : <><ChevronDown size={10} /> show more</>}
                  </button>
                )}
              </div>
            )}
            {hasSplits && <SplitsPanel recipients={splitRecipients} />}
            {!commentsLoading && comments.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">comments</p>
                <div className="flex flex-col gap-2 max-h-64 overflow-y-auto pr-1">
                  {comments.map((c, i) => (
                    <div key={i} className="flex gap-2 items-baseline">
                      <Link
                        href={`/profile/${c.sender}`}
                        className="text-[11px] font-mono text-[#555] flex-shrink-0 hover:text-[#888] transition-colors"
                      >
                        {commentSenderNames[c.sender.toLowerCase()] ?? shortAddress(c.sender)}
                      </Link>
                      <span className="text-xs font-mono text-[#888] flex-1 break-words leading-relaxed">
                        {c.comment}
                      </span>
                      <span className="text-[10px] font-mono text-[#333] flex-shrink-0">
                        {formatRelativeTime(c.timestamp)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <textarea
              value={commentText}
              onChange={(e) => setCommentText(e.target.value)}
              placeholder="leave a comment… (optional)"
              rows={2}
              disabled={collecting}
              className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2 text-xs text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] resize-none disabled:opacity-50"
            />
          </div>

          {/* Spacer — pushes bottom group down when content is short */}
          <div className="flex-1 min-h-6" />

          {/* Distribute earnings (floats above collect) */}
          {isCreator && hasSplits && (
            <div className="px-5 pb-4 flex flex-col gap-2">
              <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">distribute earnings</p>
              <button
                onClick={handleDistribute}
                disabled={distributing || !splitAddress}
                className="text-xs font-mono px-3 py-2 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
              >
                {distributing ? 'distributing…' : splitAddress ? 'distribute' : 'loading…'}
              </button>
              {distributeHash && (
                <a
                  href={`https://basescan.org/tx/${distributeHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[10px] font-mono text-[#555] hover:text-[#888]"
                >
                  distributed: {distributeHash.slice(0, 10)}…{distributeHash.slice(-8)}
                </a>
              )}
            </div>
          )}

          {/* Total mints — subtle, above action row.
              "×N owned" lives next to the back link at the top now. */}
          {totalMinted !== undefined && (
            <div className="px-5 pb-1 flex items-center gap-3">
              <p className="text-[10px] font-mono text-[#444] uppercase tracking-widest">
                {Number(totalMinted).toLocaleString()} collected
              </p>
            </div>
          )}

          {/* Action row: [price|supply] [list] [collect] */}
          <div className="px-5 py-4 flex gap-2 items-stretch">
            <div className="flex border border-[#2a2a2a] flex-none">
              <div className="px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono accent-grad">{price ?? '…'}</span>
              </div>
              <div className="border-l border-[#2a2a2a] px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono text-[#444]">
                  {detail == null ? '…' : (detail.maxSupply == null || detail.maxSupply === 0 ? 'open' : detail.maxSupply.toLocaleString())}
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
              disabled={collecting || alreadyOwned || collected || !detail}
              className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase border transition-all disabled:opacity-50 ${collecting ? 'cursor-not-allowed' : ''} ${
                collected || alreadyOwned
                  ? 'text-[#8B5CF6] bg-[#8B5CF6]/10 border-[#8B5CF6]'
                  : 'text-[#555] border-[#2a2a2a] hover:bg-gradient-to-r hover:from-[#8B5CF6] hover:to-[#C084FC] hover:text-white hover:border-[#8B5CF6]'
              }`}
            >
              {collecting ? 'collecting…' : (collected || alreadyOwned) ? 'collected' : 'collect'}
            </button>
          </div>

          {alreadyOwned && (
            <div className="px-5 pb-4">
              <button
                onClick={() => setSendOpen((v) => !v)}
                className="flex items-center gap-1.5 text-xs font-mono text-[#555] hover:text-[#888] transition-colors w-fit"
              >
                <Send size={12} strokeWidth={1.5} />
                {sendOpen ? 'cancel' : 'send'}
              </button>
              {sendOpen && (
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    value={sendTo}
                    onChange={(e) => setSendTo(e.target.value)}
                    placeholder="0x recipient address"
                    autoComplete="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 bg-[#111] border border-[#2a2a2a] px-3 py-2 text-xs font-mono text-[#efefef] placeholder-[#333] focus:outline-none focus:border-[#555]"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!sendToValid || sending}
                    className="flex-none px-4 py-2 text-xs font-mono tracking-wider uppercase border border-[#2a2a2a] text-[#555] hover:bg-gradient-to-r hover:from-[#8B5CF6] hover:to-[#C084FC] hover:text-white hover:border-[#8B5CF6] transition-all disabled:opacity-50 disabled:hover:bg-none disabled:hover:text-[#555] disabled:hover:border-[#2a2a2a]"
                  >
                    {sending ? '…' : 'confirm'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Site admin — feature/unfeature */}
          {isAdmin && (
            <div className="px-5 pb-4">
              <button
                onClick={() => toggleFeatured(address, tokenId)}
                className={`flex items-center gap-1.5 text-xs font-mono transition-colors w-fit ${
                  isFeatured ? 'text-yellow-400' : 'text-[#555] hover:text-[#888]'
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
            className="absolute top-4 right-4 z-10 p-2 text-[#888] hover:text-[#efefef] transition-colors"
          >
            <X size={18} />
          </button>
          {isVideo && mediaUrl ? (
            <video
              src={mediaUrl}
              className="max-h-[95vh] max-w-[95vw] object-contain"
              autoPlay muted loop playsInline
              onClick={(e) => e.stopPropagation()}
            />
          ) : meta.image ? (
            <MomentImg
              src={meta.image}
              alt={meta.name ?? 'moment'}
              className="max-h-[95vh] max-w-[95vw] object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          ) : null}
        </div>
      )}
    </div>
  )
}
