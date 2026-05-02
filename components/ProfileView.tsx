'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useAccount, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Pencil, ChevronRight, Copy, Check, X, Search } from 'lucide-react'
import { ProfileAvatar } from './ProfileAvatar'
import { MomentCard } from './MomentCard'
import { MarketCard } from './MarketCard'
import type { Listing } from '@/lib/listings'
import type { Moment } from '@/lib/inprocess'
import { shortAddress, formatPrice } from '@/lib/inprocess'

interface Payment {
  id: string
  amount: string
  hash: string
  token: { contractAddress: string; tokenId?: string; createdAt?: string }
  buyer: { address: string; username?: string }
}

interface ArtistCollection {
  contractAddress: string
  name: string
  metadata?: { name?: string; image?: string; description?: string }
  createdAt?: string
}

// ─── section ordering / collapse ─────────────────────────────────────────────

type SectionId = 'mints' | 'collected' | 'listings' | 'payments'

const DEFAULT_ORDER: SectionId[] = ['mints', 'collected', 'listings', 'payments']
const SECTIONS_KEY = 'kismetart:profile-sections'

interface SectionsConfig {
  order: SectionId[]
  collapsed: Partial<Record<SectionId, boolean>>
}

function loadSectionsConfig(): SectionsConfig {
  if (typeof window === 'undefined') return { order: DEFAULT_ORDER, collapsed: {} }
  try {
    const raw = localStorage.getItem(SECTIONS_KEY)
    if (!raw) return { order: DEFAULT_ORDER, collapsed: {} }
    const parsed = JSON.parse(raw) as SectionsConfig
    const validOrder =
      Array.isArray(parsed.order) &&
      parsed.order.length === DEFAULT_ORDER.length &&
      DEFAULT_ORDER.every((s) => parsed.order.includes(s))
    return { order: validOrder ? parsed.order : DEFAULT_ORDER, collapsed: parsed.collapsed ?? {} }
  } catch {
    return { order: DEFAULT_ORDER, collapsed: {} }
  }
}

// ─── follow row (lazy-loads display name) ────────────────────────────────────

function FollowRow({ addr, onClose, onNameLoaded }: { addr: string; onClose: () => void; onNameLoaded?: (addr: string, name: string) => void }) {
  const [name, setName] = useState(() => shortAddress(addr))
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)

  useEffect(() => {
    fetch(`/api/profile/${addr}`)
      .then((r) => r.json())
      .then((d) => {
        const n = d.profile?.username || d.profile?.ensName
        if (n) { setName(n); onNameLoaded?.(addr, n) }
        if (d.profile?.avatarUrl) setAvatarUrl(d.profile.avatarUrl)
      })
      .catch(() => {})
  // onNameLoaded is a ref-mutating callback — intentionally excluded from deps
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addr])

  return (
    <Link
      href={`/profile/${addr}`}
      onClick={onClose}
      className="flex items-center gap-3 px-5 py-3 border-b border-[#1a1a1a] hover:bg-[#1a1a1a] transition-colors last:border-b-0"
    >
      <ProfileAvatar address={addr} avatarUrl={avatarUrl} size={28} clickable />
      <span className="text-xs font-mono text-[#888]">{name}</span>
    </Link>
  )
}

// ─── component ───────────────────────────────────────────────────────────────

interface ProfileViewProps {
  address: string
}

interface Profile {
  address: string
  username?: string
  ensName?: string
  avatarUrl?: string
  updatedAt: number
}

