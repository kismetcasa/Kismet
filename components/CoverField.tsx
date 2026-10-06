'use client'

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Upload } from 'lucide-react'
import { useAccount } from 'wagmi'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useFileUpload } from '@/hooks/useFileUpload'
import { checkCoverImage } from '@/lib/media/mintMedia'
import { proxyUrl } from '@/lib/media/gateway'
import { prepareCover, uploadCover } from '@/lib/experience/coverUpload'
import { toastError } from '@/lib/toast'
import type { MachineCover } from '@/lib/experience/types'

/** A collection cover's limit (EditCollectionForm). */
const MAX_COVER_BYTES = 25 * 1024 * 1024

/**
 * Pick a machine's cover, gated as a collection cover is, and upload it when
 * asked — once per picked file, so a publish retried after a refusal does not
 * upload (and pay for) the same image again.
 */
export function useCoverPick() {
  // The still each picked file becomes (prepareCover), kept for the upload —
  // keyed by file, so a slow pick overtaken by a later one cannot claim it.
  const prepared = useRef(new WeakMap<File, File>())
  const pick = useFileUpload({
    maxBytes: MAX_COVER_BYTES,
    onTooLarge: () => toast.error('Image must be 25MB or smaller'),
    accept: async (f) => {
      const verdict = await checkCoverImage(f)
      if (!verdict.ok) return verdict.reason
      const still = await prepareCover(f)
      if (typeof still === 'string') return still
      prepared.current.set(f, still)
      return null
    },
    onRejected: (_f, reason) => toast.error('Unsupported cover', { description: reason }),
  })
  const uploaded = useRef<{ file: File; cover: MachineCover } | null>(null)
  const upload = async (): Promise<MachineCover | null> => {
    const still = pick.file && prepared.current.get(pick.file)
    if (!pick.file || !still) return null
    if (uploaded.current?.file === pick.file) return uploaded.current.cover
    const cover = await uploadCover(still)
    uploaded.current = { file: pick.file, cover }
    return cover
  }
  return { ...pick, upload }
}

/** The picker: a thumbnail of the cover (the picked file, or the one the
 *  machine has) and a button to choose one. */
export function CoverField({
  pick,
  current,
  disabled,
}: {
  pick: ReturnType<typeof useCoverPick>
  /** The machine's cover now, when it has one. */
  current?: string | null
  disabled?: boolean
}) {
  const src = pick.preview ?? (current ? proxyUrl(current, 256) : null)
  return (
    <div className="flex items-center gap-3">
      <div className="relative w-16 h-16 flex-shrink-0 bg-raised border border-line overflow-hidden">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={src} alt="cover" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-line font-mono text-[9px]">none</span>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => pick.inputRef.current?.click()}
        disabled={disabled}
        className="flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim border border-line px-2.5 py-1.5 disabled:opacity-50"
      >
        <Upload size={12} /> {pick.file || current ? 'change cover' : 'choose cover'}
      </button>
      <input ref={pick.inputRef} type="file" accept="image/*" onChange={pick.onChange} className="hidden" aria-label="cover image" />
    </div>
  )
}

/** The studio's cover row. A cover is what the machine's card shows, so a
 *  machine cannot be published without one. */
export function CoverSlot({ pick, disabled }: { pick: ReturnType<typeof useCoverPick>; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-mono uppercase tracking-wider text-subtle">cover</span>
      <CoverField pick={pick} disabled={disabled} />
      <span className="text-[10px] font-mono text-subtle">what the machine&apos;s card shows — required; a gif becomes its first frame</span>
    </div>
  )
}

/** Upload the picked cover for a publish, or say why not. The cover goes up
 *  only on publish: a check needs none, and uploading on every check would pay
 *  for images the creator then changes. */
export async function uploadCoverOrSay(upload: () => Promise<MachineCover | null>): Promise<MachineCover | null> {
  try {
    const cover = await upload()
    if (!cover) toast.error('Choose a cover first')
    return cover
  } catch (err) {
    toastError('Upload the cover', err)
    return null
  }
}

/**
 * A creator changing their machine's cover after it is published — the card
 * shows the new one at once. Shown only to `creator`'s wallet when given; the
 * owner route checks the session (app/api/experience/machines/[id]).
 */
export function CoverEditor({
  machineId,
  current,
  creator,
  onDone,
}: {
  machineId: string
  current: string | null
  creator?: string
  onDone?: () => void
}) {
  const { address } = useAccount()
  const { ensureSession } = useUploadSession()
  const pick = useCoverPick()
  const [busy, setBusy] = useState(false)
  if (creator !== undefined && address?.toLowerCase() !== creator.toLowerCase()) return null

  const save = async () => {
    setBusy(true)
    try {
      await ensureSession()
      const cover = await uploadCoverOrSay(pick.upload)
      if (!cover) return
      const r = await fetch(`/api/experience/machines/${machineId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'cover', cover }),
      })
      const body = await r.json().catch(() => null)
      if (!r.ok) {
        toast.error(body?.error ?? 'Could not change the cover')
        return
      }
      toast.success('Cover updated')
      pick.clear()
      onDone?.()
    } catch (err) {
      toastError('Change the cover', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <CoverField pick={pick} current={current} disabled={busy} />
      {pick.file && (
        <button
          onClick={() => void save()}
          disabled={busy}
          className="px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider btn-accent disabled:opacity-40"
        >
          {busy ? 'saving…' : 'save cover'}
        </button>
      )}
    </div>
  )
}
