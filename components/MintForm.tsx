'use client'

import { useState, useRef, useEffect } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Upload, X, Plus, Trash2 } from 'lucide-react'
import { parseEther, parseUnits, isAddress } from 'viem'
import { resolveUri, shortAddress, type CreateMomentPayload, type Split } from '@/lib/inprocess'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import { useUploadSession } from '@/hooks/useUploadSession'
import { PLATFORM_COLLECTION, CREATE_REFERRAL, RESIDENCIES_ADDRESS } from '@/lib/config'
import { USDC_BASE } from '@/lib/zoraMint'
import { toastError } from '@/lib/toast'

type PriceCurrency = 'eth' | 'usdc'

type MintMode = 'media' | 'text'

// 0xSplits' SplitMain requires `accounts` sorted ascending by address.
// Lowercase-compare on the hex string gives the same ordering as numeric
// ascending for properly-formed addresses.
function sortSplits(s: Split[]): Split[] {
  return [...s].sort((a, b) => {
    const al = a.address.toLowerCase()
    const bl = b.address.toLowerCase()
    return al < bl ? -1 : al > bl ? 1 : 0
  })
}

// Inprocess docs (moment/create/splits): every example uses integer
// `percentAllocation` and "must sum to exactly 100%" — no decimal tolerance.
// Decimal values (like the 47.5 we used to emit when scaling 50/50 to make
// room for residencies) get mis-parsed downstream and revert the on-chain
// splits-contract setup.
//
// Round each value to the nearest integer (≥1 floor so we never silently
// drop a recipient), then absorb rounding drift round-robin until the sum
// matches `target` exactly.
function roundToIntegerAllocations(values: number[], target: number): number[] {
  const rounded = values.map((v) => Math.max(1, Math.round(v)))
  const sum = rounded.reduce((a, b) => a + b, 0)
  let drift = target - sum
  let idx = 0
  // Bound the loop generously; drift is bounded by recipient count in practice.
  const max = rounded.length * 4 + 8
  while (drift !== 0 && idx < max) {
    const i = idx % rounded.length
    if (drift > 0) {
      rounded[i] += 1
      drift -= 1
    } else if (drift < 0 && rounded[i] > 1) {
      rounded[i] -= 1
      drift += 1
    }
    idx += 1
  }
  return rounded
}

interface MintFormProps {
  collectionAddress?: string
  collectionName?: string
}

interface CollectionOption {
  address: string
  name: string
  image?: string
}

// The platform-wide collection. Used as the implicit selectedCollection when
// nothing's been picked, and as the reset target for the × clear button. Not
// listed in the dropdown — the placeholder copy "mint into a collection
// (optional)" already conveys "default if you don't pick anything".
const PLATFORM_OPTION: CollectionOption = {
  address: PLATFORM_COLLECTION,
  name: 'platform',
}

