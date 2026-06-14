'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname } from 'next/navigation'
import { useAccount } from 'wagmi'
import { useEffect, useRef, useState } from 'react'
import { Search, ChevronDown } from 'lucide-react'
import { WalletButton } from './WalletButton'
import { ProfileAvatar } from './ProfileAvatar'
import { SearchBar } from './SearchBar'
import { SearchModal } from './SearchModal'
import { NotificationBell } from './NotificationBell'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { useAdmin } from '@/contexts/AdminContext'

// Nav destinations. URLs are canonical so `label` (desktop) and
// `mobileLabel` (mobile / Mini App dropdown) are purely cosmetic
// re-skins — the same /, /mint, /market routes back both.
//
// Order is meaningful — Market is intentionally LAST so it always
// sits at the bottom of the mobile dropdown when it isn't the
// current page.
const NAV_PAGES = [
  { id: 'enjoy',  label: 'Discover', mobileLabel: 'Enjoy',  href: '/' },
  { id: 'mint',   label: 'Mint',     mobileLabel: 'Create',   href: '/mint' },
  { id: 'agent',  label: 'Agent',    mobileLabel: 'Agent',  href: '/agent' },
  { id: 'market', label: 'Market',   mobileLabel: 'Curate', href: '/market' },
] as const

type NavPageId = (typeof NAV_PAGES)[number]['id']

function navPageForPath(pathname: string): NavPageId {
  if (pathname === '/mint' || pathname.startsWith('/mint/')) return 'mint'
  if (pathname === '/agent' || pathname.startsWith('/agent/')) return 'agent'
  if (pathname === '/market' || pathname.startsWith('/market/')) return 'market'
  // Default to Enjoy for `/` AND for every non-nav route (profile,
  // moment, collection detail, etc.). The logo always links back to
  // `/` so users on a detail page still have an explicit Enjoy route.
  return 'enjoy'
}

