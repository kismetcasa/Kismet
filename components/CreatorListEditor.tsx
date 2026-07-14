'use client'

import { useState } from 'react'
import { Trash2, Save, X } from 'lucide-react'
import { isAddress } from 'viem'
import { toast } from 'sonner'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'

export interface CreatorListShape {
  slug: string
  name: string
  addresses: string[]
  collection?: string
  createdAt: number
  updatedAt: number
}

interface Props {
  // Existing list to edit, or null for create mode.
  list: CreatorListShape | null
  onClose: () => void
  onSaved: (next: CreatorListShape) => void
  onDeleted: (slug: string) => void
}

/**
 * Inline editor for one creator list. Addresses are entered one per line
 * and parsed on save — keeps the curator UI dense and pasteable. Save
 * goes through AdminContext.withSession so the curator only signs once
 * per 4-hour session, even when juggling multiple lists. The HttpOnly
 * session cookie carries auth on subsequent requests; the request body
 * doesn't need to inject signature/timestamp params anymore.
 */
export function CreatorListEditor({ list, onClose, onSaved, onDeleted }: Props) {
  const { withSession } = useAdmin()
  const [name, setName] = useState(list?.name ?? '')
  const [text, setText] = useState(list ? list.addresses.join('\n') : '')
  const [collection, setCollection] = useState(list?.collection ?? '')
  const [busy, setBusy] = useState(false)

  // A blank field is valid (clears the source collection → fallback feed).
  // A non-blank field must be a well-formed address before save is allowed.
  const collectionTrimmed = collection.trim()
  const collectionValid = collectionTrimmed === '' || isAddress(collectionTrimmed.toLowerCase())

  // Live preview of parsed addresses so the curator sees the count their
  // save will produce. Garbage lines silently drop both here and on the
  // server, matching the route's lenient parsing.
  const parsed = text
    .split(/\r?\n/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => isAddress(s))
  const dropped = text.split(/\r?\n/).filter((s) => s.trim()).length - parsed.length

  async function handleSave() {
    if (!name.trim()) {
      toast.error('Name required', { id: 'creator-list-save' })
      return
    }
    if (!collectionValid) {
      toast.error('Collection must be a valid 0x… address (or blank)', { id: 'creator-list-save' })
      return
    }
    setBusy(true)
    try {
      const result = await withSession(async () => {
        const res = await fetch('/api/creator-lists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: list?.slug,
            name: name.trim(),
            addresses: parsed,
            collection: collectionTrimmed,
          }),
        })
        const data = (await res.json().catch(() => ({}))) as { list?: CreatorListShape; error?: string }
        if (!res.ok) throw new Error(data.error ?? 'Save failed')
        if (!data.list) throw new Error('Server returned no list')
        return data.list
      })
      if (result) {
        toast.success(list ? 'List updated' : 'List created', { id: 'creator-list-save' })
        onSaved(result)
      }
    } catch (err) {
      toastError('Save list', err, { id: 'creator-list-save' })
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!list) return
    if (!confirm(`Delete list "${list.name}"?`)) return
    setBusy(true)
    try {
      const ok = await withSession(async () => {
        const res = await fetch(
          `/api/creator-lists?slug=${encodeURIComponent(list.slug)}`,
          { method: 'DELETE' },
        )
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(data.error ?? 'Delete failed')
        }
        return true
      })
      if (ok) {
        toast.success('List deleted', { id: 'creator-list-delete' })
        onDeleted(list.slug)
      }
    } catch (err) {
      toastError('Delete list', err, { id: 'creator-list-delete' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3 border border-line p-3 bg-[#0a0a0a]">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono uppercase tracking-widest text-dim">
          {list ? `edit ${list.slug}` : 'new list'}
        </p>
        <button
          onClick={onClose}
          disabled={busy}
          className="text-muted hover:text-dim transition-colors disabled:opacity-40"
          title="cancel"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-mono uppercase tracking-widest text-muted">name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          placeholder="residency 2026"
          className="bg-surface border border-line px-2.5 py-2 text-xs font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-mono uppercase tracking-widest text-muted">
          addresses ({parsed.length}{dropped > 0 ? `, ${dropped} ignored` : ''})
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          rows={6}
          placeholder="0xabc...&#10;0xdef..."
          className="bg-surface border border-line px-2.5 py-2 text-[11px] font-mono text-ink placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50 resize-none"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-mono uppercase tracking-widest text-muted">
          source collection (optional)
        </label>
        <input
          type="text"
          value={collection}
          onChange={(e) => setCollection(e.target.value)}
          disabled={busy}
          placeholder="0x… — shows each artist's mint here"
          className={`bg-surface border px-2.5 py-2 text-[11px] font-mono text-ink placeholder-faint focus:outline-none disabled:opacity-50 ${
            collectionValid ? 'border-line focus:border-muted' : 'border-red-900/60'
          }`}
        />
        <p className="text-[10px] font-mono text-[#444]">
          {collectionValid
            ? 'blank → show each artist’s most-collected mint'
            : 'not a valid address'}
        </p>
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={busy || !name.trim() || !collectionValid}
          className="flex-1 flex items-center justify-center gap-1.5 text-xs font-mono tracking-wider uppercase py-2 btn-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Save size={11} />
          {busy ? 'saving…' : 'save'}
        </button>
        {list && (
          <button
            onClick={handleDelete}
            disabled={busy}
            className="flex items-center justify-center gap-1.5 text-xs font-mono tracking-wider uppercase px-3 py-2 border border-line text-muted hover:border-red-900/60 hover:text-red-400 transition-colors disabled:opacity-40"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  )
}
