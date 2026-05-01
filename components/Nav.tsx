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

export function Nav() {
  const pathname = usePathname()
  const { address, isConnected } = useAccount()
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [searchOpen, setSearchOpen] = useState(false)
  const [modalQuery, setModalQuery] = useState('')

  useEffect(() => {
    if (!address) { setAvatarUrl(undefined); return }
    fetch(`/api/profile/${address}`)
      .then((r) => r.json())
      .then((d) => setAvatarUrl(d.profile?.avatarUrl))
      .catch(() => {})
  }, [address])

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-[#2a2a2a] bg-[#0d0d0d]/90 backdrop-blur-sm">
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
            {isConnected && address && <NotificationBell address={address} />}
            <WalletButton />
            {isConnected && address && (
              <Link href={`/profile/${address}`} className="flex-shrink-0">
                <ProfileAvatar address={address} avatarUrl={avatarUrl} size={32} clickable />
              </Link>
            )}
          </div>
        </div>
      </header>

      {searchOpen && <SearchModal onClose={() => { setSearchOpen(false); setModalQuery('') }} initialQuery={modalQuery} />}
    </>
  )
}
