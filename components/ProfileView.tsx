'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { useAccount, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Pencil, ChevronRight, Copy, Check, X, Search, ShieldAlert } from 'lucide-react'
import { ProfileAvatar } from './ProfileAvatar'
import { MomentCard } from './MomentCard'
import { MarketCard } from './MarketCard'
import { CuratePanel } from './CuratePanel'
import { ViewModeToggle } from './ViewModeToggle'
import { CardSwiper, CardSwiperItem } from './CardSwiper'
import { useViewMode } from '@/hooks/useViewMode'
import { useAdmin } from '@/contexts/AdminContext'
import type { Listing } from '@/lib/listings'
import type { Moment } from '@/lib/inprocess'
import type { AirdropRecord } from '@/lib/airdrops'
import { shortAddress, formatPrice } from '@/lib/inprocess'
import { MomentImage } from './MomentImage'
import { useCollectionsPermissions } from '@/hooks/useCollectionsPermissions'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { toastError } from '@/lib/toast'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import { useFinePointer } from '@/hooks/useFinePointer'
import { MaybeLazy } from './LazyMount'
import { WalletsPanel } from './WalletsPanel'

interface Payment {
  id: string
  amount: string
  // Inprocess doesn't currently return a currency hint on payment rows
  // (https://docs.inprocess.world/payments). Default to ETH; if they add it
  // later, we'll thread it through formatPrice. The amount field is
  // human-formatted ("0.1", "5") not base units, so formatPrice handles
  // both shapes correctly.
  currency?: 'eth' | 'usdc'
  hash: string
  token: { contractAddress: string; tokenId?: string; createdAt?: string }
  buyer: { address: string; username?: string }
}

interface ArtistCollection {
  contractAddress: string
  name: string
  metadata?: { name?: string; image?: string; description?: string; kismet_thumbhash?: string }
  createdAt?: string
}

// Collection preview thumbnail with multi-gateway fallback. MomentImage
// returns null if every gateway 404s; we wire onAllError to swap in
// the "no preview" placeholder so the tile never renders empty.
function CollectionPreviewImage({ src, alt, thumbhash }: { src?: string; alt: string; thumbhash?: string }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <span className="text-line font-mono text-xs">no preview</span>
      </div>
    )
  }
  return (
    <MomentImage
      src={src}
      alt={alt}
      fill
      className="object-contain transition-transform duration-500 group-hover/img:scale-105"
      sizes="(max-width: 640px) 50vw, 33vw"
      onAllError={() => setFailed(true)}
      preferProxy
      thumbhash={thumbhash}
    />
  )
}

// ─── section ordering / collapse ─────────────────────────────────────────────

type SectionId = 'mints' | 'collected' | 'listings' | 'payments' | 'airdrops' | 'curate'

// `curate` is intentionally absent from DEFAULT_ORDER — it's appended at
// render time only on the curator's own profile, pinned last and not
// drag-reorderable. Keeping it out of the persisted order means it never
// leaks into a non-curator's localStorage state and never shows up where
// it shouldn't.
const DEFAULT_ORDER: SectionId[] = ['mints', 'collected', 'listings', 'payments', 'airdrops']
const SECTIONS_KEY = 'kismetart:profile-sections'

interface SectionsConfig {
  order: SectionId[]
  collapsed: Partial<Record<SectionId, boolean>>
}

// Reconcile a stored ordering with the current DEFAULT_ORDER: drop any
// obsolete sections (renames/removals) and append any newly-introduced
// sections at the end. This preserves user-customized ordering across
// schema bumps — adding a new section appends it instead of resetting.
function reconcileOrder(stored: unknown): SectionId[] {
  if (!Array.isArray(stored)) return DEFAULT_ORDER
  const valid = (stored as unknown[]).filter(
    (s): s is SectionId => typeof s === 'string' && (DEFAULT_ORDER as string[]).includes(s),
  )
  const missing = DEFAULT_ORDER.filter((s) => !valid.includes(s))
  return [...valid, ...missing]
}

