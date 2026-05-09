'use client'

import { useState, useEffect } from 'react'
import { Star, Check, X, Plus, Pencil, ArrowUpRight } from 'lucide-react'
import { isAddress } from 'viem'
import { toast } from 'sonner'
import { useAdmin } from '@/contexts/AdminContext'
import { toastError } from '@/lib/toast'
import { CreatorListEditor, type CreatorListShape } from './CreatorListEditor'

// Accept the canonical /moment/<address>/<tokenId> URL format used elsewhere
// in the app, plus the bare `<address>/<tokenId>` shorthand. Returns null
// when the input doesn't parse — caller surfaces the error inline.
function parseMomentRef(input: string): { address: string; tokenId: string } | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const urlMatch = trimmed.match(/\/moment\/(0x[a-fA-F0-9]{40})\/([^/?#\s]+)/)
  if (urlMatch) {
    const [, addr, tokenId] = urlMatch
    if (isAddress(addr) && /^\d+$/.test(tokenId)) return { address: addr, tokenId }
    return null
  }

  // Bare `0xabc/123` or `0xabc:123`
  const bareMatch = trimmed.match(/^(0x[a-fA-F0-9]{40})[/:](\d+)$/)
  if (bareMatch) {
    const [, addr, tokenId] = bareMatch
    if (isAddress(addr)) return { address: addr, tokenId }
  }
  return null
}

/**
 * Curator surface for adding moments to the homepage Featured tab. Renders
 * inside the curator's own profile only (gated by AdminContext.isCurator
 * + ProfileView.isOwner), and reuses the existing toggleFeatured plumbing
 * — server-side /api/featured already accepts curator signatures alongside
 * admin signatures, so this is purely UI: parse the input, dispatch.
 */
export function CuratePanel() {
  const { featuredKeys, toggleFeatured, withSession } = useAdmin()
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [promoteInput, setPromoteInput] = useState('')
  const [promoting, setPromoting] = useState(false)

  // Promote a legacy collection address into kismetart:created-collections
  // so it surfaces in the Collections feed, profile collections, mint
  // dropdown, and search. Used for collections deployed before write-time
  // tracking shipped (e.g., legacy turro / Poetry x Kismet entries).
  async function handlePromote() {
    const addr = promoteInput.trim()
    if (!isAddress(addr)) {
      toast.error('Invalid contract address', { id: 'promote-collection' })
      return
    }
    setPromoting(true)
    try {
      const result = await withSession(async (auth) => {
        const res = await fetch('/api/curator/promote-collection', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: addr, ...auth }),
        })
        const data = (await res.json().catch(() => ({}))) as { promoted?: boolean; error?: string }
        if (!res.ok) throw new Error(data.error ?? 'Promote failed')
        return data
      })
      if (result?.promoted) {
        setPromoteInput('')
        toast.success(`${addr.slice(0, 6)}…${addr.slice(-4)} added to collections`, { id: 'promote-collection' })
      }
    } catch (err) {
      toastError('Promote', err, { id: 'promote-collection' })
    } finally {
      setPromoting(false)
    }
  }

  // Creator-list state. `editing` is the slug currently in the editor; null
  // means no editor is open. The sentinel '__new__' opens the editor in
  // create mode without a list to back-fill from. Lists are fetched once
  // on mount and patched in place after each save/delete so we don't pay
  // a round-trip after every mutation.
  const [lists, setLists] = useState<CreatorListShape[]>([])
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/creator-lists')
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d: { lists?: CreatorListShape[] }) => {
        if (Array.isArray(d.lists)) setLists(d.lists)
      })
      .catch(() => {})
  }, [])

  async function handleSubmit() {
    setFeedback(null)
    const parsed = parseMomentRef(input)
    if (!parsed) {
      setFeedback({ kind: 'err', text: 'paste a /moment/<addr>/<id> link or <addr>/<id>' })
      return
    }
    const key = `${parsed.address.toLowerCase()}:${parsed.tokenId}`
    if (featuredKeys.has(key)) {
      setFeedback({ kind: 'err', text: 'already featured' })
      return
    }
    setSubmitting(true)
    try {
      await toggleFeatured(parsed.address, parsed.tokenId)
      setInput('')
      setFeedback({ kind: 'ok', text: 'featured' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-[10px] font-mono uppercase tracking-widest text-[#555]">
          add to featured
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => { setInput(e.target.value); setFeedback(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSubmit() } }}
            placeholder="paste moment link or 0xabc/123"
            disabled={submitting}
            className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2 text-xs text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] disabled:opacity-50"
          />
          <button
            onClick={() => void handleSubmit()}
            disabled={submitting || !input.trim()}
            className="text-xs font-mono px-3 py-2 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
          >
            {submitting ? '…' : <Star size={12} />}
          </button>
        </div>
        {feedback && (
          <div className={`flex items-center gap-1.5 text-[10px] font-mono ${feedback.kind === 'ok' ? 'text-[#6ee7b7]' : 'text-red-400'}`}>
            {feedback.kind === 'ok' ? <Check size={10} /> : <X size={10} />}
            {feedback.text}
          </div>
        )}
      </div>

      {featuredKeys.size > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-[#555]">
            currently featured ({featuredKeys.size})
          </p>
          <ul className="flex flex-col gap-1">
            {Array.from(featuredKeys).map((key) => {
              const [addr, tokenId] = key.split(':')
              return (
                <li key={key} className="flex items-center justify-between gap-2 text-[11px] font-mono text-[#888]">
                  <a
                    href={`/moment/${addr}/${tokenId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate hover:text-[#efefef] transition-colors"
                  >
                    {addr.slice(0, 6)}…{addr.slice(-4)} / {tokenId}
                  </a>
                  <button
                    onClick={() => void toggleFeatured(addr, tokenId)}
                    className="text-[#444] hover:text-red-400 transition-colors"
                    title="unfeature"
                  >
                    <X size={11} />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* Promote a legacy real collection — for entries deployed before
          write-time tracking shipped. Going forward, every Create
          Collection form deploy registers automatically. */}
      <div className="flex flex-col gap-2 border-t border-[#1a1a1a] pt-4">
        <label className="text-[10px] font-mono uppercase tracking-widest text-[#555]">
          add legacy collection
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={promoteInput}
            onChange={(e) => setPromoteInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handlePromote() } }}
            placeholder="0x… contract address"
            disabled={promoting}
            className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2 text-xs text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] disabled:opacity-50"
          />
          <button
            onClick={() => void handlePromote()}
            disabled={promoting || !promoteInput.trim()}
            className="text-xs font-mono px-3 py-2 border border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-40"
          >
            {promoting ? '…' : <ArrowUpRight size={12} />}
          </button>
        </div>
      </div>

      {/* Creator lists — rosters reachable from the homepage Roster tab. */}
      <div className="flex flex-col gap-2 border-t border-[#1a1a1a] pt-4">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-mono uppercase tracking-widest text-[#555]">
            creator lists ({lists.length})
          </p>
          {editing !== '__new__' && (
            <button
              onClick={() => setEditing('__new__')}
              className="flex items-center gap-1 text-[10px] font-mono text-[#555] hover:text-[#efefef] transition-colors"
            >
              <Plus size={10} />
              new list
            </button>
          )}
        </div>

        {editing === '__new__' && (
          <CreatorListEditor
            list={null}
            onClose={() => setEditing(null)}
            onSaved={(next) => {
              setLists((prev) => [...prev, next])
              setEditing(null)
            }}
            onDeleted={() => setEditing(null)}
          />
        )}

        {lists.length === 0 && editing !== '__new__' && (
          <p className="text-[11px] font-mono text-[#444]">
            no lists yet — create one to expose a curated roster on the homepage.
          </p>
        )}

        <ul className="flex flex-col gap-1">
          {lists.map((l) =>
            editing === l.slug ? (
              <li key={l.slug}>
                <CreatorListEditor
                  list={l}
                  onClose={() => setEditing(null)}
                  onSaved={(next) => {
                    setLists((prev) => prev.map((x) => (x.slug === next.slug ? next : x)))
                    setEditing(null)
                  }}
                  onDeleted={(slug) => {
                    setLists((prev) => prev.filter((x) => x.slug !== slug))
                    setEditing(null)
                  }}
                />
              </li>
            ) : (
              <li
                key={l.slug}
                className="flex items-center justify-between gap-2 px-2.5 py-2 border border-[#1a1a1a] hover:border-[#2a2a2a] transition-colors"
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-mono text-[#efefef] truncate">{l.name}</span>
                  <span className="text-[10px] font-mono text-[#555]">
                    {l.slug} · {l.addresses.length} {l.addresses.length === 1 ? 'creator' : 'creators'}
                  </span>
                </div>
                <button
                  onClick={() => setEditing(l.slug)}
                  className="text-[#555] hover:text-[#efefef] transition-colors flex-shrink-0"
                  title="edit"
                >
                  <Pencil size={11} />
                </button>
              </li>
            ),
          )}
        </ul>
      </div>
    </div>
  )
}
