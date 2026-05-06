'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { parseEventLogs, isAddress, parseEther } from 'viem'
import { toast } from 'sonner'
import { Upload, X, Plus, Trash2, Check } from 'lucide-react'
import { FACTORY_ADDRESS, FACTORY_ABI, encodeMinterPermission, buildCoverTokenSetupActions } from '@/lib/collections'
import { CREATE_REFERRAL } from '@/lib/config'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { useUploadSession } from '@/hooks/useUploadSession'
import { humanError } from '@/lib/toast'
import { useEnsureBase } from '@/lib/useEnsureBase'

interface CreateCollectionFormProps {
  onDeployed?: (address: string, name: string) => void
}

export function CreateCollectionForm({ onDeployed }: CreateCollectionFormProps = {}) {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { ensureSession } = useUploadSession()

  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverPreview, setCoverPreview] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [royaltyBps, setRoyaltyBps] = useState('500')
  const [royaltyRecipient, setRoyaltyRecipient] = useState('')
  const [minters, setMinters] = useState<string[]>([])
  const [minterInput, setMinterInput] = useState('')
  const [mintCover, setMintCover] = useState(false)
  const [coverPrice, setCoverPrice] = useState('0')
  const [coverSupply, setCoverSupply] = useState('')
  const [step, setStep] = useState<'idle' | 'uploading-image' | 'uploading-metadata' | 'deploying' | 'done'>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [collectionAddress, setCollectionAddress] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  const [deployedImageUri, setDeployedImageUri] = useState<string | undefined>(undefined)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()

  // Recovery + timeout for in-flight deploys (industry-standard pattern).
  // Persisted to localStorage so a refresh, tab close, or wallet disconnect
  // mid-deploy doesn't lose the tx — we resume the receipt watch on next
  // mount, register KV when it confirms, and redirect to the collection.
  const PENDING_KEY = address ? `kismetart:pending-deploy:${address.toLowerCase()}` : ''
  const PENDING_MAX_AGE_MS = 30 * 60 * 1000 // 30 min — older entries are abandoned
  const TX_TIMEOUT_MS = 90 * 1000 // 90s before we surface a "still pending" message

  function addMinter() {
    const addr = minterInput.trim()
    if (!isAddress(addr)) { toast.error('Invalid address'); return }
    if (minters.includes(addr)) return
    setMinters((prev) => [...prev, addr])
    setMinterInput('')
  }

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash && step === 'deploying' },
  })

  // 1. Recovery on mount: if a deploy was in flight when the user left the
  //    page, restore the txHash + form state and resume the receipt watch.
  useEffect(() => {
    if (!address || !PENDING_KEY) return
    try {
      const raw = localStorage.getItem(PENDING_KEY)
      if (!raw) return
      const pending = JSON.parse(raw) as {
        txHash: `0x${string}`
        name: string
        description: string
        deployedImageUri: string
        mintCover: boolean
        startedAt: number
      }
      if (Date.now() - pending.startedAt > PENDING_MAX_AGE_MS) {
        localStorage.removeItem(PENDING_KEY)
        return
      }
      setName(pending.name)
      setDescription(pending.description)
      setDeployedImageUri(pending.deployedImageUri || undefined)
      setMintCover(pending.mintCover)
      setTxHash(pending.txHash)
      setStep('deploying')
      toast.loading('Resuming deploy…', { id: 'create-collection' })
    } catch {}
    // We only want this on initial mount per address; intentionally narrow deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  // 2. Persist the in-flight tx so a refresh can resume it. Triggered as soon
  //    as we have a txHash and we're in the deploying state.
  useEffect(() => {
    if (!PENDING_KEY || step !== 'deploying' || !txHash) return
    try {
      localStorage.setItem(
        PENDING_KEY,
        JSON.stringify({
          txHash,
          name: name.trim(),
          description: description.trim(),
          deployedImageUri: deployedImageUri ?? '',
          mintCover,
          startedAt: Date.now(),
        }),
      )
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txHash, step])

  // 3. Stuck-tx warning: if we're still waiting for the receipt after 90s,
  //    surface a clearer message with a link to basescan so the user has
  //    options instead of staring at "Deploying…" indefinitely.
  useEffect(() => {
    if (step !== 'deploying' || !txHash) return
    const timer = setTimeout(() => {
      toast.loading(
        'Tx still pending — refresh later to resume, or check status on basescan',
        {
          id: 'create-collection',
          description: `https://basescan.org/tx/${txHash}`,
        },
      )
    }, TX_TIMEOUT_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, txHash])

  useEffect(() => {
    if (!receipt || step !== 'deploying') return

    const clearPending = () => {
      if (PENDING_KEY) {
        try { localStorage.removeItem(PENDING_KEY) } catch {}
      }
    }

    if (receipt.status === 'reverted') {
      clearPending()
      setStep('idle')
      setTxHash(undefined)
      setUploadProgress(0)
      toast.error('Transaction reverted', { id: 'create-collection', description: 'The deploy transaction failed on-chain.' })
      return
    }
    const logs = parseEventLogs({
      abi: FACTORY_ABI,
      eventName: 'SetupNewContract',
      logs: receipt.logs,
    })
    // Only trust the parsed factory event. Falling back to logs[0]?.address
    // would resolve to any unrelated contract that happened to emit a log.
    const deployedAddress = (logs[0]?.args?.newContract as string | undefined) ?? null

    if (!deployedAddress) {
      // Tx confirmed but no SetupNewContract event — wrong chain / contract.
      clearPending()
      setStep('idle')
      setTxHash(undefined)
      toast.error('Deploy incomplete', {
        id: 'create-collection',
        description: 'Tx confirmed but no collection address was emitted — likely wrong chain or contract.',
      })
      return
    }

    setCollectionAddress(deployedAddress)

    // Cookie auth: the session was already established before the deploy
    // (ensureSession ran on Arweave upload), so this call rides on the same
    // session and the server can verify the caller matches `artist` and is
    // the on-chain admin of `address`.
    fetch('/api/collections', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: deployedAddress,
        name: name.trim(),
        description: description.trim() || undefined,
        image: deployedImageUri,
        artist: address,
      }),
    }).catch(() => {})
    onDeployed?.(deployedAddress, name)

    clearPending()
    setStep('done')
    toast.success(
      mintCover ? 'Collection deployed + cover minted!' : 'Collection deployed!',
      { id: 'create-collection' },
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, step])

  // Once everything (deploy + optional cover mint) finishes, route to the new collection.
  useEffect(() => {
    if (step !== 'done' || !collectionAddress) return
    router.push(`/collection/${collectionAddress}`)
  }, [step, collectionAddress, router])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (coverPreview) URL.revokeObjectURL(coverPreview)
    setCoverFile(f)
    setCoverPreview(URL.createObjectURL(f))
  }

  function clearFile() {
    setCoverFile(null)
    if (coverPreview) URL.revokeObjectURL(coverPreview)
    setCoverPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()

    if (!isConnected || !address) {
      openConnectModal?.()
      return
    }
    if (!coverFile) {
      toast.error('Please add a cover image')
      return
    }
    if (!name.trim()) {
      toast.error('Please enter a collection name')
      return
    }
    if (royaltyRecipient.trim() && !isAddress(royaltyRecipient.trim())) {
      toast.error('Invalid royalty recipient address')
      return
    }
    if (mintCover && coverSupply.trim()) {
      const s = parseInt(coverSupply.trim(), 10)
      if (isNaN(s) || s < 1) { toast.error('Cover supply must be at least 1'); return }
    }

    setDeployedImageUri(undefined)

    try {
      // Ensure session once — httpOnly cookie set, no re-prompt for 7 days
      await ensureSession()

      setStep('uploading-image')
      setUploadProgress(0)
      toast.loading('Uploading cover image…', { id: 'create-collection' })
      const imageUri = await uploadToArweave(coverFile, (pct) => {
        setUploadProgress(pct)
        toast.loading(`Uploading image… ${pct}%`, { id: 'create-collection' })
      })
      setDeployedImageUri(imageUri)

      setStep('uploading-metadata')
      toast.loading('Uploading collection metadata…', { id: 'create-collection' })
      const metadata: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim(),
        image: imageUri,
        createReferral: CREATE_REFERRAL,
      }
      const contractURI = await uploadJson(metadata)

      setStep('deploying')
      toast.loading(
        mintCover ? 'Deploying collection + cover token…' : 'Deploying collection…',
        { id: 'create-collection' },
      )

      await ensureBase()

      const bps = Math.max(0, Math.min(10000, parseInt(royaltyBps, 10) || 0))
      const recipient = (royaltyRecipient.trim() || address) as `0x${string}`

      // Collection-wide minter permissions for any addresses the user added.
      // The factory replays each setupAction on the new collection during deploy.
      const minterActions = minters
        .filter((m) => isAddress(m))
        .map((m) => encodeMinterPermission(m as `0x${string}`))

      // If cover mint is enabled, append the cover-token setupActions so the
      // token is created in the same transaction. Mirrors how inprocess.world's
      // own frontend does it (see lib/protocolSdk/create/token-setup.ts in
      // their public repo). The factory acts as transient admin to run these.
      let coverActions: `0x${string}`[] = []
      if (mintCover) {
        const rawCoverPrice = coverPrice.trim()
        const normalizedCoverPrice = !rawCoverPrice || rawCoverPrice === '.'
          ? '0'
          : rawCoverPrice.startsWith('.')
            ? `0${rawCoverPrice}`
            : rawCoverPrice
        const priceWei = parseEther(normalizedCoverPrice)
        const maxSupplyVal = coverSupply.trim() ? BigInt(parseInt(coverSupply, 10)) : undefined
        const now = BigInt(Math.floor(Date.now() / 1000))
        const farFuture = 18446744073709551615n // max uint64
        coverActions = buildCoverTokenSetupActions({
          tokenURI: contractURI,
          maxSupply: maxSupplyVal,
          createReferral: CREATE_REFERRAL as `0x${string}`,
          pricePerTokenWei: priceWei,
          saleStart: now,
          saleEnd: farFuture,
          fundsRecipient: address,
          creator: address,
          mintToCreatorCount: 1,
        })
      }

      const setupActions = [...minterActions, ...coverActions]

      const hash = await writeContractAsync({
        chainId: base.id,
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: 'createContract',
        args: [
          contractURI,
          name.trim(),
          {
            royaltyMintSchedule: 0,
            royaltyBPS: bps,
            royaltyRecipient: recipient,
          },
          address,
          setupActions,
        ],
      })

      setTxHash(hash)
    } catch (err) {
      // Clear any half-written pending state so a refresh doesn't try to
      // resume a deploy that never broadcast.
      if (PENDING_KEY) {
        try { localStorage.removeItem(PENDING_KEY) } catch {}
      }
      setStep('idle')
      setUploadProgress(0)
      toast.error('Deploy failed', { id: 'create-collection', description: humanError(err) })
    }
  }

  const isBusy = step !== 'idle' && step !== 'done'

  if (step === 'done' && collectionAddress) {
    return (
      <div className="border border-[#2a2a2a] p-8 text-center flex flex-col gap-6">
        <div className="w-12 h-12 mx-auto rounded-full bg-[#8B5CF6]/10 border border-[#8B5CF6] flex items-center justify-center">
          <span className="text-xl accent-grad">✓</span>
        </div>
        <div>
          <h3 className="text-[#efefef] font-mono text-sm mb-2">Collection deployed</h3>
          <p className="text-[#888] text-xs font-mono break-all">{collectionAddress}</p>
        </div>
        <div className="flex flex-col gap-2">
          <a
            href={`https://inprocess.world/collect/base:${collectionAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono accent-grad hover:underline"
          >
            View on in•process →
          </a>
          {txHash && (
            <a
              href={`https://basescan.org/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-[#555] hover:text-[#888]"
            >
              {txHash.slice(0, 10)}…{txHash.slice(-8)}
            </a>
          )}
        </div>
        <button
          onClick={() => {
            setStep('idle')
            setCollectionAddress(null)
            setTxHash(undefined)
            clearFile()
            setName('')
            setDescription('')
            setRoyaltyBps('500')
            setRoyaltyRecipient('')
            setMinters([])
            setMinterInput('')
            setMintCover(false)
            setCoverPrice('0')
            setCoverSupply('')
            setDeployedImageUri(undefined)
          }}
          className="text-xs font-mono text-[#888] hover:text-[#efefef] underline"
        >
          Create another
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleCreate} className="flex flex-col gap-6">
      {/* Cover image */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-mono text-[#888] uppercase tracking-wider">
            Cover Image <span className="text-[#efefef]">*</span>
          </span>
          <div className="flex items-center gap-1.5">
            {mintCover && (
              <>
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={coverPrice}
                    onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setCoverPrice(v) }}
                    placeholder="0"
                    className="w-14 bg-[#111] border border-[#2a2a2a] px-2 py-0.5 text-[11px] text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
                  />
                  <span className="text-[10px] font-mono text-[#555]">eth</span>
                </div>
                <input
                  type="text"
                  inputMode="numeric"
                  value={coverSupply}
                  onChange={(e) => { const v = e.target.value; if (v === '' || /^[1-9]\d*$/.test(v)) setCoverSupply(v) }}
                  placeholder="∞"
                  className="w-14 bg-[#111] border border-[#2a2a2a] px-2 py-0.5 text-[11px] text-[#efefef] font-mono placeholder-[#333] placeholder:text-[16px] placeholder:leading-none focus:outline-none focus:border-[#555]"
                />
              </>
            )}
            <button
              type="button"
              onClick={() => setMintCover((v) => !v)}
              title={mintCover ? 'cancel mint' : 'also mint as first token'}
              className={`w-4 h-4 border flex items-center justify-center flex-shrink-0 transition-colors ${
                mintCover ? 'border-[#8B5CF6] bg-[#8B5CF6]/10' : 'border-[#2a2a2a] hover:border-[#555]'
              }`}
            >
              {mintCover && <Check size={9} className="text-[#8B5CF6]" />}
            </button>
          </div>
        </div>
        {coverPreview ? (
          <div className="relative aspect-video bg-[#111] border border-[#2a2a2a] overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverPreview} alt="cover preview" className="w-full h-full object-cover" />
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
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files[0]
              if (!f) return
              if (coverPreview) URL.revokeObjectURL(coverPreview)
              setCoverFile(f)
              setCoverPreview(URL.createObjectURL(f))
            }}
            onDragOver={(e) => e.preventDefault()}
            className="aspect-video border border-dashed border-[#2a2a2a] flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-[#888] transition-colors bg-[#111]"
          >
            <Upload size={24} className="text-[#555]" />
            <div className="text-center">
              <p className="text-xs font-mono text-[#555]">drop image or click to upload</p>
              <p className="text-xs font-mono text-[#333] mt-1">image, gif</p>
            </div>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.gif"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Collection name */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Collection Name <span className="text-[#efefef]">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my collection"
          required
          className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="describe your collection…"
          rows={3}
          className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] resize-none"
        />
      </div>

      {/* Royalty */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Royalty (%)
        </label>
        <div className="relative">
          <input
            type="number"
            value={royaltyBps === '0' ? '' : String(parseInt(royaltyBps, 10) / 100)}
            onChange={(e) => {
              const pct = parseFloat(e.target.value) || 0
              setRoyaltyBps(String(Math.round(pct * 100)))
            }}
            min="0"
            max="100"
            step="0.5"
            placeholder="5"
            className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] pr-8"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-[#555]">%</span>
        </div>
        <p className="text-xs text-[#555] font-mono mt-1">paid to your wallet on secondary sales</p>
      </div>

      {/* Royalty recipient */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Royalty Recipient
        </label>
        <input
          type="text"
          value={royaltyRecipient}
          onChange={(e) => setRoyaltyRecipient(e.target.value)}
          placeholder={address ?? '0x… (defaults to your wallet)'}
          className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
        />
      </div>

      {/* Authorized minters */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Authorized Minters
        </label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={minterInput}
            onChange={(e) => setMinterInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              addMinter()
            }}
            placeholder="0x… wallet address"
            className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
          />
          <button
            type="button"
            onClick={addMinter}
            className="px-3 border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        {minters.length > 0 && (
          <ul className="flex flex-col gap-1">
            {minters.map((m) => (
              <li key={m} className="flex items-center justify-between bg-[#111] border border-[#2a2a2a] px-3 py-2">
                <span className="text-xs font-mono text-[#888] truncate">{m}</span>
                <button
                  type="button"
                  onClick={() => setMinters((prev) => prev.filter((x) => x !== m))}
                  className="ml-2 text-[#555] hover:text-[#888] flex-shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isBusy}
        className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent"
      >
        {!isConnected
          ? 'connect wallet to deploy'
          : isBusy
          ? stepLabel(step, uploadProgress)
          : 'create'}
      </button>
    </form>
  )
}

function stepLabel(step: string, progress: number): string {
  switch (step) {
    case 'uploading-image': return progress > 0 ? `uploading image… ${progress}%` : 'uploading image…'
    case 'uploading-metadata': return 'uploading metadata…'
    case 'deploying': return 'deploying…'
    default: return 'working…'
  }
}
