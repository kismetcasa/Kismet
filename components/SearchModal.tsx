'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Search, X, Loader2, ExternalLink } from 'lucide-react'
import { ProfileAvatar } from './ProfileAvatar'
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

export function SearchModal({ onClose, initialQuery = '' }: SearchModalProps) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults(null); return }
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
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
      <div className="w-full max-w-lg flex flex-col bg-[#161616] border border-[#2a2a2a] max-h-[70vh]">
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[#2a2a2a]">
          <Search size={15} className="text-[#555] flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search mints, collections, users…"
            className="flex-1 bg-transparent text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none"
          />
          {loading && <Loader2 size={14} className="text-[#555] animate-spin flex-shrink-0" />}
          <button onClick={onClose} className="text-[#555] hover:text-[#888] flex-shrink-0 transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Results */}
        <div className="overflow-y-auto">
          {!searched && (
            <p className="px-4 py-6 text-xs font-mono text-[#333] text-center">
              type at least 2 characters
            </p>
          )}

          {searched && !loading && !hasResults && (
            <p className="px-4 py-6 text-xs font-mono text-[#555] text-center">
              no results for &ldquo;{query.trim()}&rdquo;
            </p>
          )}

          {/* Users */}
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
                    <p className="text-sm text-[#efefef] font-mono truncate">
                      {user.username || shortAddress(user.address)}
                    </p>
                    {user.username && (
                      <p className="text-xs text-[#555] font-mono">{shortAddress(user.address)}</p>
                    )}
                  </div>
                </Link>
              ))}
            </section>
          )}

          {/* Collections */}
          {results && results.collections.length > 0 && (
            <section>
              <p className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-[#444]">Collections</p>
              {results.collections.map((col) => (
                <a
                  key={col.address}
                  href={`https://inprocess.world/collect/base:${col.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#1e1e1e] transition-colors"
                >
                  {col.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={col.image} alt={col.name} className="w-7 h-7 object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-7 h-7 bg-[#2a2a2a] flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-[#efefef] font-mono truncate">{col.name}</p>
                    <p className="text-xs text-[#555] font-mono">{shortAddress(col.address)}</p>
                  </div>
                  <ExternalLink size={10} className="text-[#444] flex-shrink-0" />
                </a>
              ))}
            </section>
          )}

          {/* Mints */}
          {results && results.mints.length > 0 && (
            <section className="mb-1">
              <p className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-[#444]">Mints</p>
              {results.mints.map((mint) => (
                <a
                  key={mint.id}
                  href={`https://inprocess.world/collect/base:${mint.address}/${mint.tokenId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-[#1e1e1e] transition-colors"
                >
                  {mint.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={mint.image} alt={mint.name} className="w-7 h-7 object-cover flex-shrink-0" />
                  ) : (
                    <div className="w-7 h-7 bg-[#2a2a2a] flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-[#efefef] font-mono truncate">{mint.name}</p>
                    {mint.creatorAddress && (
                      <p className="text-xs text-[#555] font-mono">{shortAddress(mint.creatorAddress)}</p>
                    )}
                  </div>
                  <ExternalLink size={10} className="text-[#444] flex-shrink-0" />
                </a>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
