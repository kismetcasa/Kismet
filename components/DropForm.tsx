'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  DROP_DESCRIPTION_MAX_CHARS,
  DROP_MAX_CLAIMS,
  DROP_MEDIA_MAX_BYTES,
  DROP_TITLE_MAX_CHARS,
  DROP_WINDOW_PRESETS,
  isDropMediaType,
  validateDropTerms,
  validateOpenDrop,
} from '@/lib/drops'
import { useDropIntents } from '@/hooks/useDropIntents'
import { useEnsureConnected } from '@/hooks/useEnsureConnected'
import { useUploadSession } from '@/hooks/useUploadSession'
import { toastError } from '@/lib/toast'

type Step = 'idle' | 'uploading' | 'signing' | 'opening'

const STEP_LABEL: Record<Step, string> = {
  idle: 'Open drop',
  uploading: 'Uploading to Swarm…',
  signing: 'Sign in your wallet…',
  opening: 'Recording on Arkiv…',
}

const inputClass =
  'w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted'

/**
 * Open a claim drop: pick an image, set the window and the number of claims,
 * sign once. The image goes to Swarm (through Kismet's Bee node), the drop
 * goes to Arkiv as a read-only entity the artist owns. No gas, no fee.
 */
export function DropForm() {
  const router = useRouter()
  const ensureConnected = useEnsureConnected()
  const { ensureSession } = useUploadSession()
  const { signOpenDrop } = useDropIntents()

  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [windowSeconds, setWindowSeconds] = useState(DROP_WINDOW_PRESETS[2].seconds)
  const [maxClaims, setMaxClaims] = useState(100)
  const [step, setStep] = useState<Step>('idle')
  // The Swarm upload for the current file, so a cancelled signature can be
  // retried without uploading (and paying for) the same bytes twice.
  const uploaded = useRef<{ file: File; reference: string; mime: string } | null>(null)

  useEffect(() => {
    if (!file) {
      setPreview(null)
      return
    }
    const url = URL.createObjectURL(file)
    setPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function pickFile(f: File | null) {
    if (!f) return
    if (!isDropMediaType(f.type)) {
      toast.error('Upload a PNG, JPEG, GIF or WebP image')
      return
    }
    if (f.size > DROP_MEDIA_MAX_BYTES) {
      toast.error('Images are capped at 15 MB')
      return
    }
    setFile(f)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (step !== 'idle') return
    if (!file) {
      toast.error('Choose an image for the drop')
      return
    }

    // Check the terms before any upload or wallet prompt, so a missing title
    // never costs an upload. The artwork itself is checked in pickFile.
    const nowSec = Math.floor(Date.now() / 1000)
    const precheck = validateDropTerms({ title, description, closesAt: nowSec + windowSeconds, maxClaims }, nowSec)
    if (!precheck.ok) {
      toast.error(precheck.error)
      return
    }

    const account = await ensureConnected()
    if (!account) return

    try {
      let ref = uploaded.current?.file === file ? uploaded.current : null
      if (!ref) {
        setStep('uploading')
        await ensureSession()
        const res = await fetch('/api/drops/media', {
          method: 'POST',
          headers: { 'content-type': file.type },
          body: file,
        })
        const json = (await res.json().catch(() => ({}))) as { reference?: string; mime?: string; error?: string }
        if (!res.ok || !json.reference || !json.mime) throw new Error(json.error ?? 'Upload failed')
        ref = { file, reference: json.reference, mime: json.mime }
        uploaded.current = ref
      }

      // Fix the close time at signing (the upload may have taken a while), so
      // the window is the one chosen.
      const signedAt = Math.floor(Date.now() / 1000)
      const validated = validateOpenDrop(
        { title, description, swarmRef: ref.reference, mime: ref.mime, closesAt: signedAt + windowSeconds, maxClaims },
        signedAt,
      )
      if (!validated.ok) throw new Error(validated.error)

      setStep('signing')
      const intent = await signOpenDrop(account, validated.value)

      setStep('opening')
      const res = await fetch('/api/drops', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, ...validated.value, intent }),
      })
      const json = (await res.json().catch(() => ({}))) as { key?: string; error?: string }
      if (!res.ok || !json.key) throw new Error(json.error ?? 'Could not open the drop')

      toast.success('Drop is live')
      router.push(`/drops/${json.key}`)
    } catch (err) {
      toastError('Open drop', err, { id: 'open-drop' })
      setStep('idle')
    }
  }

  const busy = step !== 'idle'

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      <div>
        <h1 className="text-sm font-mono text-ink uppercase tracking-widest mb-2">Open a claim drop</h1>
        <p className="text-xs text-muted leading-relaxed">
          Collectors claim for free with one signature — no gas, no fee, no ETH needed. When the window closes, you
          mint the artwork once and airdrop a copy to every claim. The drop lives on Arkiv; the image lives on Swarm.{' '}
          <Link href="/drops" className="underline hover:text-ink">See open drops</Link>
        </p>
      </div>

      <label className="block cursor-pointer border border-dashed border-line hover:border-muted transition-colors">
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="sr-only"
          disabled={busy}
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- local blob: preview of the file being uploaded
          <img src={preview} alt="Drop artwork preview" className="w-full max-h-[420px] object-contain bg-[#0a0a0a]" />
        ) : (
          <div className="py-16 text-center text-xs font-mono text-muted">
            Choose an image — PNG, JPEG, GIF or WebP, up to 15 MB
          </div>
        )}
      </label>

      <div className="flex flex-col gap-2">
        <label htmlFor="drop-title" className="text-xs font-mono text-muted uppercase tracking-wider">Title</label>
        <input
          id="drop-title"
          className={inputClass}
          value={title}
          maxLength={DROP_TITLE_MAX_CHARS}
          onChange={(e) => setTitle(e.target.value)}
          disabled={busy}
          placeholder="Name the artwork"
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="drop-description" className="text-xs font-mono text-muted uppercase tracking-wider">
          Description <span className="normal-case tracking-normal">(optional)</span>
        </label>
        <textarea
          id="drop-description"
          className={`${inputClass} resize-y min-h-[4.5rem]`}
          value={description}
          maxLength={DROP_DESCRIPTION_MAX_CHARS}
          onChange={(e) => setDescription(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-mono text-muted uppercase tracking-wider">Claim window</span>
        <div className="flex flex-wrap gap-2">
          {DROP_WINDOW_PRESETS.map((p) => (
            <button
              key={p.seconds}
              type="button"
              disabled={busy}
              onClick={() => setWindowSeconds(p.seconds)}
              className={`px-3 py-1.5 text-xs font-mono border transition-colors ${
                windowSeconds === p.seconds ? 'border-accent text-accent' : 'border-line text-muted hover:border-muted'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="drop-claims" className="text-xs font-mono text-muted uppercase tracking-wider">
          Claims available
        </label>
        <input
          id="drop-claims"
          type="number"
          min={1}
          max={DROP_MAX_CLAIMS}
          className={inputClass}
          value={maxClaims}
          onChange={(e) => setMaxClaims(Math.floor(Number(e.target.value)))}
          disabled={busy}
        />
        <span className="text-[11px] text-muted">
          Up to {DROP_MAX_CLAIMS} — one airdrop delivers them all when the drop settles.
        </span>
      </div>

      <button type="submit" disabled={busy} className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent">
        {STEP_LABEL[step]}
      </button>
      <p className="text-[11px] text-muted -mt-3">
        Requires a Kismet Pass. You sign a message, not a transaction.
      </p>
    </form>
  )
}
