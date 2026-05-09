'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Search, Loader2, ExternalLink } from 'lucide-react'
import { ProfileAvatar } from './ProfileAvatar'
import { resolveUri, shortAddress } from '@/lib/inprocess'
import type { Profile } from '@/lib/profile'
import type { CollectionMeta } from '@/lib/kv'
import type { MomentSearchResult } from '@/lib/search'

interface SearchResults {
  users: Profile[]
  collections: CollectionMeta[]
  mints: MomentSearchResult[]
}

// Resolves ar://… / ipfs://… URIs and falls back to an initial-letter chip
// when the image is missing or fails to load — matches SearchModal's
// behavior so dropdown thumbnails don't render as empty gray squares.
function ResultThumb({ src, alt, name }: { src?: string; alt: string; name: string }) {
  const [errored, setErrored] = useState(false)
  const showImage = !!src && !errored
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <div className="w-5 h-5 flex-shrink-0 overflow-hidden">
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolveUri(src!)}
          alt={alt}
          className="w-full h-full object-cover"
          onError={() => setErrored(true)}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-[#8B5CF6]/30 to-[#C084FC]/15">
          <span className="text-[9px] font-mono text-[#efefef]">{initial}</span>
        </div>
      )}
    </div>
  )
}

interface SearchBarProps {
  onOpenModal: (query: string) => void
}

export function SearchBar({ onOpenModal }: SearchBarProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Focus / clear on open/close
  useEffect(() => {
    if (open) inputRef.current?.focus()
    else { setQuery(''); setResults(null) }
  }, [open])

  // Escape closes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Click outside closes
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Debounced search
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults(null); setLoading(false); return }
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`)
        const data = await res.json()
        setResults({
          users: (data.users ?? []).slice(0, 5),
          collections: (data.collections ?? []).slice(0, 5),
          mints: (data.mints ?? []).slice(0, 5),
        })
      } catch {
        setResults(null)
      } finally {
        setLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  const hasResults = results && (results.users.length > 0 || results.collections.length > 0 || results.mints.length > 0)
  const showDropdown = open && query.trim().length >= 2

  function close() { setOpen(false) }

  function handleSeeAll() {
    close()
    onOpenModal(query)
  }

  return (
    // h-14 matches header height so top-full clears the nav bar precisely
    <div ref={containerRef} className="relative h-14 flex items-center">
      <button
        onClick={() => setOpen((v) => !v)}
        className="px-3 py-1.5 text-[#888] hover:text-[#efefef] transition-colors flex-shrink-0"
        title="Search"
      >
        <Search size={14} />
      </button>

      {/* Oval input */}
      {open && (
        <div className="relative flex items-center">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder=""
            className="w-64 bg-white text-[#111] font-mono text-xs rounded-full px-4 py-1.5 focus:outline-none placeholder-[#999]"
          />
          {loading && (
            <Loader2 size={11} className="absolute right-3 text-[#999] animate-spin" />
          )}
        </div>
      )}

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute top-full right-0 w-72 bg-[#161616] border border-[#2a2a2a] z-[60] overflow-hidden">
          {!hasResults && !loading && (
            <p className="px-4 py-3 text-xs font-mono text-[#555] text-center">
              no results for &ldquo;{query.trim()}&rdquo;
            </p>
          )}

          {/* Users */}
          {results && results.users.length > 0 && (
            <section>
              <p className="px-3 pt-2.5 pb-1 text-[9px] font-mono uppercase tracking-widest text-[#444]">Users</p>
              {results.users.map((user) => (
                <Link
                  key={user.address}
                  href={`/profile/${user.address}`}
                  onClick={close}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#1e1e1e] transition-colors"
                >
                  <ProfileAvatar address={user.address} avatarUrl={user.avatarUrl} size={22} />
                  <span className="text-xs text-[#efefef] font-mono truncate">
                    {user.username || shortAddress(user.address)}
                  </span>
                </Link>
              ))}
            </section>
          )}

          {/* Collections */}
          {results && results.collections.length > 0 && (
            <section>
              <p className="px-3 pt-2.5 pb-1 text-[9px] font-mono uppercase tracking-widest text-[#444]">Collections</p>
              {results.collections.map((col) => (
                <a
                  key={col.address}
                  href={`https://inprocess.world/collect/base:${col.address}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={close}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#1e1e1e] transition-colors"
                >
                  <ResultThumb src={col.image} alt={col.name} name={col.name} />
                  <span className="text-xs text-[#efefef] font-mono truncate flex-1">{col.name}</span>
                  <ExternalLink size={9} className="text-[#444] flex-shrink-0" />
                </a>
              ))}
            </section>
          )}

          {/* Mints */}
          {results && results.mints.length > 0 && (
            <section>
              <p className="px-3 pt-2.5 pb-1 text-[9px] font-mono uppercase tracking-widest text-[#444]">Mints</p>
              {results.mints.map((mint) => (
                <a
                  key={mint.id}
                  href={`https://inprocess.world/collect/base:${mint.address}/${mint.tokenId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={close}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#1e1e1e] transition-colors"
                >
                  <ResultThumb src={mint.image} alt={mint.name} name={mint.name} />
                  <span className="text-xs text-[#efefef] font-mono truncate">{mint.name}</span>
                </a>
              ))}
            </section>
          )}

          {/* See all */}
          <div className="border-t border-[#2a2a2a] px-3 py-2 flex justify-end">
            <button
              onClick={handleSeeAll}
              className="text-[9px] font-mono uppercase tracking-widest text-[#555] hover:text-[#888] transition-colors"
            >
              see all results →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
