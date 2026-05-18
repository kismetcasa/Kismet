'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Search, X, Loader2 } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { ProfileAvatar } from './ProfileAvatar'
import { MomentImage } from './MomentImage'
import { shortAddress } from '@/lib/inprocess'
import type { Profile } from '@/lib/profile'
import type { CollectionMeta } from '@/lib/kv'
import type { MomentSearchResult } from '@/lib/search'

interface SearchResults {
  users: Profile[]
  collections: CollectionMeta[]
  mints: MomentSearchResult[]
}

interface SearchModalProps {
  onClose: () => void
  initialQuery?: string
}

// Single collection row in the search results. Tracks the image's
// load state so a broken/slow Arweave URL falls back to a styled
// initial-letter chip instead of the empty gray box that was rendering
// before — both when col.image is missing entirely and when it's
// present but fails to fetch.
function CollectionResult({ col, onClose }: { col: CollectionMeta; onClose: () => void }) {
  const [errored, setErrored] = useState(false)
  const showImage = !!col.image && !errored
  const initial = (col.name || '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <Link
      href={`/collection/${col.address}`}
      onClick={onClose}
      className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#1e1e1e] transition-colors"
    >
      <div className="relative w-7 h-7 flex-shrink-0 overflow-hidden">
        {showImage ? (
          <MomentImage
            src={col.image!}
            alt={col.name}
            fill
            className="object-cover"
            sizes="28px"
            thumbhash={col.kismet_thumbhash}
            onAllError={() => setErrored(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-accent/30 to-accent/15">
            <span className="text-[11px] font-mono text-ink">{initial}</span>
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink font-mono truncate">{col.name}</p>
        <p className="text-xs text-muted font-mono">{shortAddress(col.address)}</p>
      </div>
    </Link>
  )
}

export function SearchModal({ onClose, initialQuery = '' }: SearchModalProps) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEscapeKey(onClose)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults(null); return }
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
        if (!res.ok) throw new Error('Search failed')
        setResults(await res.json())
      } catch {
        setResults({ users: [], collections: [], mints: [] })
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  const hasResults = results && (
    results.users.length > 0 || results.collections.length > 0 || results.mints.length > 0
  )
  const searched = query.trim().length >= 2

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/75 backdrop-blur-sm flex items-start justify-center pt-16 sm:pt-24 px-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full max-w-lg flex flex-col bg-[#161616] border border-line max-h-[70vh]">
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          <Search size={15} className="text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search mints, collections, users…"
            className="flex-1 bg-transparent text-sm text-ink font-mono placeholder-faint focus:outline-none"
          />
          {loading && <Loader2 size={14} className="text-muted animate-spin flex-shrink-0" />}
          <button onClick={onClose} className="text-muted hover:text-dim flex-shrink-0 transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Results */}
        <div className="overflow-y-auto">
          {!searched && (
            <p className="px-4 py-6 text-xs font-mono text-faint text-center">
              type at least 2 characters
            </p>
          )}

          {searched && !loading && !hasResults && (
            <p className="px-4 py-6 text-xs font-mono text-muted text-center">
              no results for &ldquo;{query.trim()}&rdquo;
            </p>
          )}

          {results && results.users.length > 0 && (
            <section>
              <p className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-[#444]">Users</p>
              {results.users.map((user) => (
                <Link
                  key={user.address}
                  href={`/profile/${user.address}`}
                  onClick={onClose}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#1e1e1e] transition-colors"
                >
                  <ProfileAvatar address={user.address} avatarUrl={user.avatarUrl} size={28} />
                  <div className="min-w-0">
                    <p className="text-sm text-ink font-mono truncate">
                      {user.username || shortAddress(user.address)}
                    </p>
                    {user.username && (
                      <p className="text-xs text-muted font-mono">{shortAddress(user.address)}</p>
                    )}
                  </div>
                </Link>
              ))}
            </section>
          )}

          {results && results.collections.length > 0 && (
            <section>
              <p className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-[#444]">Collections</p>
              {results.collections.map((col) => (
                <CollectionResult key={col.address} col={col} onClose={onClose} />
              ))}
            </section>
          )}

          {results && results.mints.length > 0 && (
            <section className="mb-1">
              <p className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-[#444]">Mints</p>
              {results.mints.map((mint) => (
                <Link
                  key={mint.id}
                  href={`/moment/${mint.address}/${mint.tokenId}`}
                  onClick={onClose}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#1e1e1e] transition-colors"
                >
                  {mint.image ? (
                    <div className="relative w-7 h-7 flex-shrink-0 overflow-hidden">
                      <MomentImage src={mint.image} alt={mint.name} fill className="object-cover" sizes="28px" />
                    </div>
                  ) : (
                    <div className="w-7 h-7 bg-line flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-ink font-mono truncate">{mint.name}</p>
                    {mint.creatorAddress && (
                      <p className="text-xs text-muted font-mono">{shortAddress(mint.creatorAddress)}</p>
                    )}
                  </div>
                </Link>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
