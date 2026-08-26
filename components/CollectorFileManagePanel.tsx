'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { useUploadSession } from '@/hooks/useUploadSession'
import { formatCfileSize, type CfileManageView, type CfilePublic } from '@/lib/collectorFileTypes'

/**
 * Artist-side manage panel for an artwork's collector file — an inline panel
 * following the edit-metadata/edit-sale pattern in MomentDetailView
 * (COLLECTOR_DOWNLOADS_DESIGN.md §8.1). Deliberately ADJACENT to, not inside,
 * the metadata editor: that panel's save path drags an Arweave propagation
 * wait, a second wallet signature and an on-chain write — attaching a zip is
 * a session-only Kismet-side action and must not inherit any of it.
 */

const MAX_BYTES = 16 * 1024 * 1024

interface Props {
  collection: string
  tokenId: string
  onClose: () => void
  /** Reflects attach/replace/rollback/detach into the page card. */
  onFileChange: (file: CfilePublic | null) => void
}

export function CollectorFileManagePanel({ collection, tokenId, onClose, onFileChange }: Props) {
  const { ensureSession } = useUploadSession()
  const [view, setView] = useState<CfileManageView | null>(null)
  const [loading, setLoading] = useState(true)
  const [picked, setPicked] = useState<File | null>(null)
  const [note, setNote] = useState('')
  const [notify, setNotify] = useState(true)
  const [saving, setSaving] = useState(false)
  const [detachArmed, setDetachArmed] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const qs = `collection=${collection}&tokenId=${tokenId}`

  const refresh = useCallback(async () => {
    try {
      await ensureSession()
      const res = await fetch(`/api/collector-file?${qs}`)
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error('Could not load file details', { description: body?.error })
        return
      }
      const data = (await res.json()) as CfileManageView
      setView(data)
      onFileChange(data.file)
    } catch {
      toast.error('Could not load file details', { description: 'Network error — try again' })
    } finally {
      setLoading(false)
    }
  }, [qs, ensureSession, onFileChange])

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handlePick(f: File | null) {
    if (!f) return
    if (f.size > MAX_BYTES) {
      toast.error('File too large', { description: 'The limit is 16 MB per version' })
      return
    }
    if (!f.name.toLowerCase().endsWith('.zip')) {
      toast.error('Zip files only', { description: 'Package the download as a .zip' })
      return
    }
    setPicked(f)
  }

  async function handleSave() {
    if (!picked || saving) return
    setSaving(true)
    try {
      await ensureSession()
      const params = new URLSearchParams({ collection, tokenId })
      if (note.trim()) params.set('note', note.trim().slice(0, 140))
      // The EFFECTIVE notify mirrors exactly what the checkbox renders:
      // under cooldown or over the ceiling it shows disabled-unchecked, so
      // the request must not carry notify=1 (and the toast must not claim
      // collectors were notified) just because the state variable is true.
      const effectiveNotify =
        notify &&
        !!view?.file &&
        (view?.notifyCooldownSecs ?? 0) === 0 &&
        (view?.audience ?? 0) <= (view?.fanoutCeiling ?? Infinity)
      if (effectiveNotify) params.set('notify', '1') // replace → offer fanout; first attach has nobody stale to tell
      const res = await fetch(`/api/collector-file?${params.toString()}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/zip',
          // Header values must be Latin-1 — a raw CJK/emoji filename makes
          // fetch() throw before any request. The server decodes + normalizes.
          'x-file-name': encodeURIComponent(picked.name),
        },
        body: picked,
      })
      const body = (await res.json().catch(() => null)) as
        | { file?: CfilePublic | null; unchanged?: boolean; error?: string }
        | null
      if (!res.ok) {
        toast.error('Upload failed', { description: body?.error ?? `HTTP ${res.status}` })
        return
      }
      if (body?.unchanged) {
        toast('No change', { description: 'That file is identical to the current version.' })
      } else {
        toast.success(view?.file ? 'File replaced' : 'File attached', {
          description: effectiveNotify ? 'Collectors are being notified.' : undefined,
        })
      }
      setPicked(null)
      setNote('')
      if (inputRef.current) inputRef.current.value = ''
      await refresh()
    } catch (err) {
      // Network failure (or a client-side fetch throw) — without this catch
      // the rejection escapes the void call and the button just looks dead.
      toast.error('Upload failed', {
        description: err instanceof Error ? err.message : 'Network error — try again',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleRollback(v: number) {
    if (saving) return
    setSaving(true)
    try {
      await ensureSession()
      const res = await fetch(`/api/collector-file?${qs}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rollback', v }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) {
        toast.error('Rollback failed', { description: body?.error })
        return
      }
      toast.success(`Rolled back to v${v}`)
      await refresh()
    } catch (err) {
      toast.error('Rollback failed', {
        description: err instanceof Error ? err.message : 'Network error — try again',
      })
    } finally {
      setSaving(false)
    }
  }

  async function handleDetach() {
    if (saving) return
    if (!detachArmed) {
      setDetachArmed(true)
      return
    }
    setSaving(true)
    try {
      await ensureSession()
      const res = await fetch(`/api/collector-file?${qs}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        toast.error('Could not remove the file', { description: body?.error })
        return
      }
      toast.success('File removed', { description: 'Collectors can no longer download it.' })
      setDetachArmed(false)
      await refresh()
    } catch (err) {
      toast.error('Could not remove the file', {
        description: err instanceof Error ? err.message : 'Network error — try again',
      })
    } finally {
      setSaving(false)
    }
  }

  const cooldown = view?.notifyCooldownSecs ?? 0
  const overCeiling = (view?.audience ?? 0) > (view?.fanoutCeiling ?? Infinity)

  return (
    <div className="flex flex-col gap-3 border border-line p-3 bg-[#0a0a0a]">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono uppercase tracking-widest text-dim">collector download</p>
        <button onClick={onClose} className="text-muted hover:text-ink transition-colors" title="close">
          <X size={12} />
        </button>
      </div>

      {loading ? (
        <p className="text-[10px] font-mono text-muted">loading…</p>
      ) : (
        <>
          {view?.file ? (
            <div className="text-[10px] font-mono text-muted flex flex-col gap-0.5">
              <p className="text-ink truncate">
                {view.file.name} · {formatCfileSize(view.file.size)} · v{view.file.v}
                {view.file.pending ? ' · propagating…' : ''}
              </p>
              <p>
                {view.downloaders} unique downloader{view.downloaders === 1 ? '' : 's'} ·{' '}
                {view.audience} known collector{view.audience === 1 ? '' : 's'}
              </p>
              <p className="text-subtle break-all">sha256 {view.file.sha256.slice(0, 16)}…</p>
            </div>
          ) : (
            <p className="text-[10px] font-mono text-muted">
              Attach a zip that collectors of this artwork can download. Up to 16 MB;
              replace it any time — collectors get notified and can re-download.
            </p>
          )}

          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => handlePick(e.target.files?.[0] ?? null)}
          />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={saving}
            className="py-2 text-[11px] font-mono uppercase tracking-wider border border-line text-muted hover:text-ink transition-colors disabled:opacity-50"
          >
            {picked ? `${picked.name} · ${formatCfileSize(picked.size)}` : view?.file ? 'choose replacement zip' : 'choose zip'}
          </button>

          {picked && (
            <>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 140))}
                placeholder="release note, e.g. added music (optional)"
                className="bg-transparent border border-line px-2 py-1.5 text-[11px] font-mono text-ink placeholder:text-subtle outline-none"
              />
              {view?.file && (
                <label className="flex items-center gap-2 text-[10px] font-mono text-muted cursor-pointer">
                  <input
                    type="checkbox"
                    checked={notify && cooldown === 0 && !overCeiling}
                    disabled={cooldown > 0 || overCeiling}
                    onChange={(e) => setNotify(e.target.checked)}
                  />
                  {overCeiling
                    ? `too many collectors for direct notification (${view.audience}) — they'll see the update badge`
                    : cooldown > 0
                      ? `collectors already notified — available again in ${Math.ceil(cooldown / 3600)}h`
                      : `notify ${view.audience} collector${view.audience === 1 ? '' : 's'}`}
                </label>
              )}
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="py-2 text-[11px] font-mono uppercase tracking-wider border border-line accent-grad-hover transition-colors disabled:opacity-50"
              >
                <span className="accent-grad">
                  {saving ? 'uploading…' : view?.file ? 'replace file' : 'attach file'}
                </span>
              </button>
            </>
          )}

          {(view?.history?.length ?? 0) > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-[10px] font-mono uppercase tracking-widest text-subtle">history</p>
              {view!.history.slice(0, 5).map((h) => (
                <div key={h.v} className="flex items-center justify-between text-[10px] font-mono text-muted">
                  <span className="truncate">
                    v{h.v} · {formatCfileSize(h.size)} · {new Date(h.updatedAt).toLocaleDateString()}
                    {h.note ? ` · “${h.note}”` : ''}
                  </span>
                  <button
                    onClick={() => void handleRollback(h.v)}
                    disabled={saving}
                    className="ml-2 flex-shrink-0 uppercase tracking-widest text-subtle hover:text-dim transition-colors disabled:opacity-50"
                  >
                    restore
                  </button>
                </div>
              ))}
            </div>
          )}

          {view?.file && (
            <button
              onClick={() => void handleDetach()}
              disabled={saving}
              className={`self-start text-[10px] font-mono uppercase tracking-widest transition-colors disabled:opacity-50 ${
                detachArmed ? 'text-red-400 hover:text-red-300' : 'text-subtle hover:text-dim'
              }`}
            >
              {detachArmed ? 'tap again to remove the download' : 'remove download'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