// Mobile / Mini App dropdown — one page label at a time with a
// chevron, click to reveal the other two destinations. Used at < sm
// breakpoints where three inline buttons + search + bell + wallet +
// avatar overrun the viewport.
function NavDropdown() {
  const pathname = usePathname()
  const currentId = navPageForPath(pathname)
  const current = NAV_PAGES.find((p) => p.id === currentId)!
  // Drop only the current page from the list — preserves source order,
  // which keeps Market in the last slot when it isn't the current page.
  const others = NAV_PAGES.filter((p) => p.id !== currentId)

  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEscapeKey(() => setOpen(false))

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 px-2 py-1.5 text-xs font-mono tracking-wider uppercase text-ink transition-colors"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span>{current.mobileLabel}</span>
        <ChevronDown
          size={12}
          className={`text-dim transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={2}
        />
      </button>

      {/* Always render the menu DOM so the first click is a CSS-only
          show/hide, not a React mount-and-paint. The freeze users saw
          on first tap was the React tree mounting the menu + the
          Links' prefetch logic firing at the same time the Mini App
          bootstrap was finishing — both contending for the main
          thread. Hidden via Tailwind `hidden` so it's invisible to
          screen readers when closed. */}
      <div
        role="menu"
        aria-hidden={!open}
        className={`absolute top-full left-0 mt-1 min-w-[8rem] border border-line bg-[#0d0d0d]/95 z-[60] flex flex-col ${
          open ? '' : 'hidden'
        }`}
      >
        {others.map((p) => (
          <Link
            key={p.id}
            href={p.href}
            onClick={() => setOpen(false)}
            // prefetch=false: skip Next.js's route prefetch on the
            // dropdown items. Mini App users navigate rarely; the
            // prefetch cost on a slow connection is more friction than
            // it saves.
            prefetch={false}
            className="px-3 py-2 text-xs font-mono tracking-wider uppercase text-dim hover:text-ink hover:bg-[#1e1e1e] transition-colors"
            role="menuitem"
          >
            {p.mobileLabel}
          </Link>
        ))}
      </div>
    </div>
  )
}

// Desktop nav — three inline links with canonical labels and an
// active-state highlight. The space is there at sm: and up, no
// reason to hide it behind a dropdown. The Admin link slots in
// after Market for users whose connected wallet is the platform
// admin — isAdmin is server-checked in AdminContext (via
// /api/admin/me) so we don't expose ADMIN_ADDRESS to the client
// bundle by comparing in JS.
function NavInline() {
  const pathname = usePathname()
  const currentId = navPageForPath(pathname)
  const { isAdmin } = useAdmin()
  return (
    <div className="flex items-center gap-1">
      {NAV_PAGES.map((p) => {
        const isActive = p.id === currentId
        return (
          <Link
            key={p.id}
            href={p.href}
            className={`px-3 py-1.5 text-xs font-mono tracking-wider uppercase transition-colors ${
              isActive ? 'text-ink font-bold' : 'text-dim hover:text-ink'
            }`}
          >
            {p.label}
          </Link>
        )
      })}
      {isAdmin && (
        <Link
          href="/admin"
          className={`px-3 py-1.5 text-xs font-mono tracking-wider uppercase transition-colors ${
            pathname.startsWith('/admin') ? 'text-ink font-bold' : 'text-dim hover:text-ink'
          }`}
        >
          Admin
        </Link>
      )}
    </div>
  )
}

export function Nav() {
  const { address, isConnected } = useAccount()
  const { identity: fcIdentity, isInMiniApp } = useFarcaster()
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [searchOpen, setSearchOpen] = useState(false)
  const [modalQuery, setModalQuery] = useState('')

  // FC primary is the canonical Kismet identity whenever it's available:
  //   - Mini App: identity comes from the verified Quick Auth JWT
  //   - Web with an FC-verified wallet: identity comes from the reverse
  //     lookup in FarcasterProvider (works for any of the user's verified
  //     wallets — primary or sibling)
  //   - Web with a non-FC wallet: falls back to wagmi address
  // Profile link, avatar, and notification scope all key off this so the
  // user sees the same Kismet identity regardless of which of their
  // wallets they happen to have connected.
  const effectiveAddress = fcIdentity?.address ?? address
  const effectiveSignedIn = !!fcIdentity?.address || isConnected

  useEffect(() => {
    if (!effectiveAddress) { setAvatarUrl(undefined); return }
    // Seed instantly with the FC pfp from host context so the avatar
    // doesn't flash a blockie before the /api/profile round-trip lands.
    if (fcIdentity?.pfpUrl) setAvatarUrl(fcIdentity.pfpUrl)
    fetch(`/api/profile/${effectiveAddress}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setAvatarUrl(d.profile?.avatarUrl))
      .catch(() => {})
  }, [effectiveAddress, fcIdentity?.pfpUrl])

  return (
    <>
      {/* No backdrop-filter: Safari recomputes the blur every scroll
          frame over the playing-video feed behind this fixed bar, and
          the GPU cost shows up as jank. Solid /95 stays visually flat. */}
      <header
        className="fixed top-0 left-0 right-0 z-50 border-b border-line bg-[#0d0d0d]/95"
        // Pad the header by --safe-top so the dark background extends
        // through the device's notch / status bar while the actual nav
        // content (h-14 below) sits in the visible area. On web, --safe-top
        // is 0 and nothing changes.
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3 sm:gap-8">
            <Link
              href="/"
              aria-label="Kismet"
              className="flex items-center gap-2 text-sm font-mono tracking-widest uppercase"
            >
              <Image
                src="/logo.png"
                alt=""
                width={36}
                height={36}
                className="object-contain"
                priority
              />
              {/* Wordmark visibility:
               *   Mini App: always hidden — implicit sign-in, tight space.
               *   Mobile web + signed-in: hidden so the avatar/notif row
               *     doesn't get clipped at narrow widths.
               *   Mobile web signed-out + desktop (any state): shown. */}
              {!isInMiniApp && (
                <span className={`accent-grad${effectiveSignedIn ? ' hidden sm:inline' : ''}`}>
                  Kismet
                </span>
              )}
            </Link>
            <nav className="flex items-center gap-1 sm:gap-3">
              <div className="sm:hidden">
                <NavDropdown />
              </div>
              <div className="hidden sm:block">
                <NavInline />
              </div>
              <div className="hidden sm:block">
                <SearchBar onOpenModal={(q) => { setModalQuery(q); setSearchOpen(true) }} />
              </div>
            </nav>
          </div>

          {/* Mobile order: search → bell → name → avatar — all hugging
              the right edge, tightly coupled (gap-1). Desktop order:
              bell → name → avatar (unchanged) via sm:order-* overrides. */}
          <div className="flex items-center gap-1 sm:gap-3">
            {/* Search icon on mobile */}
            <button
              onClick={() => { setModalQuery(''); setSearchOpen(true) }}
              className="sm:hidden order-1 text-dim hover:text-ink transition-colors p-1"
            >
              <Search size={18} />
            </button>
            {effectiveSignedIn && effectiveAddress && (
              <div className="order-2 sm:order-1">
                <NotificationBell address={effectiveAddress} />
              </div>
            )}
            <div className="order-3 sm:order-2">
              <WalletButton />
            </div>
            {effectiveSignedIn && effectiveAddress && (
              <Link href={`/profile/${effectiveAddress}`} className="order-4 sm:order-3 flex-shrink-0">
                <ProfileAvatar address={effectiveAddress} avatarUrl={avatarUrl} size={32} clickable />
              </Link>
            )}
          </div>
        </div>
      </header>

      {searchOpen && <SearchModal onClose={() => { setSearchOpen(false); setModalQuery('') }} initialQuery={modalQuery} />}
    </>
  )
}
