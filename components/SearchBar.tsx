'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { Search, Loader2 } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { ProfileAvatar } from './ProfileAvatar'
import { MomentImage } from './MomentImage'
import { shortAddress } from '@/lib/inprocess'
import { isPatronCollection } from '@/lib/patronCollection'
import type { Profile } from '@/lib/profile'
import type { CollectionMeta } from '@/lib/kv'
import type { MomentSearchResult } from '@/lib/search'

interface SearchResults {
  users: Profile[]
  collections: CollectionMeta[]
  mints: MomentSearchResult[]
}

// Walks the gateway pool via MomentImage; on full exhaustion (or missing src),
// falls back to an initial-letter chip so dropdown rows never render empty.
function ResultThumb({ src, alt, name, preferProxy }: { src?: string; alt: string; name: string; preferProxy?: boolean }) {
  const [errored, setErrored] = useState(false)
  const showImage = !!src && !errored
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?'
  return (
    <div className="relative w-5 h-5 flex-shrink-0 overflow-hidden">
      {showImage ? (
        <MomentImage
          src={src!}
          alt={alt}
          fill
          className="object-cover"
          sizes="20px"
          // Patron scans 413 the optimizer (50MB body cap); without this even
          // this 20px thumb pays a full-cap doomed optimizer fetch. With a raw
          // proxiable src (lib/search.ts) it lands on the warm /api/img variant.
          preferProxy={preferProxy}
          onAllError={() => setErrored(true)}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-accent/30 to-accent/15">
          <span className="text-[9px] font-mono text-ink">{initial}</span>
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

  useEffect(() => {
    if (open) inputRef.current?.focus()
    else { setQuery(''); setResults(null) }
  }, [open])

  useEscapeKey(useCallback(() => setOpen(false), []))

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  // Debounced search with cancellation: a new keystroke aborts the
  // in-flight fetch (and the timer if it hasn't fired yet) so we
  // don't stack requests against the 30-req/min ratelimit or block
  // the response on stale queries.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults(null); setLoading(false); return }
    setLoading(true)
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        })
        const data = await res.json()
        setResults({
          users: (data.users ?? []).slice(0, 5),
          collections: (data.collections ?? []).slice(0, 5),
          mints: (data.mints ?? []).slice(0, 5),
        })
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return
        setResults(null)
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
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
        className="px-3 py-1.5 text-dim hover:text-ink transition-colors flex-shrink-0"
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
            className="w-64 bg-white text-surface font-mono text-xs rounded-full px-4 py-1.5 focus:outline-none placeholder-[#999]"
          />
          {loading && (
            <Loader2 size={11} className="absolute right-3 text-[#999] animate-spin" />
          )}
        </div>
      )}

      {/* Dropdown */}
      {showDropdown && (
        <div className="absolute top-full right-0 w-72 bg-[#161616] border border-line z-[60] overflow-hidden">
          {!hasResults && !loading && (
            <p className="px-4 py-3 text-xs font-mono text-muted text-center">
              no results for &ldquo;{query.trim()}&rdquo;
            </p>
          )}

          {results && results.users.length > 0 && (
            <section>
              <p className="px-3 pt-2.5 pb-1 text-[9px] font-mono uppercase tracking-widest text-subtle">Users</p>
              {results.users.map((user) => (
                <Link
                  key={user.address}
                  href={`/profile/${user.address}`}
                  onClick={close}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#1e1e1e] transition-colors"
                >
                  <ProfileAvatar address={user.address} avatarUrl={user.avatarUrl} size={22} />
                  <span className="text-xs text-ink font-mono truncate">
                    {user.username || shortAddress(user.address)}
                  </span>
                </Link>
              ))}
            </section>
          )}

          {results && results.collections.length > 0 && (
            <section>
              <p className="px-3 pt-2.5 pb-1 text-[9px] font-mono uppercase tracking-widest text-subtle">Collections</p>
              {results.collections.map((col) => (
                <Link
                  key={col.address}
                  href={`/collection/${col.address}`}
                  onClick={close}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#1e1e1e] transition-colors"
                >
                  <ResultThumb src={col.image} alt={col.name} name={col.name} />
                  <span className="text-xs text-ink font-mono truncate flex-1">{col.name}</span>
                </Link>
              ))}
            </section>
          )}

          {results && results.mints.length > 0 && (
            <section>
              <p className="px-3 pt-2.5 pb-1 text-[9px] font-mono uppercase tracking-widest text-subtle">Mints</p>
              {results.mints.map((mint) => (
                <Link
                  key={mint.id}
                  href={`/moment/${mint.address}/${mint.tokenId}`}
                  onClick={close}
                  className="flex items-center gap-2.5 px-3 py-2 hover:bg-[#1e1e1e] transition-colors"
                >
                  <ResultThumb src={mint.image} alt={mint.name} name={mint.name} preferProxy={isPatronCollection(mint.address)} />
                  <span className="text-xs text-ink font-mono truncate">{mint.name}</span>
                </Link>
              ))}
            </section>
          )}

          <div className="border-t border-line px-3 py-2 flex justify-end">
            <button
              onClick={handleSeeAll}
              className="text-[9px] font-mono uppercase tracking-widest text-muted hover:text-dim transition-colors"
            >
              see all results →
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
