'use client'

import { useEffect, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Upload, X } from 'lucide-react'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { useUploadSession } from '@/hooks/useUploadSession'
import { CREATE_REFERRAL } from '@/lib/config'
import { toastError } from '@/lib/toast'

interface CreateCollectionFormProps {
  onDeployed?: (address: string, name: string) => void
}

/**
 * Deploys a new collection via inprocess's `POST /api/collections` (proxied
 * through `/api/collection/create`). The previous implementation called
 * Zora's factory directly from the user's wallet — that produced a working
 * contract, but inprocess's platform smart account never received ADMIN
 * permission, so every subsequent `/api/mint` call into the collection
 * reverted at gas estimation ("useroperation reverted: execution
 * reverted"). Routing through inprocess fixes that at the source: their
 * deploy grants their smart account the permissions it needs while still
 * setting the user as defaultAdmin, and the user pays no gas because
 * inprocess sponsors the deploy via the API key.
 *
 * Trade-offs vs the previous flow: features absent from inprocess's
 * documented `/api/collections` body are not configurable here — royalty
 * BPS / recipient and explicit minter grants. They can be added back if
 * inprocess exposes them in the API. The cover-mint optimization is
 * dropped for now; minting a cover is a one-step follow-up via the Mint
 * tab and works because the new collection accepts inprocess-driven mints.
 */
export function CreateCollectionForm({ onDeployed }: CreateCollectionFormProps = {}) {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { ensureSession } = useUploadSession()

  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverPreview, setCoverPreview] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [step, setStep] = useState<
    'idle' | 'uploading-image' | 'uploading-metadata' | 'deploying' | 'done'
  >('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [collectionAddress, setCollectionAddress] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

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

    try {
      // Cookie session — Arweave uploads need it (server holds the funding
      // key) and so does /api/collection/create (binds caller to artist).
      await ensureSession()

      setStep('uploading-image')
      setUploadProgress(0)
      toast.loading('Uploading cover image…', { id: 'create-collection' })
      const imageUri = await uploadToArweave(coverFile, (pct) => {
        setUploadProgress(pct)
        toast.loading(`Uploading image… ${pct}%`, { id: 'create-collection' })
      })

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
      toast.loading('Deploying collection…', { id: 'create-collection' })

      const res = await fetch('/api/collection/create', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          uri: contractURI,
          image: imageUri,
          description: description.trim() || undefined,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(data.detail ?? data.error ?? data.message ?? 'Deploy failed')
      }
      const deployedAddress: string | undefined = data.contractAddress
      if (!deployedAddress) {
        throw new Error('Deploy succeeded but no contractAddress returned')
      }

      setCollectionAddress(deployedAddress)
      setTxHash(typeof data.hash === 'string' ? data.hash : null)
      onDeployed?.(deployedAddress, name)
      setStep('done')
      toast.success('Collection deployed!', { id: 'create-collection' })
    } catch (err) {
      setStep('idle')
      setUploadProgress(0)
      toastError('Deploy', err, { id: 'create-collection' })
    }
  }

  // Auto-redirect once the success screen has rendered so the user lands
  // on their new collection page without a manual click. Effect (not in
  // render) so it fires exactly once per (step, address) transition.
  useEffect(() => {
    if (step !== 'done' || !collectionAddress) return
    const t = setTimeout(() => router.push(`/collection/${collectionAddress}`), 1500)
    return () => clearTimeout(t)
  }, [step, collectionAddress, router])

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
            setTxHash(null)
            clearFile()
            setName('')
            setDescription('')
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
        <span className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Cover Image <span className="text-[#efefef]">*</span>
        </span>
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

      <p className="text-[10px] font-mono text-[#444] -mt-2">
        deploy is sponsored — no gas required from your wallet
      </p>

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
    case 'uploading-image':
      return progress > 0 ? `uploading image… ${progress}%` : 'uploading image…'
    case 'uploading-metadata':
      return 'uploading metadata…'
    case 'deploying':
      return 'deploying…'
    default:
      return 'working…'
  }
}
