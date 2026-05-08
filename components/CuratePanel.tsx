'use client'

import { useState } from 'react'
import { Star, Check, X } from 'lucide-react'
import { isAddress } from 'viem'
import { useAdmin } from '@/contexts/AdminContext'

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
  const { featuredKeys, toggleFeatured } = useAdmin()
  const [input, setInput] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

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
    </div>
  )
}
