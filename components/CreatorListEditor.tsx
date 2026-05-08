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
 * per 4-hour session, even when juggling multiple lists.
 */
export function CreatorListEditor({ list, onClose, onSaved, onDeleted }: Props) {
  const { withSession } = useAdmin()
  const [name, setName] = useState(list?.name ?? '')
  const [text, setText] = useState(list ? list.addresses.join('\n') : '')
  const [busy, setBusy] = useState(false)

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
    setBusy(true)
    try {
      const result = await withSession(async (auth) => {
        const res = await fetch('/api/creator-lists', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: list?.slug,
            name: name.trim(),
            addresses: parsed,
            ...auth,
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
      const ok = await withSession(async (auth) => {
        const res = await fetch(
          `/api/creator-lists?slug=${encodeURIComponent(list.slug)}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(auth),
          },
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
    <div className="flex flex-col gap-3 border border-[#2a2a2a] p-3 bg-[#0a0a0a]">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono uppercase tracking-widest text-[#888]">
          {list ? `edit ${list.slug}` : 'new list'}
        </p>
        <button
          onClick={onClose}
          disabled={busy}
          className="text-[#555] hover:text-[#888] transition-colors disabled:opacity-40"
          title="cancel"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-mono uppercase tracking-widest text-[#555]">name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
          placeholder="residency 2026"
          className="bg-[#111] border border-[#2a2a2a] px-2.5 py-2 text-xs font-mono text-[#efefef] placeholder-[#333] focus:outline-none focus:border-[#555] disabled:opacity-50"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-[10px] font-mono uppercase tracking-widest text-[#555]">
          addresses ({parsed.length}{dropped > 0 ? `, ${dropped} ignored` : ''})
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={busy}
          rows={6}
          placeholder="0xabc...&#10;0xdef..."
          className="bg-[#111] border border-[#2a2a2a] px-2.5 py-2 text-[11px] font-mono text-[#efefef] placeholder-[#333] focus:outline-none focus:border-[#555] disabled:opacity-50 resize-none"
        />
      </div>

      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={busy || !name.trim()}
          className="flex-1 flex items-center justify-center gap-1.5 text-xs font-mono tracking-wider uppercase py-2 btn-accent disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Save size={11} />
          {busy ? 'saving…' : 'save'}
        </button>
        {list && (
          <button
            onClick={handleDelete}
            disabled={busy}
            className="flex items-center justify-center gap-1.5 text-xs font-mono tracking-wider uppercase px-3 py-2 border border-[#2a2a2a] text-[#555] hover:border-red-900/60 hover:text-red-400 transition-colors disabled:opacity-40"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  )
}
