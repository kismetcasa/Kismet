'use client'

import { useState, useEffect } from 'react'
import { Star, Check, X, Plus, Pencil } from 'lucide-react'
import { isAddress } from 'viem'
import { useAdmin } from '@/contexts/AdminContext'
import { shortAddress } from '@/lib/inprocess'
import { CreatorListEditor, type CreatorListShape } from './CreatorListEditor'

// Accept a /moment/<addr>/<id> link, /collection/<addr> link, or bare
// shorthands (0xabc/123 for a moment, 0xabc for a collection).
type ParsedRef =
  | { kind: 'moment'; address: string; tokenId: string }
  | { kind: 'collection'; address: string }
  | null

function parseFeatureRef(input: string): ParsedRef {
  const trimmed = input.trim()
  if (!trimmed) return null

  const momentUrl = trimmed.match(/\/moment\/(0x[a-fA-F0-9]{40})\/([^/?#\s]+)/)
  if (momentUrl) {
    const [, addr, tokenId] = momentUrl
    if (isAddress(addr) && /^\d+$/.test(tokenId)) return { kind: 'moment', address: addr, tokenId }
  }

  const collectionUrl = trimmed.match(/\/collection\/(0x[a-fA-F0-9]{40})\b/)
  if (collectionUrl) {
    const [, addr] = collectionUrl
    if (isAddress(addr)) return { kind: 'collection', address: addr }
  }

  // Bare `0xabc/123` or `0xabc:123` → moment
  const bareMoment = trimmed.match(/^(0x[a-fA-F0-9]{40})[/:](\d+)$/)
  if (bareMoment) {
    const [, addr, tokenId] = bareMoment
    if (isAddress(addr)) return { kind: 'moment', address: addr, tokenId }
  }

  // Bare `0xabc` → collection
  if (/^0x[a-fA-F0-9]{40}$/.test(trimmed) && isAddress(trimmed)) {
    return { kind: 'collection', address: trimmed }
  }

  return null
}

// Curator surface — feature moments and collections, manage roster lists.
// Rendered only on the curator's own profile (AdminContext.isCurator +
// ProfileView.isOwner).
export function CuratePanel() {
  const {
    featuredKeys,
    featuredCollectionAddrs,
    toggleFeatured,
    toggleFeaturedCollection,
  } = useAdmin()
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

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
    const parsed = parseFeatureRef(input)
    if (!parsed) {
      setFeedback({ kind: 'err', text: 'paste a moment or collection link' })
      return
    }
    if (parsed.kind === 'moment') {
      const key = `${parsed.address.toLowerCase()}:${parsed.tokenId}`
      if (featuredKeys.has(key)) {
        setFeedback({ kind: 'err', text: 'already featured' })
        return
      }
      setSubmitting(true)
      try {
        await toggleFeatured(parsed.address, parsed.tokenId)
        setInput('')
        setFeedback({ kind: 'ok', text: 'moment featured' })
      } finally {
        setSubmitting(false)
      }
      return
    }
    // collection
    if (featuredCollectionAddrs.has(parsed.address.toLowerCase())) {
      setFeedback({ kind: 'err', text: 'already featured' })
      return
    }
    setSubmitting(true)
    try {
      await toggleFeaturedCollection(parsed.address)
      setInput('')
      setFeedback({ kind: 'ok', text: 'collection featured' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label className="text-[10px] font-mono uppercase tracking-widest text-muted">
          add to featured
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => { setInput(e.target.value); setFeedback(null) }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSubmit() } }}
            placeholder="moment or collection link"
            disabled={submitting}
            className="flex-1 bg-surface border border-line px-3 py-2 text-xs text-ink font-mono placeholder-faint focus:outline-none focus:border-muted disabled:opacity-50"
          />
          <button
            onClick={() => void handleSubmit()}
            disabled={submitting || !input.trim()}
            className="text-xs font-mono px-3 py-2 border border-line text-muted hover:border-muted hover:text-ink transition-colors disabled:opacity-40"
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

      {(featuredKeys.size > 0 || featuredCollectionAddrs.size > 0) && (
        <div className="flex flex-col gap-2">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted">
            currently featured ({featuredKeys.size + featuredCollectionAddrs.size})
          </p>
          <ul className="flex flex-col gap-1">
            {Array.from(featuredCollectionAddrs).map((addr) => (
              <li key={`coll:${addr}`} className="flex items-center justify-between gap-2 text-[11px] font-mono text-dim">
                <a
                  href={`/collection/${addr}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="truncate hover:text-ink transition-colors"
                >
                  {shortAddress(addr)}
                  <span className="text-[#444] ml-1.5">collection</span>
                </a>
                <button
                  onClick={() => void toggleFeaturedCollection(addr)}
                  className="text-[#444] hover:text-red-400 transition-colors"
                  title="unfeature"
                >
                  <X size={11} />
                </button>
              </li>
            ))}
            {Array.from(featuredKeys).map((key) => {
              const [addr, tokenId] = key.split(':')
              return (
                <li key={key} className="flex items-center justify-between gap-2 text-[11px] font-mono text-dim">
                  <a
                    href={`/moment/${addr}/${tokenId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate hover:text-ink transition-colors"
                  >
                    {shortAddress(addr)} / {tokenId}
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

      {/* Creator lists — rosters reachable from the homepage Roster tab. */}
      <div className="flex flex-col gap-2 border-t border-raised pt-4">
        <div className="flex items-center justify-between">
          <p className="text-[10px] font-mono uppercase tracking-widest text-muted">
            creator lists ({lists.length})
          </p>
          {editing !== '__new__' && (
            <button
              onClick={() => setEditing('__new__')}
              className="flex items-center gap-1 text-[10px] font-mono text-muted hover:text-ink transition-colors"
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
                className="flex items-center justify-between gap-2 px-2.5 py-2 border border-raised hover:border-line transition-colors"
              >
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-mono text-ink truncate">{l.name}</span>
                  <span className="text-[10px] font-mono text-muted">
                    {l.slug} · {l.addresses.length} {l.addresses.length === 1 ? 'creator' : 'creators'}
                    {l.collection ? ` · ${shortAddress(l.collection)}` : ' · no collection'}
                  </span>
                </div>
                <button
                  onClick={() => setEditing(l.slug)}
                  className="text-muted hover:text-ink transition-colors flex-shrink-0"
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