export function ProfileView({ address }: ProfileViewProps) {
  const { address: connectedAddress } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signMessageAsync } = useSignMessage()

  const isOwner = connectedAddress?.toLowerCase() === address.toLowerCase()

  const [profile, setProfile] = useState<Profile | null>(null)
  const [moments, setMoments] = useState<Moment[]>([])
  const [collected, setCollected] = useState<Moment[]>([])
  const [listings, setListings] = useState<Listing[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [artistCollections, setArtistCollections] = useState<ArtistCollection[]>([])
  const [loadingProfile, setLoadingProfile] = useState(true)
  const [loadingMoments, setLoadingMoments] = useState(true)
  const [loadingCollected, setLoadingCollected] = useState(true)
  const [loadingListings, setLoadingListings] = useState(true)
  const [loadingPayments, setLoadingPayments] = useState(true)
  const [loadingCollections, setLoadingCollections] = useState(true)
  const [editing, setEditing] = useState(false)
  const [usernameInput, setUsernameInput] = useState('')
  const [avatarInput, setAvatarInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [collectionsMode, setCollectionsMode] = useState(false)
  const [following, setFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)

  const [followingCount, setFollowingCount] = useState<number | null>(null)
  const [followerCount, setFollowerCount] = useState<number | null>(null)
  const [activeList, setActiveList] = useState<'following' | 'followers' | null>(null)
  const [listAddresses, setListAddresses] = useState<string[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const listReqRef = useRef(0)
  const nameMapRef = useRef<Record<string, string>>({})

  // Section state — hydrated from localStorage after mount
  const [sectionOrder, setSectionOrder] = useState<SectionId[]>(DEFAULT_ORDER)
  const [sectionCollapsed, setSectionCollapsed] = useState<Partial<Record<SectionId, boolean>>>({})
  const [draggingSection, setDraggingSection] = useState<SectionId | null>(null)
  const dragIdx = useRef<number | null>(null)

  useEffect(() => {
    const config = loadSectionsConfig()
    setSectionOrder(config.order)
    setSectionCollapsed(config.collapsed)
  }, [])

  // Reset list modal on profile navigation
  useEffect(() => {
    setActiveList(null)
    setListAddresses([])
  }, [address])

  // ESC closes the follow modal; lock body scroll while open
  useEffect(() => {
    if (!activeList) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setActiveList(null) }
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', handler)
    return () => {
      window.removeEventListener('keydown', handler)
      document.body.style.overflow = ''
    }
  }, [activeList])

  useEffect(() => {
    if (!isOwner) setEditing(false)
  }, [isOwner])

  useEffect(() => {
    if (!connectedAddress || isOwner) { setFollowing(false); return }
    fetch(`/api/follow/${address}?follower=${connectedAddress}`)
      .then((r) => r.json())
      .then((d) => setFollowing(d.following === true))
      .catch(() => {})
  }, [address, connectedAddress, isOwner])

  useEffect(() => {
    fetch(`/api/follow/${address}?count=1`)
      .then((r) => r.json())
      .then((d) => {
        setFollowingCount(d.followingCount ?? 0)
        setFollowerCount(d.followerCount ?? 0)
      })
      .catch(() => { setFollowingCount(0); setFollowerCount(0) })
  }, [address])

  useEffect(() => {
    fetch(`/api/profile/${address}`)
      .then((r) => r.json())
      .then((d) => setProfile(d.profile ?? { address, updatedAt: 0 }))
      .catch(() => setProfile({ address, updatedAt: 0 }))
      .finally(() => setLoadingProfile(false))
  }, [address])

  useEffect(() => {
    fetch(`/api/timeline?creator=${address}&limit=50`)
      .then((r) => r.json())
      .then((d) => setMoments(Array.isArray(d.moments) ? d.moments : []))
      .catch(() => setMoments([]))
      .finally(() => setLoadingMoments(false))
  }, [address])

  useEffect(() => {
    fetch(`/api/timeline?collector=${address}&limit=50`)
      .then((r) => r.json())
      .then((d) => setCollected(Array.isArray(d.moments) ? d.moments : []))
      .catch(() => setCollected([]))
      .finally(() => setLoadingCollected(false))
  }, [address])

  useEffect(() => {
    fetch(`/api/listings?seller=${address}&limit=50`)
      .then((r) => r.json())
      .then((d) => setListings(Array.isArray(d.listings) ? d.listings.filter((l: Listing) => l.status === 'active') : []))
      .catch(() => setListings([]))
      .finally(() => setLoadingListings(false))
  }, [address])

  useEffect(() => {
    fetch(`/api/payments?artist=${address}`)
      .then((r) => r.json())
      .then((d) => setPayments(Array.isArray(d.payments) ? d.payments : []))
      .catch(() => setPayments([]))
      .finally(() => setLoadingPayments(false))
  }, [address])

  useEffect(() => {
    fetch(`/api/collections?artist=${address}`)
      .then((r) => r.json())
      .then((d) => setArtistCollections(Array.isArray(d.collections) ? d.collections : []))
      .catch(() => setArtistCollections([]))
      .finally(() => setLoadingCollections(false))
  }, [address])

  // ─── section drag / collapse ──────────────────────────────────────────────

  function persistSections(order: SectionId[], collapsed: Partial<Record<SectionId, boolean>>) {
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify({ order, collapsed })) } catch {}
  }

  function onDragStart(idx: number) {
    dragIdx.current = idx
    setDraggingSection(sectionOrder[idx])
  }

  function onDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault()
    if (dragIdx.current === null || dragIdx.current === idx) return
    // Only swap once the cursor crosses the midpoint of the target section
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const mid = rect.top + rect.height / 2
    if (dragIdx.current < idx && e.clientY < mid) return
    if (dragIdx.current > idx && e.clientY > mid) return
    const next = [...sectionOrder]
    const [moved] = next.splice(dragIdx.current, 1)
    next.splice(idx, 0, moved)
    dragIdx.current = idx
    setSectionOrder(next)
    persistSections(next, sectionCollapsed)
  }

  function onDragEnd() {
    dragIdx.current = null
    setDraggingSection(null)
  }

  function toggleCollapsed(section: SectionId) {
    const next = { ...sectionCollapsed, [section]: !sectionCollapsed[section] }
    setSectionCollapsed(next)
    persistSections(sectionOrder, next)
  }

  // ─── follow / list helpers ────────────────────────────────────────────────

  async function openList(type: 'following' | 'followers') {
    if (activeList === type) { setActiveList(null); return }
    setActiveList(type)
    setListAddresses([])
    setLoadingList(true)
    setSearchOpen(false)
    setSearchQuery('')
    nameMapRef.current = {}
    const reqId = ++listReqRef.current
    try {
      const param = type === 'following' ? 'list=1' : 'followers=1'
      const res = await fetch(`/api/follow/${address}?${param}`)
      const d = await res.json()
      if (reqId !== listReqRef.current) return
      setListAddresses(Array.isArray(d.addresses) ? d.addresses : [])
    } catch {
      if (reqId === listReqRef.current) setListAddresses([])
    } finally {
      if (reqId === listReqRef.current) setLoadingList(false)
    }
  }

  function openEdit() {
    setUsernameInput(profile?.username ?? '')
    setAvatarInput(profile?.avatarUrl ?? '')
    setEditing(true)
  }

  async function saveProfile() {
    if (!isOwner || !connectedAddress) { openConnectModal?.(); return }
    setSaving(true)
    try {
      const nonceRes = await fetch(`/api/profile/${address}/nonce`)
      const { nonce } = await nonceRes.json()
      const message = `Update Kismet Art profile\nAddress: ${address.toLowerCase()}\nNonce: ${nonce}`
      const signature = await signMessageAsync({ message })
      const res = await fetch(`/api/profile/${address}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput.trim() || undefined, avatarUrl: avatarInput.trim() || undefined, signature, nonce }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Failed to save') }
      const { profile: updated } = await res.json()
      setProfile(updated)
      setEditing(false)
      toast.success('Profile updated')
    } catch (err) {
      toast.error('Failed to update profile', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setSaving(false)
    }
  }

  async function handleFollow() {
    if (!connectedAddress) { openConnectModal?.(); return }
    setFollowLoading(true)
    try {
      const nonceRes = await fetch(`/api/profile/${connectedAddress}/nonce`)
      const { nonce } = await nonceRes.json()
      const action = following ? 'Unfollow' : 'Follow'
      const message = `${action} ${address.toLowerCase()} on Kismet Art\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
      const signature = await signMessageAsync({ message })
      const res = await fetch(`/api/follow/${address}`, {
        method: following ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ follower: connectedAddress, signature, nonce }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Failed') }
      const wasFollowing = following
      setFollowing(!wasFollowing)
      setFollowerCount((c) => c === null ? null : wasFollowing ? c - 1 : c + 1)
      toast.success(wasFollowing ? 'Unfollowed' : 'Following')
    } catch (err) {
      toast.error('Failed', { description: err instanceof Error ? err.message : 'Unknown error' })
    } finally {
      setFollowLoading(false)
    }
  }

  // ─── section content map ──────────────────────────────────────────────────

  const skeleton = (n: number) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="aspect-square bg-[#111] animate-pulse border border-[#1a1a1a]" />
      ))}
    </div>
  )

  const sectionLabel: Record<SectionId, string> = {
    mints: 'Mints',
    collected: 'Collected',
    listings: 'Listings',
    payments: 'Sales',
  }
  const sectionCount: Record<SectionId, number | null> = {
    mints: loadingMoments ? null : moments.length,
    collected: loadingCollected ? null : collected.length,
    listings: loadingListings ? null : listings.length,
    payments: loadingPayments ? null : payments.length,
  }
  const sectionContent: Record<SectionId, React.ReactNode> = {
    mints: collectionsMode ? (
      loadingCollections ? (
        <div className="flex flex-col gap-1">
          {[0, 1, 2].map((i) => <div key={i} className="h-12 bg-[#111] animate-pulse border border-[#1a1a1a]" />)}
        </div>
      ) : artistCollections.length === 0 ? (
        <p className="text-[#555] font-mono text-xs">no collections yet</p>
      ) : (
        <div className="flex flex-col divide-y divide-[#1a1a1a]">
          {artistCollections.map((c) => (
            <a
              key={c.contractAddress}
              href={`https://inprocess.world/collect/base:${c.contractAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-between py-2.5 gap-4 group"
            >
              <span className="text-xs font-mono text-[#efefef] group-hover:accent-grad transition-colors truncate">
                {c.metadata?.name || c.name}
              </span>
              <span className="text-[10px] font-mono text-[#444] group-hover:text-[#888] transition-colors flex-shrink-0">
                {shortAddress(c.contractAddress)}
              </span>
            </a>
          ))}
        </div>
      )
    ) : (
      loadingMoments ? skeleton(6) : moments.length === 0
        ? <p className="text-[#555] font-mono text-xs">no mints yet</p>
        : <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">{moments.map((m) => <MomentCard key={m.id} moment={m} hidePriceSupply />)}</div>
    ),
    collected: loadingCollected ? skeleton(6) : collected.length === 0
      ? <p className="text-[#555] font-mono text-xs">none collected yet</p>
      : <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">{collected.map((m) => <MomentCard key={m.id} moment={m} hidePriceSupply />)}</div>,
    listings: loadingListings ? skeleton(3) : listings.length === 0
      ? (
        <p className="text-[#555] font-mono text-xs">
          collect a moment on discover then{' '}
          <Link href={`/profile/${address}`} className="accent-grad hover:opacity-80 transition-opacity">list</Link>
          {' '}it here
        </p>
      )
      : <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">{listings.map((l) => <MarketCard key={l.id} listing={l} onRemove={() => setListings((prev) => prev.filter((x) => x.id !== l.id))} />)}</div>,
    payments: loadingPayments ? (
      <div className="flex flex-col gap-1">
        {[0,1,2,3].map((i) => <div key={i} className="h-10 bg-[#111] animate-pulse border border-[#1a1a1a]" />)}
      </div>
    ) : payments.length === 0 ? (
      <p className="text-[#555] font-mono text-xs">no sales yet</p>
    ) : (
      <div className="flex flex-col divide-y divide-[#1a1a1a]">
        {payments.map((p) => (
          <div key={p.id} className="flex items-center justify-between py-2.5 gap-4">
            <span className="text-xs font-mono text-[#555]">
              {p.buyer.username || shortAddress(p.buyer.address)}
            </span>
            <span className="text-xs font-mono accent-grad flex-shrink-0">
              {(() => { try { return formatPrice(p.amount) } catch { return `${p.amount} wei` } })()}
            </span>
            <a
              href={`https://basescan.org/tx/${p.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-mono text-[#444] hover:text-[#888] transition-colors flex-shrink-0"
            >
              {p.hash.slice(0, 8)}…
            </a>
          </div>
        ))}
      </div>
    ),
  }

  // ─── render ───────────────────────────────────────────────────────────────

  const displayName = profile?.username || profile?.ensName || shortAddress(address)

  return (
    <div className="max-w-4xl mx-auto px-4 py-12 flex flex-col gap-12">
      {/* Profile header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-6">
          <div className="relative">
            {!loadingProfile ? (
              <ProfileAvatar address={address} avatarUrl={profile?.avatarUrl} size={80} editable={isOwner} onEdit={openEdit} />
            ) : (
              <div className="w-20 h-20 rounded-full bg-[#1a1a1a] animate-pulse" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              {loadingProfile ? (
                <div className="h-4 w-28 bg-[#1a1a1a] animate-pulse rounded" />
              ) : (
                <p className="text-[#efefef] font-mono text-sm">{displayName}</p>
              )}
              {isOwner && !loadingProfile && (
                <button onClick={openEdit} className="text-[#555] hover:text-[#888] transition-colors" title="Edit profile">
                  <Pencil size={12} />
                </button>
              )}
              {!isOwner && connectedAddress && !loadingProfile && (
                <button
                  onClick={handleFollow}
                  disabled={followLoading}
                  className={`text-xs font-mono px-2.5 py-1 border transition-colors disabled:opacity-40 ${
                    following
                      ? 'border-[#555] text-[#888] hover:border-red-900/50 hover:text-red-400'
                      : 'border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef]'
                  }`}
                >
                  {followLoading ? '…' : following ? 'following' : 'follow'}
                </button>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <p className="text-[#555] font-mono text-xs break-all">{address}</p>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(address).catch(() => {})
                  setAddrCopied(true)
                  setTimeout(() => setAddrCopied(false), 1500)
                }}
                className="text-[#444] hover:text-[#888] transition-colors flex-shrink-0"
                title="Copy address"
              >
                {addrCopied ? <Check size={11} className="text-[#6ee7b7]" /> : <Copy size={11} />}
              </button>
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <button
                onClick={() => openList('following')}
                className={`text-xs font-mono transition-colors ${activeList === 'following' ? 'text-[#efefef]' : 'text-[#555] hover:text-[#888]'}`}
              >
                <span className="text-[#efefef]">{followingCount ?? '—'}</span>{' '}following
              </button>
              <span className="text-[#333] text-xs">·</span>
              <button
                onClick={() => openList('followers')}
                className={`text-xs font-mono transition-colors ${activeList === 'followers' ? 'text-[#efefef]' : 'text-[#555] hover:text-[#888]'}`}
              >
                <span className="text-[#efefef]">{followerCount ?? '—'}</span>{' '}followers
              </button>
            </div>
          </div>
        </div>

      </div>

      {/* Following / Followers modal */}
      {activeList && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setActiveList(null) }}
        >
          <div className="w-full max-w-sm bg-[#161616] border border-[#2a2a2a]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#2a2a2a]">
              <p className="text-xs font-mono text-[#888] uppercase tracking-wider">
                {activeList === 'following'
                  ? `Following${followingCount !== null ? ` (${followingCount})` : ''}`
                  : `Followers${followerCount !== null ? ` (${followerCount})` : ''}`}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { setSearchOpen((v) => !v); setSearchQuery('') }}
                  className={`p-1 transition-colors ${searchOpen ? 'text-[#efefef]' : 'text-[#555] hover:text-[#888]'}`}
                  title="search"
                >
                  <Search size={14} />
                </button>
                <button
                  onClick={() => setActiveList(null)}
                  className="p-1 text-[#555] hover:text-[#888] transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            {searchOpen && (
              <div className="px-5 py-2 border-b border-[#2a2a2a]">
                <input
                  autoFocus
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="search…"
                  className="w-full bg-transparent text-xs font-mono text-[#efefef] placeholder-[#333] focus:outline-none"
                />
              </div>
            )}
            <div className="overflow-y-auto max-h-[280px]">
              {loadingList ? (
                <div className="flex flex-col">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex items-center gap-3 px-5 py-3 border-b border-[#1a1a1a]">
                      <div className="w-7 h-7 rounded-full bg-[#1a1a1a] animate-pulse flex-shrink-0" />
                      <div className="h-3 w-28 bg-[#1a1a1a] animate-pulse rounded" />
                    </div>
                  ))}
                </div>
              ) : listAddresses.length === 0 ? (
                <p className="px-5 py-6 text-xs font-mono text-[#555]">no {activeList} yet</p>
              ) : (() => {
                const q = searchQuery.toLowerCase().trim()
                const filtered = q
                  ? listAddresses.filter((a) =>
                      a.toLowerCase().includes(q) ||
                      (nameMapRef.current[a] ?? '').toLowerCase().includes(q)
                    )
                  : listAddresses
                return filtered.length === 0
                  ? <p className="px-5 py-6 text-xs font-mono text-[#555]">no results</p>
                  : (
                    <div className="flex flex-col">
                      {filtered.map((addr) => (
                        <FollowRow
                          key={addr}
                          addr={addr}
                          onClose={() => setActiveList(null)}
                          onNameLoaded={(a, n) => { nameMapRef.current[a] = n }}
                        />
                      ))}
                    </div>
                  )
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Edit profile panel */}
      {editing && isOwner && (
        <div className="border border-[#2a2a2a] p-4 flex flex-col gap-4">
          <p className="text-xs font-mono text-[#888] uppercase tracking-wider">Edit Profile</p>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-mono text-[#555] uppercase tracking-wider">Display Name</label>
            <input
              type="text"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              placeholder={shortAddress(address)}
              maxLength={30}
              className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-mono text-[#555] uppercase tracking-wider">Avatar URL</label>
            <input
              type="url"
              value={avatarInput}
              onChange={(e) => setAvatarInput(e.target.value)}
              placeholder="https://… (leave blank for gradient avatar)"
              className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
            />
          </div>
          <div className="flex gap-3">
            <button onClick={saveProfile} disabled={saving} className="px-4 py-2.5 text-xs font-mono btn-accent">
              {saving ? 'saving…' : 'save'}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="px-4 py-2.5 text-xs font-mono border border-[#2a2a2a] text-[#555] hover:border-[#888] hover:text-[#888] transition-colors disabled:opacity-40"
            >
              cancel
            </button>
          </div>
        </div>
      )}


      {/* Draggable / collapsible sections */}
      <div className="flex flex-col">
        {sectionOrder.map((section, idx) => {
          const isCollapsed = sectionCollapsed[section] ?? false
          const count = sectionCount[section]
          return (
            <div
              key={section}
              onDragOver={(e) => onDragOver(e, idx)}
              className={`border-t border-[#2a2a2a] transition-opacity duration-150 ${draggingSection === section ? 'opacity-40' : 'opacity-100'}`}
            >
              <div
                draggable
                onDragStart={() => onDragStart(idx)}
                onDragEnd={onDragEnd}
                onClick={() => toggleCollapsed(section)}
                className="flex items-center gap-2 py-4 cursor-grab active:cursor-grabbing select-none"
              >
                <ChevronRight
                  size={12}
                  className={`text-[#555] transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
                />
                <h2 className="text-xs font-mono text-[#888] uppercase tracking-wider">
                  {sectionLabel[section]}{count !== null ? ` (${count})` : ''}
                </h2>
                {section === 'mints' && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setCollectionsMode((v) => !v) }}
                    className={`ml-auto text-xs font-mono px-2.5 py-1 border transition-colors ${
                      collectionsMode
                        ? 'border-[#555] text-[#888] hover:border-red-900/50 hover:text-red-400'
                        : 'border-[#2a2a2a] text-[#555] hover:border-[#555] hover:text-[#efefef]'
                    }`}
                  >
                    collections
                  </button>
                )}
              </div>
              {!isCollapsed && (
                <div className="pb-8">
                  {sectionContent[section]}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
