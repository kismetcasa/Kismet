'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { Search, X, Loader2 } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useFocusTrap } from '@/hooks/useFocusTrap'
import { ProfileAvatar } from './ProfileAvatar'
import { MomentImage } from './MomentImage'
import { shortAddress } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { isOperatorAddress } from '@/lib/config'
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

  // Subtitle = the artist's @handle, resolved the same way
  // CollectionCard/CollectionRow do: suppress the operator smart wallet
  // (platform-deployed, no profile), async-resolve the username, and fall
  // back to the artist's short address. Showing the artist is more useful
  // than the raw contract address — only fall back to that when the meta
  // carries no artist at all, so the row never loses its subtitle.
  const artistAddr = isOperatorAddress(col.artist) ? undefined : col.artist
  const [subtitle, setSubtitle] = useState<string>(
    artistAddr ? shortAddress(artistAddr) : shortAddress(col.address),
  )
  useEffect(() => {
    if (!artistAddr) return
    fetchCreatorProfile(artistAddr).then(({ name }) => {
      // profileCache returns the username when set, otherwise a short
      // address — the `@` prefix only makes sense for a real username.
      const isUsername = name && name !== shortAddress(artistAddr)
      setSubtitle(isUsername ? `@${name}` : shortAddress(artistAddr))
    })
  }, [artistAddr])

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
        <p className="text-xs text-muted font-mono truncate">{subtitle}</p>
      </div>
    </Link>
  )
}

export function SearchModal({ onClose, initialQuery = '' }: SearchModalProps) {
  const [query, setQuery] = useState(initialQuery)
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  // Focus containment + restore-on-close. The input autofocus below runs
  // first; the trap leaves existing inner focus alone.
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEscapeKey(onClose)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) { setResults(null); return }
    setLoading(true)
    // AbortController so a new keystroke cancels the previous in-flight
    // request. Without this, fast typing stacks N fetches against the
    // server's 30-req/min ratelimit AND saturates the webview's
    // per-host connection pool — both contribute to perceived freeze
    // on mobile.
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        })
        if (!res.ok) throw new Error('Search failed')
        setResults(await res.json())
      } catch (err) {
        // AbortError is the expected path when the effect cleanup
        // cancels us — don't blank the results, the next effect run is
        // about to populate them.
        if ((err as Error)?.name === 'AbortError') return
        setResults({ users: [], collections: [], mints: [] })
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const hasResults = results && (
    results.users.length > 0 || results.collections.length > 0 || results.mints.length > 0
  )
  const searched = query.trim().length >= 2

  return (
    <div
      // backdrop-blur removed: it's GPU-expensive in mobile webviews
      // and visibly janks the keyboard slide-in animation in Mini App
      // hosts. Solid /85 reads as a strong-enough overlay without the
      // perf cost. Use --safe-top so the modal clears device chrome
      // on Mini App; falls back to 0 (=> pt-16) on regular web.
      className="fixed inset-0 z-[100] bg-black/85 flex items-start justify-center px-4"
      style={{ paddingTop: 'calc(4rem + var(--safe-top))' }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* max-h-[70dvh]: dynamic viewport height shrinks when the
          iOS keyboard appears (vh doesn't), so the modal stays fully
          visible above the keyboard instead of running under it. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        tabIndex={-1}
        className="w-full max-w-lg flex flex-col bg-[#161616] border border-line max-h-[70dvh]"
      >
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          <Search size={15} className="text-muted flex-shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search mints, collections, users…"
            // type=search gives mobile keyboards a "search" action key.
            // enterKeyHint is the modern equivalent that Safari iOS
            // also respects.
            type="search"
            enterKeyHint="search"
            // autoCapitalize=none + autoCorrect=off: search queries
            // are rarely sentences — turning these off prevents the
            // first-keystroke jank where iOS shows a correction bar.
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            // 16px font on the input is the iOS-WebKit threshold that
            // disables auto-zoom-on-focus. Below 16, focusing the
            // input zooms the viewport — combined with the keyboard
            // slide-in it reads as a "freeze". Tailwind text-base = 1rem.
            className="flex-1 bg-transparent text-base sm:text-sm text-ink font-mono placeholder-subtle focus:outline-none"
          />
          {loading && <Loader2 size={14} className="text-muted animate-spin flex-shrink-0" />}
          <button onClick={onClose} className="text-muted hover:text-dim flex-shrink-0 transition-colors">
            <X size={14} />
          </button>
        </div>

        {/* Results */}
        <div className="overflow-y-auto">
          {!searched && (
            <p className="px-4 py-6 text-xs font-mono text-subtle text-center">
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
              <p className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-subtle">Users</p>
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
              <p className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-subtle">Collections</p>
              {results.collections.map((col) => (
                <CollectionResult key={col.address} col={col} onClose={onClose} />
              ))}
            </section>
          )}

          {results && results.mints.length > 0 && (
            <section className="mb-1">
              <p className="px-4 pt-3 pb-1 text-[9px] font-mono uppercase tracking-widest text-subtle">Mints</p>
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
