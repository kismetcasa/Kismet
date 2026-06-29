'use client'

import { useEffect, useRef, useState } from 'react'
import { usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { Upload, X } from 'lucide-react'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { canTranscode, extractGifPoster } from '@/lib/media/transcodeGif'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import { loadPersistedCover, savePersistedCover, loadPersistedJson, savePersistedJson } from '@/lib/arweave/uploadPersistence'
import { CREATE_REFERRAL } from '@/lib/config'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useUpdateCollectionMetadata } from '@/hooks/useUpdateCollectionMetadata'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { toastError } from '@/lib/toast'

// Mirrors the server caps in /api/collection/update-meta. Description matches
// OpenSea's 1000-char collection limit; name is short (it's stored on-chain).
const MAX_NAME = 64
const MAX_DESCRIPTION = 1000
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

// A verified cover upload, banked across save attempts so a transient failure
// at signing (e.g. a stale wallet socket) can retry without re-uploading the
// image under a fresh txid and re-spending Turbo credits.
interface CoverUploadSession {
  source: File
  imageUri: string
  thumbhash?: string
}

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

  // Banked cover upload (see CoverUploadSession). A ref, not state — it never
  // drives rendering and must survive re-renders across save attempts.
  const coverUploadRef = useRef<CoverUploadSession | null>(null)
  // Drop the banked upload when the user picks a different cover so a stale
  // session can't be saved by accident.
  useEffect(() => {
    if (coverUploadRef.current && coverUploadRef.current.source !== cover.file) {
      coverUploadRef.current = null
    }
  }, [cover.file])

  useBodyScrollLock()
  useEscapeKey(onClose, !busy)

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
        const file = cover.file
        // Cross-reload resume: the in-memory cover bank is wiped on a page
        // reload, so a user who reloads mid-edit would re-upload the cover under
        // a fresh txid for nothing. Restore the bank from localStorage if we
        // uploaded THIS exact cover before (mirrors CreateCollectionForm).
        if (!coverUploadRef.current || coverUploadRef.current.source !== file) {
          const persistedCover = loadPersistedCover(file)
          if (persistedCover) {
            coverUploadRef.current = {
              source: file,
              imageUri: persistedCover.imageUri,
              thumbhash: persistedCover.thumbhash ?? undefined,
            }
          }
        }
        // Resume: reuse a verified upload of this exact file from a prior
        // attempt (e.g. a transient wallet error at signing) instead of
        // re-uploading under a fresh txid and re-spending Turbo credits. The
        // bytes are permanent once Turbo returned the txid, so reuse is
        // unconditional (the soft-gate below proceeds even on propagation lag).
        const cached =
          coverUploadRef.current && coverUploadRef.current.source === file
            ? coverUploadRef.current
            : null
        if (cached) {
          imageUri = cached.imageUri
          thumbhash = cached.thumbhash
          setStatusText('Resuming image upload…')
        } else {
          // Collection covers render statically on-chain, so bake an animated
          // GIF's first frame to a JPEG rather than uploading the whole
          // animation (matches CreateCollectionForm). Best-effort — fall back
          // to the original file on any ffmpeg failure.
          let imageFile: File = file
          if (canTranscode(file)) {
            setStatusText('Optimizing cover…')
            try {
              imageFile = await extractGifPoster(file)
            } catch (err) {
              console.warn('[EditCollection] GIF poster extraction failed; uploading original', err)
            }
          }
          setStatusText('Uploading image…')
          const thumbhashPromise = generateThumbhash(imageFile)
          imageUri = await uploadToArweave(imageFile, () => {})
          thumbhash = (await thumbhashPromise) ?? undefined
          // Bank the verified upload so a failure below RESUMES from here, and
          // persist it so the resume survives a page reload (uploadPersistence).
          coverUploadRef.current = { source: file, imageUri, thumbhash }
          savePersistedCover(file, { imageUri, thumbhash: thumbhash ?? null, verifyFailures: 0 })
        }
      }
      if (!imageUri) throw new Error('Collection image is missing')
      // Re-pointing at the existing cover is only safe for content URIs we can
      // faithfully re-bake into the permanent on-chain metadata. ar:// (the
      // norm) and self-contained data: pass through; a resolved gateway/proxy
      // URL must not be baked in, so require a fresh upload in that rare case.
      if (!cover.file && !imageUri.startsWith('ar://') && !imageUri.startsWith('data:')) {
        throw new Error('Please upload a new cover image to edit this collection')
      }

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
      // Cross-reload resume for the small metadata JSON (same as create/mint):
      // a reload after a propagation-lag retry would otherwise re-upload the
      // byte-identical JSON under a fresh txid. The txid is permanent once Turbo
      // returned it, so reuse is unconditional.
      const metadataKey = JSON.stringify(metadata)
      const persistedJson = loadPersistedJson(metadataKey)
      let newUri: string
      if (persistedJson) {
        newUri = persistedJson.uri
      } else {
        newUri = await uploadJson(metadata)
        savePersistedJson(metadataKey, { uri: newUri, failures: 0 })
      }

      // Best-effort propagation wait, then SOFT-GATE — the same conclusion the
      // mint + create flows landed on. The ar:// txids are PERMANENT the moment
      // Turbo returned them, so the prior hard block (which aborted on lag)
      // stranded legitimate edits whenever arweave.net — now the pool's only
      // gateway — hadn't surfaced a fresh upload yet. We wait up to 90s for a
      // smoother preview, but on a miss we proceed with the on-chain write
      // rather than bake nothing at all; the not-yet-propagated URI self-heals
      // on display once the gateway pool catches up. A re-pointed existing cover
      // is already live, so only verify a freshly uploaded image.
      setStatusText('Verifying Arweave propagation…')
      const [imageOk, metadataOk] = await Promise.all([
        cover.file ? verifyArweaveAvailable(imageUri, 90_000, 'edit-collection:image') : Promise.resolve(true),
        verifyArweaveAvailable(newUri, 90_000, 'edit-collection:metadata'),
      ])
      if (!imageOk || !metadataOk) {
        // Don't strand the editor: log the lagging txids (so a genuinely-lost
        // upload is diagnosable — `curl -I` the logged ar:// id) and proceed.
        const laggy = [
          ...(!imageOk ? ['cover image'] : []),
          ...(!metadataOk ? ['metadata'] : []),
        ].join(' + ')
        console.warn('[EditCollection] proceeding despite Arweave propagation lag', {
          laggy,
          newUri,
          imageUri,
        })
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

      // KV refresh — the collection detail page is KV-first, so this is what
      // makes the edit show on reload (inprocess reindexes the on-chain event
      // on its own cadence). The edit already landed on-chain, so a refresh
      // failure is a warning, not an error.
      const metaRes = await fetch('/api/collection/update-meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          name: trimmedName,
          description: trimmedDesc,
          image: imageUri,
          ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
        }),
      }).catch(() => null)

      onSaved({ name: trimmedName, description: trimmedDesc, image: imageUri, thumbhash })
      // Edit committed — drop the banked upload so a later edit in the same
      // modal re-uploads fresh rather than reusing a now-spent session.
      coverUploadRef.current = null
      if (metaRes && metaRes.ok) {
        toast.success('Collection updated')
      } else {
        toast.success('Collection updated on-chain', {
          description: 'The Kismet preview may take a moment to refresh.',
        })
      }
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
