'use client'

import { useState } from 'react'
import { usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { Upload, X } from 'lucide-react'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import { CREATE_REFERRAL } from '@/lib/config'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useUpdateCollectionMetadata } from '@/hooks/useUpdateCollectionMetadata'
import { toastError } from '@/lib/toast'

// Mirrors the server caps in /api/collection/update-meta. Description matches
// OpenSea's 1000-char collection limit; name is short (it's stored on-chain).
const MAX_NAME = 64
const MAX_DESCRIPTION = 1000
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

export interface EditedMeta {
  name: string
  description: string
  image: string
  thumbhash?: string
}

function gateway(uri: string): string {
  return uri.startsWith('ar://') ? `https://arweave.net/${uri.slice(5)}` : uri
}

/**
 * Edit a collection's contract-level metadata (name / description / cover).
 * Rebuilds the SAME JSON shape the create form bakes at deploy
 * ({ name, description, image, kismet_thumbhash?, createReferral }), uploads
 * it to Arweave, gates on propagation, then submits a direct, user-signed
 * `updateContractMetadata` via useUpdateCollectionMetadata. On success it
 * refreshes the KV fallback and hands the new values back for optimistic
 * render. Royalties are deliberately out of scope — a separate, differently
 * permissioned (FUNDS_MANAGER) contract function.
 */
export function EditCollectionForm({
  address,
  currentName,
  currentDescription,
  currentImage,
  currentThumbhash,
  onClose,
  onSaved,
}: {
  address: string
  currentName: string
  currentDescription: string
  currentImage?: string
  currentThumbhash?: string
  onClose: () => void
  onSaved: (next: EditedMeta) => void
}) {
  const [name, setName] = useState(currentName)
  const [description, setDescription] = useState(currentDescription)
  const [busy, setBusy] = useState(false)
  const [statusText, setStatusText] = useState<string | null>(null)
  const cover = useFileUpload({
    maxBytes: MAX_IMAGE_BYTES,
    onTooLarge: () => toast.error('Image must be 25MB or smaller'),
  })
  const { ensureSession } = useUploadSession()
  const { update } = useUpdateCollectionMetadata()
  const publicClient = usePublicClient({ chainId: base.id })

  async function handleSave() {
    const trimmedName = name.trim()
    const trimmedDesc = description.trim()
    if (!trimmedName) return toast.error('Name is required')
    if (trimmedName.length > MAX_NAME) {
      return toast.error(`Name must be ${MAX_NAME} characters or fewer`)
    }
    if (trimmedDesc.length > MAX_DESCRIPTION) {
      return toast.error(`Description must be ${MAX_DESCRIPTION} characters or fewer`)
    }

    // No-op guard: an unchanged save would waste gas + write junk history.
    const nameChanged = trimmedName !== currentName.trim()
    const descChanged = trimmedDesc !== currentDescription.trim()
    const imageChanged = !!cover.file
    if (!nameChanged && !descChanged && !imageChanged) {
      toast('No changes to save')
      return onClose()
    }
    if (!publicClient) return toast.error('No network client available')

    setBusy(true)
    try {
      await ensureSession()

      // Image: re-point at the existing cover unless a new file was picked.
      let imageUri = currentImage
      let thumbhash = currentThumbhash
      if (cover.file) {
        setStatusText('Uploading image…')
        const thumbhashPromise = generateThumbhash(cover.file)
        imageUri = await uploadToArweave(cover.file, () => {})
        thumbhash = (await thumbhashPromise) ?? undefined
        setStatusText('Verifying image propagation…')
        if (!(await verifyArweaveAvailable(imageUri, 90_000))) {
          throw new Error('Image is still settling on Arweave — try again in a minute')
        }
      }
      if (!imageUri) throw new Error('Collection image is missing')

      // Rebuild the full contractURI JSON (same builder as create). The
      // createReferral constant is re-set, not read back, so it's preserved.
      setStatusText('Uploading metadata…')
      const metadata: Record<string, unknown> = {
        name: trimmedName,
        description: trimmedDesc,
        image: imageUri,
        ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
        createReferral: CREATE_REFERRAL,
      }
      const newUri = await uploadJson(metadata)
      setStatusText('Verifying metadata propagation…')
      if (!(await verifyArweaveAvailable(newUri))) {
        throw new Error('Metadata is still settling on Arweave — try again in a minute')
      }

      // Same string into the on-chain name() and the JSON name so they match.
      setStatusText('Confirm in your wallet…')
      const hash = await update({
        collection: address as `0x${string}`,
        newUri,
        newName: trimmedName,
      })

      setStatusText('Updating on-chain…')
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        throw new Error('The update transaction reverted on-chain')
      }

      // Best-effort KV refresh — the chain + ContractURIUpdated are
      // authoritative; this just closes the KV-fallback staleness gap.
      await fetch('/api/collection/update-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          name: trimmedName,
          description: trimmedDesc,
          image: imageUri,
          ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
        }),
      }).catch(() => {})

      toast.success('Collection updated')
      onSaved({ name: trimmedName, description: trimmedDesc, image: imageUri, thumbhash })
    } catch (err) {
      toastError('Edit collection', err)
    } finally {
      setBusy(false)
      setStatusText(null)
    }
  }

  const previewSrc = cover.preview || (currentImage ? gateway(currentImage) : null)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70"
      onClick={busy ? undefined : onClose}
    >
      <div
        className="w-full max-w-md bg-surface border border-line p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-mono text-ink uppercase tracking-widest">
            Edit collection
          </h2>
          <button
            onClick={onClose}
            disabled={busy}
            className="text-muted hover:text-ink disabled:opacity-50"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mb-4">
          <span className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1.5">
            Cover image
          </span>
          <div className="flex items-center gap-3">
            <div className="relative w-16 h-16 flex-shrink-0 bg-raised border border-line overflow-hidden">
              {previewSrc ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewSrc} alt="cover" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <span className="text-line font-mono text-[9px]">none</span>
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => cover.inputRef.current?.click()}
              disabled={busy}
              className="flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim border border-line px-2.5 py-1.5 disabled:opacity-50"
            >
              <Upload size={12} /> {cover.file ? 'change' : 'replace'}
            </button>
            <input
              ref={cover.inputRef}
              type="file"
              accept="image/*"
              onChange={cover.onChange}
              className="hidden"
            />
          </div>
        </div>

        <label className="block mb-4">
          <span className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1.5">
            Name
          </span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={MAX_NAME}
            disabled={busy}
            className="w-full bg-raised border border-line px-3 py-2 text-sm font-mono text-ink outline-none focus:border-muted"
          />
        </label>

        <label className="block mb-5">
          <span className="block text-[10px] font-mono text-muted uppercase tracking-widest mb-1.5">
            Description
          </span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={MAX_DESCRIPTION}
            rows={4}
            disabled={busy}
            className="w-full bg-raised border border-line px-3 py-2 text-sm font-mono text-ink outline-none focus:border-muted resize-none"
          />
        </label>

        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-mono text-muted truncate">{statusText}</span>
          <div className="flex items-center gap-3 flex-shrink-0">
            <button
              onClick={onClose}
              disabled={busy}
              className="text-xs font-mono text-muted hover:text-dim disabled:opacity-50"
            >
              cancel
            </button>
            <button
              onClick={handleSave}
              disabled={busy}
              className="text-xs font-mono text-ink border border-line hover:border-muted px-3 py-1.5 disabled:opacity-50"
            >
              {busy ? 'saving…' : 'save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
