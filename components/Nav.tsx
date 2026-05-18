'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useAccount } from 'wagmi'
import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { WalletButton } from './WalletButton'
import { ProfileAvatar } from './ProfileAvatar'
import { SearchBar } from './SearchBar'
import { SearchModal } from './SearchModal'
import { NotificationBell } from './NotificationBell'
import { useFarcaster } from '@/providers/FarcasterProvider'

export function Nav() {
  const pathname = usePathname()
  const { address, isConnected } = useAccount()
  const { identity: fcIdentity } = useFarcaster()
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
      <header
        className="fixed top-0 left-0 right-0 z-50 border-b border-[#2a2a2a] bg-[#0d0d0d]/90 backdrop-blur-sm"
        // Pad the header by --safe-top so the dark background extends
        // through the device's notch / status bar while the actual nav
        // content (h-14 below) sits in the visible area. On web, --safe-top
        // is 0 and nothing changes.
        style={{ paddingTop: 'var(--safe-top)' }}
      >
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3 sm:gap-8">
            <Link href="/" className="text-sm font-mono tracking-widest uppercase accent-grad">
              Kismet Art
            </Link>
            <nav className="flex items-center gap-0.5 sm:gap-1">
              <Link
                href="/"
                className={`px-2 sm:px-3 py-1.5 text-xs font-mono tracking-wider uppercase transition-colors ${
                  pathname === '/' ? 'text-[#888] font-bold' : 'text-[#888] hover:text-[#efefef]'
                }`}
              >
                <span className="sm:hidden">enjoy</span>
                <span className="hidden sm:inline">Discover</span>
              </Link>
              <Link
                href="/mint"
                className={`px-2 sm:px-3 py-1.5 text-xs font-mono tracking-wider uppercase transition-colors ${
                  pathname === '/mint' ? 'text-[#888] font-bold' : 'text-[#888] hover:text-[#efefef]'
                }`}
              >
                Mint
              </Link>
              <div className="hidden sm:block">
                <SearchBar onOpenModal={(q) => { setModalQuery(q); setSearchOpen(true) }} />
              </div>
            </nav>
          </div>

          <div className="flex items-center gap-3">
            {/* Search icon on mobile */}
            <button
              onClick={() => { setModalQuery(''); setSearchOpen(true) }}
              className="sm:hidden text-[#888] hover:text-[#efefef] transition-colors p-1"
            >
              <Search size={18} />
            </button>
            {effectiveSignedIn && effectiveAddress && <NotificationBell address={effectiveAddress} />}
            <WalletButton />
            {effectiveSignedIn && effectiveAddress && (
              <Link href={`/profile/${effectiveAddress}`} className="flex-shrink-0">
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