export function MintForm({ collectionAddress, collectionName }: MintFormProps = {}) {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { ensureSession } = useUploadSession()

  // Collection picker — initialized from the URL/prop hint when present,
  // falls back to the platform default. The picker overrides the prop once
  // the user makes an explicit selection.
  const [selectedCollection, setSelectedCollection] = useState<CollectionOption>(() => {
    if (collectionAddress) {
      return {
        address: collectionAddress,
        name: collectionName ?? shortAddress(collectionAddress),
      }
    }
    return PLATFORM_OPTION
  })
  const [userCollections, setUserCollections] = useState<CollectionOption[]>([])
  const [loadingCollections, setLoadingCollections] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const targetCollection = selectedCollection.address

  // Sync the picker when MintTabs hands us a freshly-deployed collection or
  // the URL params change. User-driven picker selections still override on
  // subsequent state updates.
  useEffect(() => {
    if (collectionAddress) {
      setSelectedCollection({
        address: collectionAddress,
        name: collectionName ?? shortAddress(collectionAddress),
      })
    }
  }, [collectionAddress, collectionName])

  // Fetch the connected user's deployed collections so the picker can list
  // them alongside the platform default. /api/collections?artist=… is
  // creator-aware: the user always sees their own (including hidden ones).
  useEffect(() => {
    if (!address) {
      setUserCollections([])
      return
    }
    let cancelled = false
    setLoadingCollections(true)
    fetch(`/api/collections?artist=${address}`)
      .then((r) => (r.ok ? r.json() : { collections: [] }))
      .then((d) => {
        if (cancelled) return
        const items: CollectionOption[] = (Array.isArray(d.collections) ? d.collections : [])
          .map((c: { contractAddress?: string; name?: string; metadata?: { name?: string; image?: string } }) => {
            if (!c.contractAddress) return null
            return {
              address: c.contractAddress,
              name: c.metadata?.name ?? c.name ?? shortAddress(c.contractAddress),
              image: c.metadata?.image,
            }
          })
          .filter((c: CollectionOption | null): c is CollectionOption => c !== null)
        setUserCollections(items)
      })
      .catch(() => {
        if (!cancelled) setUserCollections([])
      })
      .finally(() => {
        if (!cancelled) setLoadingCollections(false)
      })
    return () => {
      cancelled = true
    }
  }, [address])

  // Picker dropdown lists the user's deployed collections only — the
  // platform is the implicit default when nothing's selected, so it doesn't
  // need a row in the dropdown.
  const collectionOptions: CollectionOption[] = userCollections.filter(
    (c) => c.address.toLowerCase() !== PLATFORM_COLLECTION.toLowerCase(),
  )
  const isPlatformDefault =
    selectedCollection.address.toLowerCase() === PLATFORM_COLLECTION.toLowerCase()

  const [mintMode, setMintMode] = useState<MintMode>('media')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [textContent, setTextContent] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('0')
  const [priceCurrency, setPriceCurrency] = useState<PriceCurrency>('eth')
  const [maxSupply, setMaxSupply] = useState('')
  const [splits, setSplits] = useState<Split[]>([])
  const [splitInput, setSplitInput] = useState({ address: '', pct: '' })
  const [residenciesEnabled, setResidenciesEnabled] = useState(true)
  const [step, setStep] = useState<'idle' | 'uploading-media' | 'uploading-metadata' | 'verifying-upload' | 'minting' | 'done'>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [result, setResult] = useState<{ hash: string; contractAddress: string; tokenId: string } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const splitsTotal = splits.reduce((s, r) => s + r.percentAllocation, 0)

  function switchMode(mode: MintMode) {
    setMintMode(mode)
    if (mode === 'text') clearFile()
    else setTextContent('')
  }

  // Detects the auth-failure paths that come back when minting into a
  // collection where inprocess's smart account isn't yet ADMIN:
  //   - structured 403 with code 'AUTHORIZE_REQUIRED' (mint-proxy's
  //     server-side preflight catches it before the userOp ever runs)
  //   - the userOp-revert phrasing (fallback when the preflight returns
  //     'unknown' due to RPC flake and inprocess is the source of truth)
  // Shows an actionable toast (button → the collection's authorize
  // banner) and resets form state; caller bails out without throwing
  // so the generic toastError path doesn't fire. Gated on the
  // *currently selected* collection (could come from the URL prop or
  // from the picker) and skipped for the platform default — a userOp
  // revert against PLATFORM_COLLECTION isn't one our user can fix
  // from a creator banner, so the raw error is more honest there.
  function maybeHandleAuthError(raw: string, data?: { code?: unknown }): boolean {
    const isAuthCode = data?.code === 'AUTHORIZE_REQUIRED'
    const isAuthRevert = /useroperation reverted|user operation reverted|execution reverted/i.test(raw)
    if (isPlatformDefault || (!isAuthCode && !isAuthRevert)) {
      return false
    }
    toast.error('Authorization required', {
      id: 'mint',
      description:
        "This collection hasn't authorized Kismet for minting. One-time onchain grant from your wallet.",
      action: {
        label: 'Authorize',
        onClick: () => router.push(`/collection/${targetCollection}`),
      },
    })
    setStep('idle')
    setUploadProgress(0)
    return true
  }

  function addSplit() {
    const addr = splitInput.address.trim()
    const pct = parseFloat(splitInput.pct)
    if (!isAddress(addr)) { toast.error('Invalid address'); return }
    if (isNaN(pct) || pct <= 0 || pct > 100) { toast.error('Allocation must be 1–100'); return }
    if (splitsTotal + pct > 100) { toast.error('Total allocation exceeds 100%'); return }
    // EVM addresses are case-insensitive but 0xSplits' SplitMain rejects
    // byte-level duplicates, so "0xABC" + "0xabc" would revert the deploy.
    const lowerAddr = addr.toLowerCase()
    if (splits.some((s) => s.address.toLowerCase() === lowerAddr)) {
      toast.error('Address already added')
      return
    }
    // When residencies is ON, buildFinalSplits auto-appends RESIDENCIES_ADDRESS
    // at 5%. Letting the user add it manually creates a duplicate that
    // SplitMain rejects.
    if (residenciesEnabled && lowerAddr === RESIDENCIES_ADDRESS.toLowerCase()) {
      toast.error('Residencies is already on below — disable the toggle first to set its allocation manually')
      return
    }
    setSplits((prev) => [...prev, { address: addr, percentAllocation: pct }])
    setSplitInput({ address: '', pct: '' })
  }

  const MAX_FILE_BYTES = 50 * 1024 * 1024
  const TEXT_MAX = 5000

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.size > MAX_FILE_BYTES) { toast.error('File too large', { description: 'Maximum file size is 50 MB' }); return }
    if (preview) URL.revokeObjectURL(preview)
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    const f = e.dataTransfer.files[0]
    if (!f) return
    if (f.size > MAX_FILE_BYTES) { toast.error('File too large', { description: 'Maximum file size is 50 MB' }); return }
    if (preview) URL.revokeObjectURL(preview)
    setFile(f)
    setPreview(URL.createObjectURL(f))
  }

  function clearFile() {
    setFile(null)
    if (preview) URL.revokeObjectURL(preview)
    setPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Builds the final splits array to send to the API. Inprocess docs require
  // integer `percentAllocation` summing to exactly 100% — every code path
  // here emits integers via roundToIntegerAllocations + appends residencies
  // (5%) when the toggle is on.
  //
  //   residencies OFF + 0/1 splits  → undefined (caller uses payoutRecipient)
  //   residencies OFF + 2+ splits   → sorted user splits (rounded to integers)
  //   residencies ON  + 0/1 splits  → [creator 95, residencies 5] (sorted)
  //   residencies ON  + 2+ splits   → user splits scaled ×0.95 to integers
  //                                   summing to 95, plus residencies 5
  //
  // 0xSplits' SplitMain requires `accounts` sorted ascending — sort
  // defensively in case inprocess forwards our array as-is.
  function buildFinalSplits(): Split[] | undefined {
    if (!residenciesEnabled) {
      if (splits.length < 2) return undefined
      const rounded = roundToIntegerAllocations(
        splits.map((s) => s.percentAllocation),
        100,
      )
      return sortSplits(
        splits.map((s, i) => ({ address: s.address, percentAllocation: rounded[i] })),
      )
    }
    if (splits.length < 2) {
      return sortSplits([
        { address: address!, percentAllocation: 95 },
        { address: RESIDENCIES_ADDRESS, percentAllocation: 5 },
      ])
    }
    const rounded = roundToIntegerAllocations(
      splits.map((s) => s.percentAllocation * 0.95),
      95,
    )
    return sortSplits([
      ...splits.map((s, i) => ({ address: s.address, percentAllocation: rounded[i] })),
      { address: RESIDENCIES_ADDRESS, percentAllocation: 5 },
    ])
  }

  async function handleMint(e: React.FormEvent) {
    e.preventDefault()

    if (!isConnected || !address) { openConnectModal?.(); return }
    if (!name.trim()) { toast.error('Please enter a title'); return }
    if (mintMode === 'media' && !file) { toast.error('Please select a file to mint'); return }
    if (mintMode === 'text' && !textContent.trim()) { toast.error('Please enter text content'); return }
    if (mintMode === 'text' && textContent.length > TEXT_MAX) {
      toast.error(`Text exceeds ${TEXT_MAX.toLocaleString()} character limit`)
      return
    }
    if (splits.length === 1) { toast.error('Splits require at least 2 recipients'); return }
    if (splits.length > 1 && Math.round(splitsTotal * 100) !== 10000) {
      toast.error(`Split allocations must sum to 100% (currently ${splitsTotal}%)`)
      return
    }
    // Defense in depth: catches any state drift where residencies got into
    // custom splits while the toggle is also on (e.g. via stale tab state).
    if (residenciesEnabled && splits.some((s) => s.address.toLowerCase() === RESIDENCIES_ADDRESS.toLowerCase())) {
      toast.error('Residencies is in your custom splits — remove it or disable the toggle')
      return
    }

    const rawPrice = price.trim()
    const normalizedPrice = !rawPrice || rawPrice === '.' ? '0' : rawPrice.startsWith('.') ? `0${rawPrice}` : rawPrice
    // ETH: 18 decimals (parseEther). USDC: 6 decimals (parseUnits with 6).
    // erc20Mint type also requires the currency address per inprocess docs
    // (moment/create/salesConfig.mdx). Native ETH uses fixedPrice with no
    // currency field.
    const priceInBaseUnits = priceCurrency === 'usdc'
      ? parseUnits(normalizedPrice, 6).toString()
      : parseEther(normalizedPrice).toString()
    const now = Math.floor(Date.now() / 1000)
    const salesConfig = priceCurrency === 'usdc'
      ? {
          type: 'erc20Mint' as const,
          pricePerToken: priceInBaseUnits,
          saleStart: String(now),
          saleEnd: '18446744073709551615',
          currency: USDC_BASE,
        }
      : {
          type: 'fixedPrice' as const,
          pricePerToken: priceInBaseUnits,
          saleStart: String(now),
          saleEnd: '18446744073709551615',
        }
    const supplyTrimmed = maxSupply.trim()
    if (supplyTrimmed) {
      const supplyNum = parseInt(supplyTrimmed, 10)
      if (isNaN(supplyNum) || supplyNum < 1) { toast.error('Supply must be at least 1'); return }
    }
    const maxSupplyVal = supplyTrimmed ? parseInt(supplyTrimmed, 10) : undefined

    const finalSplits = buildFinalSplits()

    try {
      if (mintMode === 'text') {
        setStep('minting')
        toast.loading('Minting moment…', { id: 'mint' })

        // Writing-moment payload per inprocess docs (moment/create/writing.mdx):
        // - `title` lives at the top level (not inside token, and not aliased as "name")
        // - the writing body lives at `token.tokenContent` (not "content")
        // The top-level `name` is our private hint that mint-proxy strips before
        // forwarding upstream — used to populate the moment-meta KV entry.
        const payload = {
          title: name.trim(),
          contract: { address: targetCollection },
          token: {
            tokenContent: textContent.trim(),
            createReferral: CREATE_REFERRAL,
            salesConfig,
            mintToCreatorCount: 1,
            ...(maxSupplyVal !== undefined ? { maxSupply: maxSupplyVal } : {}),
            ...(finalSplits ? {} : { payoutRecipient: address }),
          },
          name: name.trim(),
          account: address,
          ...(finalSplits ? { splits: finalSplits } : {}),
        }

        const res = await fetch('/api/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const errors = Array.isArray(data.errors)
            ? ': ' + data.errors.map((e: { field?: string; message?: string }) => `${e.field ?? ''} ${e.message ?? ''}`.trim()).join(', ')
            : ''
          const raw = (data.detail ?? data.error ?? data.message ?? 'Mint failed') + errors
          // The userOp-revert path replaces the toast with an actionable
          // one (button → collection's authorize banner) and bails out;
          // anything else falls through to the generic toastError below.
          if (maybeHandleAuthError(raw, data)) return
          throw new Error(raw)
        }
        if (!data.tokenId) throw new Error('Mint succeeded but no tokenId returned')
        setResult(data)
        setStep('done')
        toast.success('Minted!', { id: 'mint', description: `Token #${data.tokenId}` })

      } else {
        // media mode — ensure session once (cookie cached, no re-prompt)
        await ensureSession()

        setStep('uploading-media')
        setUploadProgress(0)
        toast.loading('Uploading media to Arweave…', { id: 'mint' })
        const mediaUri = await uploadToArweave(file!, (pct) => {
          setUploadProgress(pct)
          toast.loading(`Uploading media… ${pct}%`, { id: 'mint' })
        })

        setStep('uploading-metadata')
        setUploadProgress(0)
        toast.loading('Uploading metadata…', { id: 'mint' })
        const metadata = {
          name: name.trim(),
          description: description.trim(),
          image: mediaUri,
          ...(file!.type.startsWith('video/') ? { animation_url: mediaUri } : {}),
        }
        const metadataUri = await uploadJson(metadata)

        // HEAD-poll both URIs before kicking off the on-chain mint.
        // Turbo confirms ingestion before the gateway has propagated, so
        // jumping straight to /api/mint can produce a moment whose
        // metadata fetches 404 at indexing time. 45s budget covers the
        // typical propagation window; on timeout we surface a retry
        // message rather than commit a broken moment.
        setStep('verifying-upload')
        toast.loading('Verifying Arweave propagation…', { id: 'mint' })
        const [mediaOk, metadataOk] = await Promise.all([
          verifyArweaveAvailable(mediaUri),
          verifyArweaveAvailable(metadataUri),
        ])
        if (!mediaOk || !metadataOk) {
          throw new Error('Arweave still settling — try again in a minute')
        }

        setStep('minting')
        toast.loading('Minting moment…', { id: 'mint' })

        const payload: CreateMomentPayload & { name: string } = {
          contract: { address: targetCollection },
          token: {
            tokenMetadataURI: metadataUri,
            createReferral: CREATE_REFERRAL,
            salesConfig,
            mintToCreatorCount: 1,
            ...(maxSupplyVal !== undefined ? { maxSupply: maxSupplyVal } : {}),
            ...(finalSplits ? {} : { payoutRecipient: address }),
          },
          name: name.trim(),
          account: address!,
          ...(finalSplits ? { splits: finalSplits } : {}),
        }

        const res = await fetch('/api/mint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const errors = Array.isArray(data.errors)
            ? ': ' + data.errors.map((e: { field?: string; message?: string }) => `${e.field ?? ''} ${e.message ?? ''}`.trim()).join(', ')
            : ''
          const raw = (data.detail ?? data.error ?? data.message ?? 'Mint failed') + errors
          // The userOp-revert path replaces the toast with an actionable
          // one (button → collection's authorize banner) and bails out;
          // anything else falls through to the generic toastError below.
          if (maybeHandleAuthError(raw, data)) return
          throw new Error(raw)
        }
        if (!data.tokenId) throw new Error('Mint succeeded but no tokenId returned')
        setResult(data)
        setStep('done')
        toast.success('Minted!', { id: 'mint', description: `Token #${data.tokenId}` })
      }
    } catch (err) {
      setStep('idle')
      setUploadProgress(0)
      toastError('Mint', err, { id: 'mint' })
    }
  }

  const isBusy = step !== 'idle' && step !== 'done'

  if (step === 'done' && result) {
    return (
      <div className="border border-[#2a2a2a] p-8 text-center flex flex-col gap-6">
        <div className="w-12 h-12 mx-auto rounded-full bg-[#8B5CF6]/10 border border-[#8B5CF6] flex items-center justify-center">
          <span className="text-xl accent-grad">✓</span>
        </div>
        <div>
          <h3 className="text-[#efefef] font-mono text-sm mb-2">Moment minted</h3>
          <p className="text-[#888] text-xs font-mono">Token #{result.tokenId}</p>
        </div>
        <div className="flex flex-col gap-2">
          <a
            href={`https://inprocess.world/collect/base:${result.contractAddress}/${result.tokenId}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono accent-grad hover:underline"
          >
            View on in•process →
          </a>
          <a
            href={`https://basescan.org/tx/${result.hash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-[#555] hover:text-[#888]"
          >
            {result.hash.slice(0, 10)}…{result.hash.slice(-8)}
          </a>
        </div>
        <button
          onClick={() => {
            setStep('idle')
            setResult(null)
            clearFile()
            setTextContent('')
            setName('')
            setDescription('')
            setPrice('0')
            setMaxSupply('')
            setSplits([])
            setSplitInput({ address: '', pct: '' })
          }}
          className="text-xs font-mono text-[#888] hover:text-[#efefef] underline"
        >
          Mint another
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleMint} className="flex flex-col gap-6">
      {/* Media / Text toggle */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-mono text-[#888] uppercase tracking-wider">
            {mintMode === 'media' ? 'Media' : 'Content'} <span className="text-[#efefef]">*</span>
          </label>
          <button
            type="button"
            onClick={() => switchMode(mintMode === 'text' ? 'media' : 'text')}
            className={`px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border transition-colors ${
              mintMode === 'text' ? 'border-[#555] text-[#efefef]' : 'border-[#2a2a2a] text-[#555] hover:text-[#888]'
            }`}
          >
            text
          </button>
        </div>

        {mintMode === 'media' ? (
          <>
            {preview ? (
              // No aspect constraint on the wrapper — image/video render at
              // full width with auto height, so the box conforms to whatever
              // the artist dropped. 16:9 stays 16:9, 9:16 stays 9:16, 1:1
              // stays 1:1. No letterbox, no crop, no surprise.
              <div className="relative bg-[#111] border border-[#2a2a2a] overflow-hidden">
                {file?.type.startsWith('video/') ? (
                  <video src={preview} className="block w-full h-auto" muted autoPlay loop playsInline />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="preview" className="block w-full h-auto" />
                )}
                <button
                  type="button"
                  onClick={clearFile}
                  className="absolute top-2 right-2 w-7 h-7 bg-[#0d0d0d]/80 border border-[#2a2a2a] flex items-center justify-center hover:border-[#888]"
                >
                  <X size={14} className="text-[#888]" />
                </button>
              </div>
            ) : (
              <div
                onClick={() => fileInputRef.current?.click()}
                onDrop={handleDrop}
                onDragOver={(e) => e.preventDefault()}
                // Compact square placeholder. The preview state below is
                // dynamic (block w-full h-auto), so the drop zone aspect
                // doesn't need to match anything specific — square keeps the
                // empty target obvious without dominating the form. Same
                // aspect as the cover-image drop zone for visual consistency.
                className="aspect-square border border-dashed border-[#2a2a2a] flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-[#888] transition-colors bg-[#111]"
              >
                <Upload size={24} className="text-[#555]" />
                <div className="text-center">
                  <p className="text-xs font-mono text-[#555]">drop file or click to upload</p>
                  <p className="text-xs font-mono text-[#333] mt-1">image, video, gif</p>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,.gif"
              onChange={handleFileChange}
              className="hidden"
            />
          </>
        ) : (
          <>
            <textarea
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              placeholder="write your moment…"
              rows={12}
              className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] resize-none"
            />
            <div
              className={`mt-1.5 text-right text-[10px] font-mono ${
                textContent.length > TEXT_MAX ? 'accent-grad' : 'text-[#555]'
              }`}
            >
              {textContent.length.toLocaleString()} / {TEXT_MAX.toLocaleString()}
            </div>
          </>
        )}
      </div>

      {/* Title */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Title <span className="text-[#efefef]">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="untitled"
          required
          className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
        />
      </div>

      {/* Description — only meaningful for media moments (goes into Arweave
          metadata). The inprocess writing endpoint has no description field. */}
      {mintMode === 'media' && (
        <div>
          <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="describe your work…"
            rows={3}
            className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] resize-none"
          />
        </div>
      )}

      {/* Collections picker — optional; if the user doesn't pick one, the
          platform default is used implicitly. */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Collections
        </label>
        <div className="flex items-stretch gap-1.5">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="flex-1 min-w-0 flex items-center gap-3 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 hover:border-[#555] transition-colors text-left"
          >
            {!isPlatformDefault && selectedCollection.image ? (
              <div className="w-8 h-8 relative flex-shrink-0 bg-[#1a1a1a] overflow-hidden">
                <Image
                  src={resolveUri(selectedCollection.image)}
                  alt=""
                  fill
                  className="object-cover"
                  sizes="32px"
                />
              </div>
            ) : !isPlatformDefault ? (
              <div className="w-8 h-8 bg-[#1a1a1a] flex-shrink-0" />
            ) : null}
            <span className={`text-sm font-mono truncate flex-1 ${isPlatformDefault ? 'text-[#555]' : 'text-[#efefef]'}`}>
              {isPlatformDefault
                ? loadingCollections
                  ? 'loading collections…'
                  : 'no collection'
                : selectedCollection.name}
            </span>
            <span className="text-[#555] text-xs font-mono flex-shrink-0">
              {pickerOpen ? '▲' : '▼'}
            </span>
          </button>
          {!isPlatformDefault && (
            <button
              type="button"
              onClick={() => setSelectedCollection(PLATFORM_OPTION)}
              className="px-3 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#888] transition-colors"
              title="Clear selection"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {pickerOpen && (
          <div className="border border-t-0 border-[#2a2a2a] bg-[#0d0d0d] max-h-64 overflow-y-auto">
            {collectionOptions.length === 0 ? (
              <p className="text-xs font-mono text-[#555] px-3 py-4">
                {loadingCollections
                  ? 'loading…'
                  : isConnected
                    ? 'no collections created'
                    : 'connect a wallet to see your collections'}
              </p>
            ) : (
              <div className="grid grid-cols-3 gap-px bg-[#2a2a2a]">
                {collectionOptions.map((c, idx) => {
                  const img = c.image ? resolveUri(c.image) : null
                  const isSelected =
                    c.address.toLowerCase() === selectedCollection.address.toLowerCase()
                  return (
                    <button
                      key={c.address}
                      type="button"
                      onClick={() => {
                        setSelectedCollection(c)
                        setPickerOpen(false)
                      }}
                      className={`relative aspect-square bg-[#111] overflow-hidden group ${
                        isSelected ? 'ring-2 ring-inset ring-[#8B5CF6]' : ''
                      }`}
                    >
                      {img ? (
                        <Image
                          src={img}
                          alt={c.name}
                          fill
                          className="object-cover"
                          sizes="120px"
                          priority={idx < 6}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-[#333] font-mono text-[10px]">
                            {shortAddress(c.address)}
                          </span>
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <p className="text-[9px] font-mono text-[#efefef] truncate">{c.name}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Price + Supply */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
            Price
          </label>
          <div className="relative">
            <input
              type="text"
              inputMode="decimal"
              value={price}
              onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setPrice(v) }}
              className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] pr-14"
            />
            <button
              type="button"
              onClick={() => setPriceCurrency((c) => c === 'eth' ? 'usdc' : 'eth')}
              title="toggle currency"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-mono text-[#888] hover:text-[#efefef] transition-colors px-1.5 py-0.5 rounded"
            >
              {priceCurrency === 'eth' ? 'ETH' : 'USDC'}
            </button>
          </div>
          {price === '0' && (
            <p className="text-xs text-[#555] font-mono mt-1">free mint</p>
          )}
        </div>

        <div className="flex-1">
          <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
            Supply
          </label>
          <input
            type="text"
            inputMode="numeric"
            value={maxSupply}
            onChange={(e) => { const v = e.target.value; if (v === '' || /^[1-9]\d*$/.test(v)) setMaxSupply(v) }}
            placeholder="unlimited"
            className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
          />
          {!maxSupply.trim() && (
            <p className="text-xs text-[#555] font-mono mt-1">open edition</p>
          )}
        </div>
      </div>

      {/* Revenue splits */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Revenue Splits
        </label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={splitInput.address}
            onChange={(e) => setSplitInput((s) => ({ ...s, address: e.target.value }))}
            placeholder="0x… address"
            className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
          />
          <input
            type="number"
            value={splitInput.pct}
            onChange={(e) => setSplitInput((s) => ({ ...s, pct: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSplit() } }}
            placeholder="%"
            min="1"
            max="100"
            className="w-16 bg-[#111] border border-[#2a2a2a] px-2 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
          />
          <button
            type="button"
            onClick={addSplit}
            className="px-3 border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        {splits.length > 0 && (
          <ul className="flex flex-col gap-1 mb-2">
            {splits.map((s) => (
              <li key={s.address} className="flex items-center justify-between bg-[#111] border border-[#2a2a2a] px-3 py-2">
                <span className="text-xs font-mono text-[#888] truncate">{s.address}</span>
                <div className="flex items-center gap-3 ml-2 flex-shrink-0">
                  <span className="text-xs font-mono text-[#efefef]">{s.percentAllocation}%</span>
                  <button
                    type="button"
                    onClick={() => setSplits((prev) => prev.filter((r) => r.address !== s.address))}
                    className="text-[#555] hover:text-[#888]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {splits.length > 0 && (
          <p className={`text-xs font-mono ${splitsTotal === 100 ? 'text-[#555]' : 'accent-grad'}`}>
            {splitsTotal}% allocated{splitsTotal < 100 ? ` — ${100 - splitsTotal}% remaining` : ' ✓'}
          </p>
        )}
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isBusy}
        className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent"
      >
        {!isConnected
          ? 'connect wallet to mint'
          : isBusy
          ? stepLabel(step, uploadProgress)
          : 'mint'}
      </button>

      {/* Residencies toggle */}
      <div className="flex items-center gap-2.5 w-fit mx-auto -mt-2">
        <button
          type="button"
          onClick={() => {
            setResidenciesEnabled((v) => {
              if (v) return false
              // Turning ON — block if residencies is already in custom splits
              // (would otherwise duplicate when buildFinalSplits auto-appends).
              const dup = splits.some(
                (s) => s.address.toLowerCase() === RESIDENCIES_ADDRESS.toLowerCase(),
              )
              if (dup) {
                toast.error('Remove residencies from your custom splits before enabling the toggle')
                return false
              }
              return true
            })
          }}
          aria-pressed={residenciesEnabled}
          className="flex-shrink-0"
        >
          <div className={`relative w-8 h-4 rounded-full transition-colors ${residenciesEnabled ? 'bg-[#8B5CF6]' : 'bg-[#2a2a2a] border border-[#3a3a3a]'}`}>
            <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${residenciesEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
          </div>
        </button>
        <span className={`text-[10px] font-mono ${residenciesEnabled ? 'text-[#888]' : 'text-[#444]'}`}>
          {residenciesEnabled ? '5%' : '0%'} to{' '}
          <a
            href="https://kismetcasa.xyz"
            target="_blank"
            rel="noopener noreferrer"
            title="kismetcasa.xyz (opens in new tab)"
            className="underline hover:text-[#efefef] transition-colors"
          >
            kismet casa residencies
          </a>
        </span>
      </div>
    </form>
  )
}

function stepLabel(step: string, progress: number): string {
  switch (step) {
    case 'uploading-media': return progress > 0 ? `uploading media… ${progress}%` : 'uploading media…'
    case 'uploading-metadata': return 'uploading metadata…'
    case 'verifying-upload': return 'verifying Arweave propagation…'
    case 'minting': return 'minting…'
    default: return 'working…'
  }
}
