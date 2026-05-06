'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useAccount, useReadContract, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { ArrowLeft, Copy, Check, ChevronDown, ChevronUp, Star, X, Pencil } from 'lucide-react'
import { resolveUri, formatPrice, shortAddress, formatRelativeTime, inferCollectCurrency, DEFAULT_COLLECT_COMMENT, type MomentDetail, type MomentComment } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { useTextContent } from '@/lib/textCache'
import { getCachedDetail, setCachedDetail, getCachedComments, setCachedComments } from '@/lib/momentCache'
import { ERC1155_ABI } from '@/lib/seaport'
import { ZORA_1155_MINT_ABI } from '@/lib/zoraMint'
import { useDirectCollect } from '@/hooks/useDirectCollect'
import { useUploadSession } from '@/hooks/useUploadSession'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { ListButton } from './ListButton'
import { ProfileAvatar } from './ProfileAvatar'
import { useAdmin } from '@/contexts/AdminContext'
import { humanError } from '@/lib/toast'

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
}

const TOP_COMMENTS = 3

export function MomentDetailView({ address, tokenId, initialDetail, fallbackMeta }: Props) {
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
  const textContent = useTextContent(textContentUri)
  const [comments, setComments] = useState<MomentComment[]>(
    () => getCachedComments(address, tokenId) ?? []
  )
  const [commentsLoading, setCommentsLoading] = useState(
    () => getCachedComments(address, tokenId) === undefined
  )
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
  const [hasSplits, setHasSplits] = useState(false)
  const [splitAddress, setSplitAddress] = useState('')
  const [distributing, setDistributing] = useState(false)
  const [distributeHash, setDistributeHash] = useState<string | null>(null)
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
  const alreadyOwned = ownedBalance ? Number(ownedBalance) > 0 : false

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
  const creatorAddress = detail?.momentAdmins[0] ?? ''
  const isCreator =
    !!connectedAddress &&
    !!creatorAddress &&
    connectedAddress.toLowerCase() === creatorAddress.toLowerCase()

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
    const addr = splitAddress.trim()
    if (!addr || !isAddress(addr)) { toast.error('Invalid split address'); return }
    if (!connectedAddress) { toast.error('Wallet not connected'); return }
    if (!detail) { toast.error('Moment details still loading'); return }
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
      toast.error('Distribution failed', { id: 'distribute', description: humanError(err) })
    } finally {
      setDistributing(false)
    }
  }

  function handleCopyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/moment/${address}/${tokenId}`).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
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
      toast.error('Update failed', { id: 'edit-meta', description: humanError(err) })
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

      {/* Two-column on desktop, stacked on mobile */}
      <div className="md:grid md:grid-cols-2 border-b border-[#2a2a2a]">

        {/* Left: media — sticky on desktop */}
        <div className="border-b border-[#2a2a2a] md:border-b-0 md:border-r md:border-r-[#2a2a2a] md:sticky md:top-14">
          {isTextMoment ? (
            <div className="min-h-64 flex items-start p-6 sm:p-10 bg-[#111]">
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
                  className="w-full h-full object-cover"
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
                  className="object-cover"
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
            <Link
              href={creatorAddress ? `/profile/${creatorAddress}` : '#'}
              className="flex items-center gap-2 group w-fit"
            >
              {creatorAddress && (
                <ProfileAvatar address={creatorAddress} avatarUrl={creatorAvatar} size={22} />
              )}
              <span className="text-xs font-mono text-[#555] group-hover:text-[#888] transition-colors">
                {creatorName || shortAddress(creatorAddress)}
              </span>
            </Link>
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
                      {shortAddress(c.sender)}
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
              <div className="flex gap-2">
                <input
                  type="text"
                  value={splitAddress}
                  onChange={(e) => setSplitAddress(e.target.value)}
                  placeholder="0x… split address"
                  className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2 text-xs text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
                />
                <button
                  onClick={handleDistribute}
                  disabled={distributing || !splitAddress.trim()}
                  className="text-xs font-mono px-3 py-2 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
                >
                  {distributing ? '…' : '→'}
                </button>
              </div>
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

          {/* Total collected — sits above the action row when we have a count */}
          {totalMinted !== undefined && (
            <div className="px-5 -mb-1">
              <p className="text-[10px] font-mono text-[#555] uppercase tracking-widest">
                {Number(totalMinted).toLocaleString()} collected
              </p>
            </div>
          )}

          {/* List + Collect — hugs the bottom */}
          <div className="px-5 py-4 flex gap-2 items-stretch">
            {alreadyOwned && (
              <div className="w-2/5 flex-none">
                <ListButton
                  collectionAddress={address}
                  tokenId={tokenId}
                  name={meta.name}
                  image={meta.image ? resolveUri(meta.image) : undefined}
                  creatorAddress={creatorAddress}
                  contentUri={meta.content?.uri}
                  contentMime={meta.content?.mime}
                  narrowInput
                />
              </div>
            )}
            {/* Action row order: price | supply | collect. */}
            <div className={`flex ${alreadyOwned ? 'flex-1' : 'w-full'} border transition-colors ${
              alreadyOwned || collected ? 'border-[#8B5CF6]' : 'border-[#2a2a2a]'
            }`}>
              <div className="px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono accent-grad">{price ?? '…'}</span>
              </div>
              <div className="border-l border-[#2a2a2a] px-3 py-2 flex items-center justify-center min-w-[3.5rem]">
                <span className="text-[11px] font-mono text-[#444]">
                  {detail == null ? '…' : (detail.maxSupply == null || detail.maxSupply === 0 ? 'open' : detail.maxSupply.toLocaleString())}
                </span>
              </div>
              <button
                onClick={handleCollect}
                disabled={collecting || alreadyOwned || collected || !detail}
                className={`flex-1 py-2.5 text-xs font-mono tracking-wider uppercase transition-all disabled:opacity-50 border-l border-[#2a2a2a] ${collecting ? 'cursor-not-allowed' : ''} ${
                  collected || alreadyOwned ? 'text-[#8B5CF6] bg-[#8B5CF6]/10' : 'text-[#555] hover:bg-gradient-to-r hover:from-[#8B5CF6] hover:to-[#C084FC] hover:text-white'
                }`}
              >
                {collecting ? 'collecting…' : (collected || alreadyOwned) ? 'collected' : 'collect'}
              </button>
            </div>
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
