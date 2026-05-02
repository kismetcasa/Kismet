'use client'

import { useState, useRef } from 'react'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Upload, X, Plus, Trash2, ExternalLink } from 'lucide-react'
import { parseEther, isAddress } from 'viem'
import type { CreateMomentPayload, Split } from '@/lib/inprocess'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { useUploadSession } from '@/hooks/useUploadSession'
import { PLATFORM_COLLECTION, CREATE_REFERRAL, RESIDENCIES_ADDRESS } from '@/lib/config'

type MintMode = 'media' | 'text'

interface MintFormProps {
  collectionAddress?: string
}

export function MintForm({ collectionAddress }: MintFormProps = {}) {
  const targetCollection = collectionAddress ?? PLATFORM_COLLECTION
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { ensureSession } = useUploadSession()

  const [mintMode, setMintMode] = useState<MintMode>('media')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [textContent, setTextContent] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('0')
  const [maxSupply, setMaxSupply] = useState('')
  const [splits, setSplits] = useState<Split[]>([])
  const [splitInput, setSplitInput] = useState({ address: '', pct: '' })
  const [residenciesEnabled, setResidenciesEnabled] = useState(true)
  const [step, setStep] = useState<'idle' | 'uploading-media' | 'uploading-metadata' | 'minting' | 'done'>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [result, setResult] = useState<{ hash: string; contractAddress: string; tokenId: string } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const splitsTotal = splits.reduce((s, r) => s + r.percentAllocation, 0)

  function switchMode(mode: MintMode) {
    setMintMode(mode)
    if (mode === 'text') clearFile()
    else setTextContent('')
  }

  function addSplit() {
    const addr = splitInput.address.trim()
    const pct = parseFloat(splitInput.pct)
    if (!isAddress(addr)) { toast.error('Invalid address'); return }
    if (isNaN(pct) || pct <= 0 || pct > 100) { toast.error('Allocation must be 1–100'); return }
    if (splitsTotal + pct > 100) { toast.error('Total allocation exceeds 100%'); return }
    if (splits.some((s) => s.address === addr)) { toast.error('Address already added'); return }
    setSplits((prev) => [...prev, { address: addr, percentAllocation: pct }])
    setSplitInput({ address: '', pct: '' })
  }

  const MAX_FILE_BYTES = 50 * 1024 * 1024

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

  // Builds the final splits array to send to the API.
  // When residencies is off: pass creator splits as-is (or undefined for payoutRecipient).
  // When residencies is on + no custom splits: [creator 95%, residencies 5%].
  // When residencies is on + custom splits: scale each split by ×0.95, append residencies at 5%.
  function buildFinalSplits(): Split[] | undefined {
    if (!residenciesEnabled) return splits.length >= 2 ? splits : undefined
    if (splits.length < 2) {
      return [
        { address: address!, percentAllocation: 95 },
        { address: RESIDENCIES_ADDRESS, percentAllocation: 5 },
      ]
    }
    const scaled = splits.map((s) => ({
      address: s.address,
      percentAllocation: parseFloat((s.percentAllocation * 0.95).toFixed(4)),
    }))
    return [...scaled, { address: RESIDENCIES_ADDRESS, percentAllocation: 5 }]
  }

  async function handleMint(e: React.FormEvent) {
    e.preventDefault()

    if (!isConnected || !address) { openConnectModal?.(); return }
    if (!name.trim()) { toast.error('Please enter a title'); return }
    if (mintMode === 'media' && !file) { toast.error('Please select a file to mint'); return }
    if (mintMode === 'text' && !textContent.trim()) { toast.error('Please enter text content'); return }
    if (splits.length === 1) { toast.error('Splits require at least 2 recipients'); return }
    if (splits.length > 1 && Math.round(splitsTotal * 100) !== 10000) {
      toast.error(`Split allocations must sum to 100% (currently ${splitsTotal}%)`)
      return
    }

    const rawPrice = price.trim()
    const normalizedPrice = !rawPrice || rawPrice === '.' ? '0' : rawPrice.startsWith('.') ? `0${rawPrice}` : rawPrice
    const priceInWei = parseEther(normalizedPrice).toString()
    const now = Math.floor(Date.now() / 1000)
    const salesConfig = {
      type: 'fixedPrice' as const,
      pricePerToken: priceInWei,
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

        const payload = {
          contract: { address: targetCollection },
          token: {
            name: name.trim(),
            ...(description.trim() ? { description: description.trim() } : {}),
            content: textContent.trim(),
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
        const data = await res.json()
        if (!res.ok) {
          const errors = Array.isArray(data.errors)
            ? ': ' + data.errors.map((e: { field?: string; message?: string }) => `${e.field ?? ''} ${e.message ?? ''}`.trim()).join(', ')
            : ''
          throw new Error((data.detail ?? data.error ?? data.message ?? 'Mint failed') + errors)
        }
        setResult(data)
        setStep('done')
        toast.success('Minted!', { id: 'mint', description: `Token #${data.tokenId}` })

      } else {
        // media mode — ensure session once (cached after first use, no re-prompt)
        const sessionToken = await ensureSession()

        setStep('uploading-media')
        setUploadProgress(0)
        toast.loading('Uploading media to Arweave…', { id: 'mint' })
        const mediaUri = await uploadToArweave(file!, (pct) => {
          setUploadProgress(pct)
          toast.loading(`Uploading media… ${pct}%`, { id: 'mint' })
        }, sessionToken)

        setStep('uploading-metadata')
        setUploadProgress(0)
        toast.loading('Uploading metadata…', { id: 'mint' })
        const metadata = {
          name: name.trim(),
          description: description.trim(),
          image: mediaUri,
          ...(file!.type.startsWith('video/') ? { animation_url: mediaUri } : {}),
        }
        const metadataUri = await uploadJson(metadata, sessionToken)

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
        const data = await res.json()
        if (!res.ok) {
          const errors = Array.isArray(data.errors)
            ? ': ' + data.errors.map((e: { field?: string; message?: string }) => `${e.field ?? ''} ${e.message ?? ''}`.trim()).join(', ')
            : ''
          throw new Error((data.detail ?? data.error ?? data.message ?? 'Mint failed') + errors)
        }
        setResult(data)
        setStep('done')
        toast.success('Minted!', { id: 'mint', description: `Token #${data.tokenId}` })
      }
    } catch (err) {
      setStep('idle')
      setUploadProgress(0)
      toast.error('Mint failed', {
        id: 'mint',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
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
              <div className="relative aspect-square bg-[#111] border border-[#2a2a2a] overflow-hidden">
                {file?.type.startsWith('video/') ? (
                  <video src={preview} className="w-full h-full object-cover" muted autoPlay loop playsInline />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="preview" className="w-full h-full object-cover" />
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
          <textarea
            value={textContent}
            onChange={(e) => setTextContent(e.target.value)}
            placeholder="write your moment…"
            rows={12}
            className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] resize-none"
          />
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

      {/* Description */}
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

      {/* Price + Supply */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
            Price (ETH)
          </label>
          <div className="relative">
            <input
              type="text"
              inputMode="decimal"
              value={price}
              onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setPrice(v) }}
              className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] pr-12"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-[#555]">ETH</span>
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
          onClick={() => setResidenciesEnabled((v) => !v)}
          aria-pressed={residenciesEnabled}
          className={`relative w-8 h-4 rounded-full transition-colors flex-shrink-0 ${residenciesEnabled ? 'bg-[#8B5CF6]' : 'bg-[#2a2a2a] border border-[#3a3a3a]'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${residenciesEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
        </button>
        <span className={`text-[10px] font-mono ${residenciesEnabled ? 'text-[#888]' : 'text-[#444]'}`}>
          {residenciesEnabled ? '5%' : '0%'} to{' '}
          <a
            href="https://kismetcasa.xyz"
            target="_blank"
            rel="noopener noreferrer"
            title="kismetcasa.xyz (opens in new tab)"
            className="underline inline-flex items-center gap-0.5 hover:text-[#efefef] transition-colors"
          >
            kismet casa residencies
            <ExternalLink size={9} className="flex-shrink-0" />
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
    case 'minting': return 'minting…'
    default: return 'working…'
  }
}