function loadSectionsConfig(): SectionsConfig {
  if (typeof window === 'undefined') return { order: DEFAULT_ORDER, collapsed: {} }
  try {
    const raw = localStorage.getItem(SECTIONS_KEY)
    if (!raw) return { order: DEFAULT_ORDER, collapsed: {} }
    const parsed = JSON.parse(raw) as { order?: unknown; collapsed?: SectionsConfig['collapsed'] }
    return { order: reconcileOrder(parsed.order), collapsed: parsed.collapsed ?? {} }
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
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => {
        const n = d.profile?.displayName || d.profile?.username || d.profile?.ensName
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
      className="flex items-center gap-3 px-5 py-3 border-b border-raised hover:bg-raised transition-colors last:border-b-0"
    >
      <ProfileAvatar address={addr} avatarUrl={avatarUrl} size={28} clickable />
      <span className="text-xs font-mono text-dim">{name}</span>
    </Link>
  )
}

// ─── component ───────────────────────────────────────────────────────────────

interface ProfileViewProps {
  address: string
  /**
   * Set by the server-component wrapper (app/profile/[address]/page.tsx)
   * based on request UA. When true, MomentCard / MarketCard grids
   * beyond EAGER_MOUNT_COUNT items defer mount via LazyMount.
   * Default false — every desktop request and any legacy caller gets
   * eager rendering exactly as before this prop existed.
   */
  isMobile?: boolean
}

interface Profile {
  address: string
  username?: string
  ensName?: string
  avatarUrl?: string
  // Server-computed: collapses the username → farcaster → ens fallback
  // chain into a single field. See app/api/profile/[address]/route.ts.
  displayName?: string | null
  updatedAt: number
}

export function ProfileView({ address, isMobile = false }: ProfileViewProps) {
  const { address: connectedAddress } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signMessageAsync } = useSignMessage()
  const { isInMiniApp, identity: fcIdentity } = useFarcaster()
  const { isCurator } = useAdmin()
  // Section reordering is desktop-only — HTML5 draggable breaks tap on
  // touch (taps to expand/collapse a section register seconds late, if
  // at all). See hooks/useFinePointer.
  const allowDrag = useFinePointer()

  // Owner via wagmi (web + Mini App) OR via FC identity (Mini App users
  // whose wagmi wallet is currently a different sibling). Without the
  // FC-identity branch, an FC user visiting their own canonical
  // /profile/<chosen> would see the non-owner view whenever their
  // wagmi-connected wallet was a sibling.
  const isOwner =
    connectedAddress?.toLowerCase() === address.toLowerCase() ||
    fcIdentity?.address?.toLowerCase() === address.toLowerCase()
  // Curators get a Curate panel on their own profile, pinned as the last
  // section. The panel reuses the existing /api/featured plumbing.
  const showCurate = isOwner && isCurator
  // Global view-mode toggle — shared with discover/trending/market via the
  // 'kismetart:view-mode' localStorage key. One toggle in the profile
  // header flips every grid section at once (mints, collected, listings,
  // and the mints>collections sub-mode).
  const [viewMode, setViewMode] = useViewMode()

  const [profile, setProfile] = useState<Profile | null>(null)
  const [moments, setMoments] = useState<Moment[]>([])
  const [collected, setCollected] = useState<Moment[]>([])
  const [listings, setListings] = useState<Listing[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [airdrops, setAirdrops] = useState<AirdropRecord[]>([])
  const [artistCollections, setArtistCollections] = useState<ArtistCollection[]>([])
  const [loadingProfile, setLoadingProfile] = useState(true)
  const [loadingMoments, setLoadingMoments] = useState(true)
  const [loadingCollected, setLoadingCollected] = useState(true)
  const [loadingListings, setLoadingListings] = useState(true)
  const [loadingPayments, setLoadingPayments] = useState(true)
  const [loadingAirdrops, setLoadingAirdrops] = useState(true)
  const [loadingCollections, setLoadingCollections] = useState(true)
  const [editing, setEditing] = useState(false)
  const [usernameInput, setUsernameInput] = useState('')
  const [avatarInput, setAvatarInput] = useState('')
  const [saving, setSaving] = useState(false)
  const [collectionsMode, setCollectionsMode] = useState(false)
  const [following, setFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)

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

  // Cold profile load fires nine independent fetches off the address
  // change. On the Mini App webview's ~6-connection-per-host pool, three
  // immediately queue and the header data the user is staring at gets
  // stuck behind below-the-fold section fetches it has no reason to wait
  // for. Tier the fetches so the visible-first data goes first.
  //   - Tier 1 fires on mount: profile + mints (header + first section)
  //   - Tier 2 fires one rAF later: follow status, follow count,
  //     collected, artist collections (visible just below the header,
  //     but not the LCP candidates)
  //   - Tier 3 fires on idle: listings, payments, airdrops (deep below
  //     the fold and empty for most non-artist profiles)
  // Tier flags are intentionally non-resetting per address change — they
  // only need to gate the cold-load burst. Subsequent navigations between
  // profiles re-trigger the dependent useEffects regardless.
  const [tier2Ready, setTier2Ready] = useState(false)
  const [tier3Ready, setTier3Ready] = useState(false)
  useEffect(() => {
    // rAF defers past the first paint commit — once the browser has
    // pushed the Tier-1 paint to screen, the connection pool has free
    // slots for Tier 2's fetches.
    const rafId = requestAnimationFrame(() => setTier2Ready(true))
    // requestIdleCallback when available; setTimeout fallback for
    // Safari/iOS WebView which still lacks it. 100ms is conservative —
    // far enough out that Tier-2 fetches have a head start, close
    // enough that scroll-down users don't see "loading" placeholders
    // for non-empty sections.
    type Ric = (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number
    const w = window as Window & { requestIdleCallback?: Ric; cancelIdleCallback?: (h: number) => void }
    const ricHandle = w.requestIdleCallback
      ? w.requestIdleCallback(() => setTier3Ready(true), { timeout: 1000 })
      : window.setTimeout(() => setTier3Ready(true), 100)
    return () => {
      cancelAnimationFrame(rafId)
      if (w.cancelIdleCallback && typeof ricHandle === 'number') {
        w.cancelIdleCallback(ricHandle)
      } else {
        clearTimeout(ricHandle)
      }
    }
  }, [])

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

  useEscapeKey(useCallback(() => setActiveList(null), []), !!activeList)
  useBodyScrollLock(!!activeList)

  useEffect(() => {
    if (!isOwner) setEditing(false)
  }, [isOwner])

  // Tier 1 — profile + mints, fire on mount.
  useEffect(() => {
    fetch(`/api/profile/${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setProfile(d.profile ?? { address, updatedAt: 0 }))
      .catch(() => setProfile({ address, updatedAt: 0 }))
      .finally(() => setLoadingProfile(false))
  }, [address])

  useEffect(() => {
    fetch(`/api/timeline?creator=${address}&limit=50`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setMoments(Array.isArray(d.moments) ? d.moments : []))
      .catch(() => setMoments([]))
      .finally(() => setLoadingMoments(false))
  }, [address])

  // Tier 2 — visible-just-below-the-header data. Waits one frame past
  // Tier 1's paint so it doesn't compete for connection-pool slots
  // during the initial cold-load burst.
  useEffect(() => {
    if (!tier2Ready) return
    if (!connectedAddress || isOwner) { setFollowing(false); return }
    fetch(`/api/follow/${address}?follower=${connectedAddress}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setFollowing(d.following === true))
      .catch(() => {})
  }, [address, connectedAddress, isOwner, tier2Ready])

  useEffect(() => {
    if (!tier2Ready) return
    fetch(`/api/follow/${address}?count=1`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => {
        setFollowingCount(d.followingCount ?? 0)
        setFollowerCount(d.followerCount ?? 0)
      })
      .catch(() => { setFollowingCount(0); setFollowerCount(0) })
  }, [address, tier2Ready])

  useEffect(() => {
    if (!tier2Ready) return
    fetch(`/api/timeline?collector=${address}&limit=50`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setCollected(Array.isArray(d.moments) ? d.moments : []))
      .catch(() => setCollected([]))
      .finally(() => setLoadingCollected(false))
  }, [address, tier2Ready])

  useEffect(() => {
    if (!tier2Ready) return
    fetch(`/api/collections?artist=${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setArtistCollections(Array.isArray(d.collections) ? d.collections : []))
      .catch(() => setArtistCollections([]))
      .finally(() => setLoadingCollections(false))
  }, [address, tier2Ready])

  // Tier 3 — deep below the fold, almost always empty for non-artist
  // viewers. Deferred to requestIdleCallback (or a 100ms fallback) so
  // the main thread + connection pool stay clear of these until after
  // Tier 1 + 2 have settled.
  useEffect(() => {
    if (!tier3Ready) return
    fetch(`/api/listings?seller=${address}&limit=50`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setListings(Array.isArray(d.listings) ? d.listings.filter((l: Listing) => l.status === 'active') : []))
      .catch(() => setListings([]))
      .finally(() => setLoadingListings(false))
  }, [address, tier3Ready])

  useEffect(() => {
    if (!tier3Ready) return
    fetch(`/api/payments?artist=${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setPayments(Array.isArray(d.payments) ? d.payments : []))
      .catch(() => setPayments([]))
      .finally(() => setLoadingPayments(false))
  }, [address, tier3Ready])

  useEffect(() => {
    if (!tier3Ready) return
    fetch(`/api/airdrops?artist_address=${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setAirdrops(Array.isArray(d.airdrops) ? d.airdrops : []))
      .catch(() => setAirdrops([]))
      .finally(() => setLoadingAirdrops(false))
  }, [address, tier3Ready])

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
      const message = `Update Kismet profile\nAddress: ${address.toLowerCase()}\nNonce: ${nonce}`
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
      toast.success('Profile updated!', { id: 'profile' })
    } catch (err) {
      toastError('Update', err, { id: 'profile' })
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
      const message = `${action} ${address.toLowerCase()} on Kismet\nAddress: ${connectedAddress.toLowerCase()}\nNonce: ${nonce}`
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
      toast.success(wasFollowing ? 'Unfollowed!' : 'Followed!', { id: 'follow' })
      // Haptic only on follow (the positive engagement signal), not on
      // unfollow — buzz-on-removal would feel wrong.
      if (!wasFollowing && isInMiniApp) hapticNotifySuccess()
    } catch (err) {
      toastError(following ? 'Unfollow' : 'Follow', err, { id: 'follow' })
    } finally {
      setFollowLoading(false)
    }
  }

  // ─── section content map ──────────────────────────────────────────────────

  // Skeleton mirrors the active layout — feed mode shows a 2/3-col grid
  // of square placeholders, grid mode shows the same swiper density so
  // the loading state doesn't visually flip when content arrives.
  const skeleton = (n: number) => viewMode === 'grid' ? (
    <CardSwiper>
      {Array.from({ length: n }).map((_, i) => (
        <CardSwiperItem key={i}>
          <div className="aspect-square bg-surface animate-pulse border border-raised" />
        </CardSwiperItem>
      ))}
    </CardSwiper>
  ) : (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="aspect-square bg-surface animate-pulse border border-raised" />
      ))}
    </div>
  )

  const sectionLabel: Record<SectionId, string> = {
    mints: 'Mints',
    collected: 'Collected',
    listings: 'Listings',
    payments: 'Sales',
    airdrops: 'Airdrops',
    curate: 'Curate',
  }
  const sectionCount: Record<SectionId, number | null> = {
    mints: loadingMoments ? null : moments.length,
    collected: loadingCollected ? null : collected.length,
    listings: loadingListings ? null : listings.length,
    payments: loadingPayments ? null : payments.length,
    airdrops: loadingAirdrops ? null : airdrops.length,
    // Curate count rendered by the panel itself (it knows the live featured set).
    curate: null,
  }
  // Grid-section layouts are mirrored across the three card-based
  // sections (mints, collected, listings). Wrap each item in the active
  // container — CardSwiper for grid view, the existing 2/3-col grid
  // otherwise — and apply compact + showCreator to the card body in
  // grid mode so the chips fit inside ~180px wide tiles.
  const isGrid = viewMode === 'grid'
  function renderCardCollection<T>(items: T[], renderCard: (item: T) => React.ReactNode, getItemKey: (item: T) => string) {
    if (isGrid) {
      return (
        <CardSwiper>
          {items.map((it) => (
            <CardSwiperItem key={getItemKey(it)}>{renderCard(it)}</CardSwiperItem>
          ))}
        </CardSwiper>
      )
    }
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        {items.map((it, i) => {
          // Mobile lazy-mount: items beyond EAGER_MOUNT_COUNT defer mount
          // until the placeholder enters the viewport. Grid-view (above)
          // uses CardSwiper which only renders the visible horizontal
          // window, so its own mount cost doesn't compound — only the
          // feed-view 2/3-col layout needs MaybeLazy.
          return (
            <MaybeLazy key={getItemKey(it)} index={i} lazy={isMobile}>
              {() => renderCard(it)}
            </MaybeLazy>
          )
        })}
      </div>
    )
  }

  const sectionContent: Record<SectionId, React.ReactNode> = {
    mints: collectionsMode ? (
      loadingCollections ? skeleton(6) : artistCollections.length === 0 ? (
        <p className="text-muted font-mono text-xs">no collections yet</p>
      ) : renderCardCollection(
        artistCollections,
        (c) => {
          const collectionName = c.metadata?.name || c.name
          return (
            <div className="flex flex-col bg-[#161616] border border-line overflow-hidden">
              <Link href={`/collection/${c.contractAddress}`} className="relative aspect-square bg-surface block overflow-hidden group/img">
                <CollectionPreviewImage src={c.metadata?.image} alt={collectionName} thumbhash={c.metadata?.kismet_thumbhash} />
              </Link>
              <div className={`${isGrid ? 'px-2 pt-2 pb-1 gap-0.5' : 'px-3 pt-3 pb-2 gap-0.5'} flex flex-col`}>
                <h3 className={`${isGrid ? 'text-[11px]' : 'text-sm'} text-ink font-mono truncate`}>{collectionName}</h3>
                <span className={`${isGrid ? 'text-[9px]' : 'text-[10px]'} font-mono text-muted truncate`}>{shortAddress(c.contractAddress)}</span>
              </div>
              <div className={`${isGrid ? 'px-2 pb-2 gap-1' : 'px-3 pb-3 gap-1.5'} flex flex-col mt-auto`}>
                <Link
                  href={`/collection/${c.contractAddress}`}
                  className={`w-full text-center font-mono border border-line text-dim hover:border-muted hover:text-ink transition-colors ${isGrid ? 'py-1 text-[10px]' : 'py-1.5 text-xs'}`}
                >
                  view
                </Link>
                <Link
                  href={`/mint?collection=${c.contractAddress}&name=${encodeURIComponent(collectionName)}`}
                  className={`w-full text-center font-mono border border-accent/40 text-accent hover:border-accent hover:bg-accent/10 transition-colors ${isGrid ? 'py-1 text-[10px]' : 'py-1.5 text-xs'}`}
                >
                  mint all
                </Link>
              </div>
            </div>
          )
        },
        (c) => c.contractAddress,
      )
    ) : (
      loadingMoments ? skeleton(6) : moments.length === 0
        ? <p className="text-muted font-mono text-xs">no mints yet</p>
        : renderCardCollection(
            moments,
            (m) => <MomentCard moment={m} hidePriceSupply compact={isGrid} showCreator={isGrid} />,
            (m) => m.id ?? `${m.address}-${m.token_id}`,
          )
    ),
    collected: loadingCollected ? skeleton(6) : collected.length === 0
      ? <p className="text-muted font-mono text-xs">none collected yet</p>
      : renderCardCollection(
          collected,
          (m) => <MomentCard moment={m} hidePriceSupply compact={isGrid} showCreator={isGrid} />,
          (m) => m.id ?? `${m.address}-${m.token_id}`,
        ),
    listings: loadingListings ? skeleton(3) : listings.length === 0
      ? (
        <p className="text-muted font-mono text-xs">
          collect a moment on discover then{' '}
          <Link href={`/profile/${address}`} className="accent-grad hover:opacity-80 transition-opacity">list</Link>
          {' '}it here
        </p>
      )
      : renderCardCollection(
          listings,
          (l) => (
            <MarketCard
              listing={l}
              onRemove={() => setListings((prev) => prev.filter((x) => x.id !== l.id))}
              compact={isGrid}
              showCreator={isGrid}
            />
          ),
          (l) => l.id,
        ),
    payments: loadingPayments ? (
      <div className="flex flex-col gap-1">
        {[0,1,2,3].map((i) => <div key={i} className="h-10 bg-surface animate-pulse border border-raised" />)}
      </div>
    ) : payments.length === 0 ? (
      <p className="text-muted font-mono text-xs">no sales yet</p>
    ) : (
      <div className="flex flex-col divide-y divide-raised">
        {payments.map((p) => (
          <div key={p.id} className="flex items-center justify-between py-2.5 gap-4">
            <span className="text-xs font-mono text-muted">
              {p.buyer.username || shortAddress(p.buyer.address)}
            </span>
            <span className="text-xs font-mono accent-grad flex-shrink-0">
              {formatPrice(p.amount, p.currency ?? 'eth')}
            </span>
            <a
              href={`https://basescan.org/tx/${p.hash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] font-mono text-[#444] hover:text-dim transition-colors flex-shrink-0"
            >
              {p.hash.slice(0, 8)}…
            </a>
          </div>
        ))}
      </div>
    ),
    airdrops: loadingAirdrops ? (
      <div className="flex flex-col gap-1">
        {[0,1,2,3].map((i) => <div key={i} className="h-10 bg-surface animate-pulse border border-raised" />)}
      </div>
    ) : airdrops.length === 0 ? (
      <p className="text-muted font-mono text-xs">no airdrops sent yet</p>
    ) : (
      <div className="flex flex-col divide-y divide-raised">
        {airdrops.map((a, i) => (
          <div key={`${a.collectionAddress}:${a.tokenId}:${a.recipient.address}:${i}`} className="flex items-center justify-between py-2.5 gap-4">
            <Link
              href={`/profile/${a.recipient.address}`}
              className="text-xs font-mono text-muted hover:text-dim transition-colors truncate"
            >
              {a.recipient.username ? `@${a.recipient.username}` : shortAddress(a.recipient.address)}
            </Link>
            <Link
              href={`/moment/${a.collectionAddress}/${a.tokenId}`}
              className="text-xs font-mono text-[#444] hover:text-dim transition-colors flex-shrink-0"
            >
              token #{a.tokenId}
            </Link>
            <span className="text-xs font-mono accent-grad flex-shrink-0">
              ×{a.amount.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    ),
    curate: <CuratePanel />,
  }

  // ─── permissions banner gate ─────────────────────────────────────────────
  // Owner-only entry point to the /permissions dashboard. We pass an
  // empty list for non-owners so the wagmi multicall doesn't fire —
  // visitors don't need (and shouldn't see) someone else's permission
  // state.
  const collectionAddressesForPerms = isOwner
    ? artistCollections.map((c) => c.contractAddress)
    : []
  const { missingCount: ownCollectionsMissingAdmin } = useCollectionsPermissions(
    collectionAddressesForPerms,
  )

  // ─── render ───────────────────────────────────────────────────────────────

  const displayName =
    profile?.displayName || profile?.username || profile?.ensName || shortAddress(address)

  return (
    <div className="max-w-4xl mx-auto px-4 py-12 flex flex-col gap-12">
      {/* Owner-only permissions banner. Hidden when missingCount is 0
          to keep healthy profiles uncluttered. */}
      {isOwner && ownCollectionsMissingAdmin > 0 && (
        <Link
          href="/permissions"
          role="alert"
          className="border border-accent/40 bg-accent/5 hover:bg-accent/10 p-3 sm:p-4 flex items-center gap-3 transition-colors"
        >
          <ShieldAlert size={14} className="text-accent flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-mono text-ink">
              {ownCollectionsMissingAdmin === 1
                ? '1 of your collections needs authorize'
                : `${ownCollectionsMissingAdmin} of your collections need authorize`}
            </p>
            <p className="text-[11px] font-mono text-dim mt-0.5">
              Tap to review and grant Kismet ADMIN — one onchain transaction per collection.
            </p>
          </div>
          <span className="text-accent font-mono text-xs flex-shrink-0" aria-hidden>
            →
          </span>
        </Link>
      )}

      {/* Profile header */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-6">
          <div className="relative">
            {!loadingProfile ? (
              <ProfileAvatar address={address} avatarUrl={profile?.avatarUrl} size={80} editable={isOwner} onEdit={openEdit} />
            ) : (
              <div className="w-20 h-20 rounded-full bg-raised animate-pulse" />
            )}
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 flex-1 min-w-0">
                {loadingProfile ? (
                  <div className="h-4 w-28 bg-raised animate-pulse rounded" />
                ) : (
                  <>
                    <p className="text-ink font-mono text-sm truncate">{displayName}</p>
                    {isOwner && (
                      <button onClick={openEdit} className="flex-shrink-0 p-1 text-muted hover:text-dim transition-colors" title="Edit profile">
                        <Pencil size={12} />
                      </button>
                    )}
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(`${window.location.origin}/profile/${address}`).catch(() => {})
                        setLinkCopied(true)
                        setTimeout(() => setLinkCopied(false), 1500)
                      }}
                      className="flex-shrink-0 p-1 text-[#444] hover:text-dim transition-colors"
                      title="Copy profile link"
                    >
                      {linkCopied ? <Check size={12} className="text-[#6ee7b7]" /> : <Copy size={12} />}
                    </button>
                  </>
                )}
              </div>
              {!isOwner && connectedAddress && !loadingProfile && (
                <button
                  onClick={handleFollow}
                  disabled={followLoading}
                  className={`flex-shrink-0 text-xs font-mono px-2.5 py-1 border transition-colors disabled:opacity-40 ${
                    following
                      ? 'border-muted text-dim hover:border-red-900/50 hover:text-red-400'
                      : 'border-line text-muted hover:border-muted hover:text-ink'
                  }`}
                >
                  {followLoading ? '…' : following ? 'following' : 'follow'}
                </button>
              )}
              {/* Global view-mode toggle — affects every grid section
                  below (mints, collected, listings, mints>collections). */}
              <ViewModeToggle mode={viewMode} onChange={setViewMode} />
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(address).catch(() => {})
                  setAddrCopied(true)
                  setTimeout(() => setAddrCopied(false), 800)
                }}
                className={`font-mono text-xs text-left break-all transition-colors ${addrCopied ? 'text-accent' : 'text-muted hover:text-dim'}`}
                title="Copy address"
              >
                {address}
              </button>
            </div>
            <div className="flex items-center gap-3 mt-0.5">
              <button
                onClick={() => openList('following')}
                className={`text-xs font-mono transition-colors ${activeList === 'following' ? 'text-ink' : 'text-muted hover:text-dim'}`}
              >
                <span className="text-ink">{followingCount ?? '—'}</span>{' '}following
              </button>
              <span className="text-faint text-xs">·</span>
              <button
                onClick={() => openList('followers')}
                className={`text-xs font-mono transition-colors ${activeList === 'followers' ? 'text-ink' : 'text-muted hover:text-dim'}`}
              >
                <span className="text-ink">{followerCount ?? '—'}</span>{' '}followers
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
          <div className="w-full max-w-sm bg-[#161616] border border-line">
            <div className="flex items-center justify-between px-5 py-4 border-b border-line">
              <p className="text-xs font-mono text-dim uppercase tracking-wider">
                {activeList === 'following'
                  ? `Following${followingCount !== null ? ` (${followingCount})` : ''}`
                  : `Followers${followerCount !== null ? ` (${followerCount})` : ''}`}
              </p>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => { setSearchOpen((v) => !v); setSearchQuery('') }}
                  className={`p-1 transition-colors ${searchOpen ? 'text-ink' : 'text-muted hover:text-dim'}`}
                  title="search"
                >
                  <Search size={14} />
                </button>
                <button
                  onClick={() => setActiveList(null)}
                  className="p-1 text-muted hover:text-dim transition-colors"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            {searchOpen && (
              <div className="px-5 py-2 border-b border-line">
                <input
                  autoFocus
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="search…"
                  className="w-full bg-transparent text-xs font-mono text-ink placeholder-faint focus:outline-none"
                />
              </div>
            )}
            <div className="overflow-y-auto max-h-[280px]">
              {loadingList ? (
                <div className="flex flex-col">
                  {[0, 1, 2, 3, 4].map((i) => (
                    <div key={i} className="flex items-center gap-3 px-5 py-3 border-b border-raised">
                      <div className="w-7 h-7 rounded-full bg-raised animate-pulse flex-shrink-0" />
                      <div className="h-3 w-28 bg-raised animate-pulse rounded" />
                    </div>
                  ))}
                </div>
              ) : listAddresses.length === 0 ? (
                <p className="px-5 py-6 text-xs font-mono text-muted">no {activeList} yet</p>
              ) : (() => {
                const q = searchQuery.toLowerCase().trim()
                const filtered = q
                  ? listAddresses.filter((a) =>
                      a.toLowerCase().includes(q) ||
                      (nameMapRef.current[a] ?? '').toLowerCase().includes(q)
                    )
                  : listAddresses
                return filtered.length === 0
                  ? <p className="px-5 py-6 text-xs font-mono text-muted">no results</p>
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
        <div className="border border-line p-4 flex flex-col gap-4">
          <p className="text-xs font-mono text-dim uppercase tracking-wider">Edit Profile</p>
          {/* Mini-App-only wallet picker. Renders nothing on web or when
              the user has < 2 verified FC wallets — sized to zero so
              the layout below stays stable when it's absent. */}
          <WalletsPanel />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-mono text-muted uppercase tracking-wider">Display Name</label>
            <input
              type="text"
              value={usernameInput}
              onChange={(e) => setUsernameInput(e.target.value)}
              placeholder={shortAddress(address)}
              maxLength={30}
              className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-mono text-muted uppercase tracking-wider">Avatar URL</label>
            <input
              type="url"
              value={avatarInput}
              onChange={(e) => setAvatarInput(e.target.value)}
              placeholder="https://… (leave blank for gradient avatar)"
              className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
            />
          </div>
          <div className="flex gap-3">
            <button onClick={saveProfile} disabled={saving} className="px-4 py-2.5 text-xs font-mono btn-accent">
              {saving ? 'saving…' : 'save'}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="px-4 py-2.5 text-xs font-mono border border-line text-muted hover:border-dim hover:text-dim transition-colors disabled:opacity-40"
            >
              cancel
            </button>
          </div>
        </div>
      )}


      {/* Draggable / collapsible sections. The optional `curate` section is
          appended last for the curator on their own profile and is not
          drag-reorderable — it stays pinned to the bottom. */}
      <div className="flex flex-col">
        {(showCurate ? [...sectionOrder, 'curate' as const] : sectionOrder).map((section, idx) => {
          const isCollapsed = sectionCollapsed[section] ?? false
          const count = sectionCount[section]
          const sectionDraggable = section !== 'curate' && allowDrag
          return (
            <div
              key={section}
              onDragOver={sectionDraggable ? (e) => onDragOver(e, idx) : undefined}
              className={`border-t border-line transition-opacity duration-150 ${draggingSection === section ? 'opacity-40' : 'opacity-100'}`}
            >
              <div
                draggable={sectionDraggable}
                onDragStart={sectionDraggable ? () => onDragStart(idx) : undefined}
                onDragEnd={sectionDraggable ? onDragEnd : undefined}
                onClick={() => toggleCollapsed(section)}
                className={`flex items-center gap-2 py-4 select-none ${sectionDraggable ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
              >
                <ChevronRight
                  size={12}
                  className={`text-muted transition-transform duration-200 ${isCollapsed ? '' : 'rotate-90'}`}
                />
                <h2 className="text-xs font-mono text-dim uppercase tracking-wider">
                  {sectionLabel[section]}{count !== null ? ` (${count})` : ''}
                </h2>
                {section === 'mints' && !isCollapsed && (
                  <button
                    onClick={(e) => { e.stopPropagation(); setCollectionsMode((v) => !v) }}
                    className={`text-xs font-mono px-2.5 py-1 border transition-colors ${
                      collectionsMode
                        ? 'border-muted text-dim hover:border-red-900/50 hover:text-red-400'
                        : 'border-line text-muted hover:border-muted hover:text-ink'
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
