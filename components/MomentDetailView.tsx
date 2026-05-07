'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useAccount, useReadContract, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { ArrowLeft, Copy, Check, ChevronDown, ChevronUp, Star, X, Pencil, Eye, EyeOff } from 'lucide-react'
import { resolveUri, formatPrice, shortAddress, formatRelativeTime, inferCollectCurrency, DEFAULT_COLLECT_COMMENT, type MomentDetail, type MomentComment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { useTextContent } from '@/lib/textCache'
import { getCachedDetail, setCachedDetail, getCachedComments, setCachedComments } from '@/lib/momentCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_MINT_ABI, ZORA_CREATOR_REWARD_RECIPIENT_ABI } from '@/lib/zoraMint'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useGrantPermission } from '@/hooks/useGrantPermission'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { ListButton } from './ListButton'
import { ProfileAvatar } from './ProfileAvatar'
import { CopyAddress } from './CopyAddress'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'

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
  }
  // Server-prefetched body for text moments — warms the module-level cache
  // so the writing panel renders on first paint without a client fetch.
  initialTextContent?: string
}

const TOP_COMMENTS = 3

export function MomentDetailView({ address, tokenId, initialDetail, fallbackMeta, initialTextContent }: Props) {
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
  const [showAllComments, setShowAllComments] = useState(false)
  const [commentText, setCommentText] = useState('')
  const [collected, setCollected] = useState(false)
  const { collect, status: collectStatus } = useDirectCollect()
  const collecting = collectStatus !== 'idle' && collectStatus !== 'done' && collectStatus !== 'error'
  const [creatorName, setCreatorName] = useState('')
  const [creatorAvatar, setCreatorAvatar] = useState<string | undefined>(undefined)
  const [linkCopied, setLinkCopied] = useState(false)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [showFullDesc, setShowFullDesc] = useState(false)
  const [descOverflows, setDescOverflows] = useState(false)
  const descRef = useRef<HTMLParagraphElement>(null)
  const [collectionName, setCollectionName] = useState<string | null>(null)
  const [collectionImage, setCollectionImage] = useState<string | null>(null)
  const [hasSplits, setHasSplits] = useState(false)
  const [distributing, setDistributing] = useState(false)
  const [distributeHash, setDistributeHash] = useState<string | null>(null)
  // Per-token ADMIN delegation: lets the creator grant another wallet
  // permission to airdrop this specific moment. Inprocess's
  // /api/airdrop authorizes any address present in `momentAdmins`,
  // which on-chain reads from permissions(tokenId, addr) — so granting
  // ADMIN at the moment's tokenId makes the delegate eligible.
  const [delegateInput, setDelegateInput] = useState('')
  const {
    grant: grantDelegate,
    reset: resetDelegateGrant,
    busy: delegating,
    receipt: delegateReceipt,
  } = useGrantPermission()

  useEffect(() => {
    if (!delegateReceipt) return
    resetDelegateGrant()
    if (delegateReceipt.status === 'reverted') {
      toast.error('Delegate failed', {
        id: 'delegate-airdrop',
        description:
          'The transaction reverted on-chain — only the moment admin can delegate.',
      })
      return
    }
    setDelegateInput('')
    toast.success('Airdrop delegated', { id: 'delegate-airdrop' })
  }, [delegateReceipt, resetDelegateGrant])

  async function handleDelegateAirdrop() {
    const target = delegateInput.trim()
    if (!isAddress(target)) {
      toast.error('Invalid address', { id: 'delegate-airdrop' })
      return
    }
    try {
      toast.loading('Confirm in wallet…', { id: 'delegate-airdrop' })
      const outcome = await grantDelegate({
        collection: address as `0x${string}`,
        grantee: target as `0x${string}`,
        tokenId: BigInt(tokenId),
        bit: 'admin',
      })
      if (outcome === 'submitted') {
        toast.loading('Delegating…', { id: 'delegate-airdrop' })
        return
      }
      // Already had ADMIN at this tokenId — no tx needed.
      setDelegateInput('')
      toast.success('Already authorized to airdrop this moment', {
        id: 'delegate-airdrop',
      })
    } catch (err) {
      toastError('Delegate airdrop', err, { id: 'delegate-airdrop' })
    }
  }
  // Edit-metadata flow: visible only to moment admins. Pre-populated from
  // the loaded MomentDetail so they can fix typos / replace the image
  // without re-typing everything.
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editDesc, setEditDesc] = useState('')
  const [editFile, setEditFile] = useState<File | null>(null)
  const [editPreview, setEditPreview] = useState<string | null>(null)
  const [savingMeta, setSavingMeta] = useState(false)
  const editFileInputRef = useRef<HTMLInputElement>(null)
  const { ensureSession } = useUploadSession()

  const { data: ownedBalance } = useReadContract({
    address: address as `0x${string}`,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: connectedAddress ? [connectedAddress, BigInt(tokenId)] : undefined,
    query: { enabled: !!connectedAddress },
  })
  const ownedCount = ownedBalance ? Number(ownedBalance) : 0
  const alreadyOwned = ownedCount > 0

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
  // Prefer the dedicated `creator` field injected by /api/moment from the
  // timeline lookup; momentAdmins is unordered and [0] is often a platform
  // admin rather than the minter. Empty-string fallback preserves the
  // pre-existing isCreator behaviour when both are absent.
  const creatorAddress = detail?.creator?.address ?? detail?.momentAdmins[0] ?? ''
  const isHidden = detail?.hidden === true
  const [hidePending, setHidePending] = useState(false)
  const isCreator =
    !!connectedAddress &&
    !!creatorAddress &&
    connectedAddress.toLowerCase() === creatorAddress.toLowerCase()

  const { data: splitAddress } = useReadContract({
    address: address as `0x${string}`,
    abi: ZORA_CREATOR_REWARD_RECIPIENT_ABI,
    functionName: 'getCreatorRewardRecipient',
    args: [BigInt(tokenId)],
    query: { enabled: isCreator && hasSplits },
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
    fetchCreatorProfile(creatorAddress).then(({ name, avatarUrl }) => {
      setCreatorName(name)
      setCreatorAvatar(avatarUrl)
    })
  }, [creatorAddress])

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
        if (image) setCollectionImage(resolveUri(image))
      })
      .catch(() => {})
  }, [address])

  useEffect(() => {
    const el = descRef.current
    if (!el) return
    setDescOverflows(el.scrollHeight > el.clientHeight)
  }, [detail])

  useEffect(() => {
    if (!lightboxOpen) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightboxOpen(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxOpen])

  // Check splits flag (only for creator)
  useEffect(() => {
    if (!isCreator) return
    fetch(`/api/moment/splits?collectionAddress=${address}&tokenId=${tokenId}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setHasSplits(d.hasSplits === true))
      .catch(() => {})
  }, [address, tokenId, isCreator])

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
    if (!splitAddress) { toast.error('Split address not found'); return }
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    if (!detail) { toast.error('Moment details still loading'); return }
    const addr = splitAddress
    // Route the distribute call to the right token type per the moment's
    // sale config — USDC moments need tokenAddress=USDC_BASE on the
    // inprocess side, otherwise the call defaults to ETH and distributes
    // nothing from a USDC splits contract.
    const currency = inferCollectCurrency(detail.saleConfig)
    setDistributing(true)
    try {
      const nonceRes = await fetch(`/api/profile/${connectedAddress}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce')
      const message = `Distribute Kismet Art split\nCollection: ${address.toLowerCase()}\nToken: ${tokenId}\nSplit: ${addr.toLowerCase()}\nCurrency: ${currency}\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
      const signature = await signMessageAsync({ message })

      const res = await fetch('/api/distribute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          splitAddress: addr,
          collectionAddress: address,
          tokenId,
          chainId: 8453,
          currency,
          callerAddress: connectedAddress,
          signature,
          nonce,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error ?? 'Distribution failed')
      if (!data.hash) throw new Error('Distribute submitted but no tx hash returned')
      setDistributeHash(data.hash)
      toast.success('Distributed!', { id: 'distribute' })
    } catch (err) {
      toastError('Distribution', err, { id: 'distribute' })
    } finally {
      setDistributing(false)
    }
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
    setEditFile(null)
    setEditPreview(null)
    setEditing(true)
  }

  function closeEditor() {
    if (editPreview) URL.revokeObjectURL(editPreview)
    setEditFile(null)
    setEditPreview(null)
    setEditing(false)
  }

  function handleEditFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    const MAX = 50 * 1024 * 1024
    if (f.size > MAX) { toast.error('File too large', { description: 'Max 50 MB' }); return }
    if (editPreview) URL.revokeObjectURL(editPreview)
    setEditFile(f)
    setEditPreview(URL.createObjectURL(f))
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

  const visibleComments = showAllComments ? comments : comments.slice(0, TOP_COMMENTS)
  const hiddenCount = comments.length - TOP_COMMENTS

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

      {/* Back nav */}
      <div className="px-4 py-3 border-b border-[#2a2a2a]">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-xs font-mono text-[#555] hover:text-[#888] transition-colors"
        >
          <ArrowLeft size={12} />
          back
        </Link>
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
                {textContent ?? (detail ? '' : '…')}
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
              ) : imageUrl ? (
                <Image
                  src={imageUrl}
                  alt={meta.name ?? 'moment'}
                  fill
                  className="object-contain"
                  sizes="(max-width: 768px) 100vw, 50vw"
                  priority
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
                    {/* Show whatever's currently selected: new file preview > existing on-chain image > nothing */}
                    {(editPreview || imageUrl) && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={editPreview ?? imageUrl ?? ''}
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
                        onClick={() => {
                          if (editPreview) URL.revokeObjectURL(editPreview)
                          setEditFile(null)
                          setEditPreview(null)
                          if (editFileInputRef.current) editFileInputRef.current.value = ''
                        }}
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
                {collectionImage && (
                  <div className="w-[22px] h-[22px] relative flex-shrink-0 bg-[#1a1a1a] overflow-hidden">
                    <Image
                      src={collectionImage}
                      alt=""
                      fill
                      className="object-cover"
                      sizes="22px"
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
            {!commentsLoading && comments.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">comments</p>
                {visibleComments.map((c, i) => (
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
                {hiddenCount > 0 && (
                  <button
                    onClick={() => setShowAllComments((v) => !v)}
                    className="flex items-center gap-1 text-[10px] font-mono text-[#555] hover:text-[#888] transition-colors w-fit"
                  >
                    {showAllComments
                      ? <><ChevronUp size={10} /> show less</>
                      : <><ChevronDown size={10} /> {hiddenCount} more</>}
                  </button>
                )}
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

          {/* Delegate airdrop — grants another wallet ADMIN at this
              moment's tokenId so they can airdrop it via /api/airdrop.
              Mirrors the Distribute UI's compact layout. Only renders
              for the moment admin (the same gate /api/airdrop's
              `momentAdmins` check enforces upstream). */}
          {isCreator && (
            <div className="px-5 pb-4 flex flex-col gap-2">
              <p className="text-[10px] font-mono text-[#333] uppercase tracking-wider">delegate airdrop</p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={delegateInput}
                  onChange={(e) => setDelegateInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleDelegateAirdrop()
                    }
                  }}
                  placeholder="0x… wallet address"
                  className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2 text-xs text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
                />
                <button
                  onClick={() => void handleDelegateAirdrop()}
                  disabled={delegating || !delegateInput.trim()}
                  className="text-xs font-mono px-3 py-2 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
                >
                  {delegating ? '…' : '→'}
                </button>
              </div>
            </div>
          )}

          {/* Total mints + owned count — subtle, above action row */}
          {(totalMinted !== undefined || ownedCount > 0) && (
            <div className="px-5 pb-1 flex items-center gap-3">
              {totalMinted !== undefined && (
                <p className="text-[10px] font-mono text-[#444] uppercase tracking-widest">
                  {Number(totalMinted).toLocaleString()} collected
                </p>
              )}
              {ownedCount > 0 && (
                <p className="text-[10px] font-mono text-[#555] uppercase tracking-widest">
                  ×{ownedCount} owned
                </p>
              )}
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
          ) : imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
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
