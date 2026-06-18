'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useAccount, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Pencil, ChevronRight, Copy, Check, X, Search, ShieldAlert, Pin } from 'lucide-react'
import { ProfileAvatar } from './ProfileAvatar'
import { ProfileStats } from './ProfileStats'
import { PaletteRing } from './PaletteRing'
import { ProfileThemeBackdrop } from './ProfileThemeBackdrop'
import { CustomizePanel } from './CustomizePanel'
import { themeCssVars } from '@/lib/themeStyle'
import type { ProfileTheme } from '@/lib/profileTheme'
import { MomentCard } from './MomentCard'
import { MarketCard } from './MarketCard'
import { CuratePanel } from './CuratePanel'
import { useAdmin } from '@/contexts/AdminContext'
import type { Listing } from '@/lib/listings'
import type { Moment } from '@/lib/inprocess'
import type { AirdropRecord } from '@/lib/airdrops'
import { shortAddress, formatPrice } from '@/lib/inprocess'
import { MomentImage } from './MomentImage'
import { useCollectionsPermissions } from '@/hooks/useCollectionsPermissions'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useBodyScrollLock } from '@/hooks/useBodyScrollLock'
import { useLongPressDrag } from '@/hooks/useLongPressDrag'
import { useInViewDwell } from '@/hooks/useInViewDwell'
import { toastError } from '@/lib/toast'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import { MaybeLazy } from './LazyMount'
import { WalletsPanel } from './WalletsPanel'

// Agent Collect setup — owner-only, smart-wallet-gated. Pulls in the Base
// Account spend-permission utils, so it's code-split via next/dynamic (ssr:false)
// to keep it off the profile route's initial JS; it loads on the client only when
// an owner views their own profile and self-gates via useAgent.
const AgentCollectPanel = dynamic(
  () => import('./AgentCollectPanel').then((m) => m.AgentCollectPanel),
  { ssr: false },
)

// Sibling entry to the per-action Base MCP skill. Code-split + self-gating like
// the panel; both render only for a Base Account owner on their own profile.
const AgentSkillCard = dynamic(
  () => import('./AgentSkillCard').then((m) => m.AgentSkillCard),
  { ssr: false },
)

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
function CollectionPreviewImage({ src, alt, thumbhash, priority }: { src?: string; alt: string; thumbhash?: string; priority?: boolean }) {
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
      // Same compact-density sizes as the compact MomentCard/CollectionCard
      // since this card sits in the same 2/3/4/6 grid on profile.
      sizes="(max-width: 640px) 50vw, (max-width: 768px) 33vw, (max-width: 1024px) 25vw, 16vw"
      onAllError={() => setFailed(true)}
      preferProxy
      thumbhash={thumbhash}
      priority={priority}
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

// ─── pinned showcase ─────────────────────────────────────────────────────────

type PinCategory = 'mints' | 'collected' | 'listings'
type PinSets = Record<PinCategory, string[]>
const EMPTY_PINS: PinSets = { mints: [], collected: [], listings: [] }

// Reduce `items` to the pinned ones, ordered by pin recency (`order` is the
// newest-pinned-first ref list from /api/profile/[address]/pins). Items absent
// from `order` — a pin buried past the profile's 50-item fetch window, or a
// listing that's since been delisted — simply fall away, which is what lets
// the visitor's curated view degrade gracefully to the full profile.
function orderByPins<T>(items: T[], keyOf: (t: T) => string, order: string[]): T[] {
  if (order.length === 0) return []
  const rank = new Map(order.map((k, i) => [k, i] as const))
  return items
    .filter((it) => rank.has(keyOf(it)))
    .sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0))
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

// ─── provenance chip ─────────────────────────────────────────────────────────

// Small credit linking a themed profile back to the moment its palette came
// from — attribution plus a discovery path to the source. Renders nothing if
// the stored ref is malformed; the name falls back when older themes lack it.
function ProvenanceChip({ theme }: { theme: ProfileTheme }) {
  const i = theme.momentRef.indexOf(':')
  const coll = i < 0 ? '' : theme.momentRef.slice(0, i)
  const tid = i < 0 ? '' : theme.momentRef.slice(i + 1)
  if (!coll || !tid) return null
  return (
    <Link
      href={`/moment/${coll}/${tid}`}
      className="self-start inline-flex items-center gap-1.5 max-w-full text-[11px] font-mono text-muted hover:text-dim transition-colors"
      title={`Theme derived from ${theme.momentName ?? 'this moment'}`}
    >
      <span aria-hidden className="text-accent">✦</span>
      <span className="truncate">themed from {theme.momentName ?? 'this moment'}</span>
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
  /**
   * Content-derived theme, read SSR by the page wrapper. When present, its
   * palette re-skins the accent surfaces (scoped `--accent`) and paints the
   * avatar ring. Null/undefined → the brand default stands. Applies in every
   * view (owner dashboard, owner public-view preview, and visitors) — it's how
   * the profile looks; `asVisitor` independently controls the sections.
   */
  theme?: ProfileTheme | null
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

export function ProfileView({ address, isMobile = false, theme: initialTheme }: ProfileViewProps) {
  const { address: connectedAddress } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signMessageAsync } = useSignMessage()
  const { isInMiniApp, identity: fcIdentity } = useFarcaster()
  const { isCurator } = useAdmin()

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

  const [profile, setProfile] = useState<Profile | null>(null)
  const [moments, setMoments] = useState<Moment[]>([])
  const [collected, setCollected] = useState<Moment[]>([])
  const [listings, setListings] = useState<Listing[]>([])
  const [payments, setPayments] = useState<Payment[]>([])
  const [airdrops, setAirdrops] = useState<AirdropRecord[]>([])
  const [artistCollections, setArtistCollections] = useState<ArtistCollection[]>([])
  // Pass-validity snapshot for the profile owner, used to overlay a
  // "Valid Pass" badge on collected Pass NFTs. One fetch per profile
  // load — the response is small and tolerates the small UX-lag of
  // briefly showing un-badged cards before this arrives. Re-fetched
  // on address change so navigating between profiles resets the badge.
  const [passBadge, setPassBadge] = useState<{ passCollection: string; hasValidity: boolean } | null>(null)
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
  // Owner-only "public view" preview: render the profile exactly as a visitor
  // sees it (no pushpins / edit / curate / owner-only sections) so the owner
  // can check their curation, then toggle back out.
  const [previewPublic, setPreviewPublic] = useState(false)
  // Theme as state (seeded from the SSR prop) so the Customize panel applies a
  // new theme live — the re-skin, avatar ring, and backdrop update with no reload.
  const [theme, setTheme] = useState<ProfileTheme | null>(initialTheme ?? null)
  const [customizing, setCustomizing] = useState(false)
  // ProfileView is reused across /profile/[address] navigations (hence the
  // address-keyed resets below), so re-seed the theme from the new SSR value and
  // close the panel when the address changes. Done during render — React's
  // adjust-state-on-prop-change pattern — so the new profile never paints the
  // previous theme's backdrop/ring/accent for a frame. An optimistic setTheme
  // survives because `address` hasn't changed.
  const [seededAddr, setSeededAddr] = useState(address)
  if (address !== seededAddr) {
    setSeededAddr(address)
    setTheme(initialTheme ?? null)
    setCustomizing(false)
  }
  // One in-view signal for the whole themed header — drives both the backdrop's
  // animation pause and the avatar bloom glow, so they stop together off-screen
  // (one observer, not two).
  const headerRef = useRef<HTMLDivElement>(null)
  const headerInView = useInViewDwell(headerRef, { rootMargin: '0px' })
  const closeCustomize = useCallback(() => setCustomizing(false), [])

  // Pinned showcase refs per category. Drives the visitor's curated view and
  // the owner's per-card pin toggle state.
  const [pins, setPins] = useState<PinSets>(EMPTY_PINS)
  // Set once the owner toggles a pin, so the initial GET (which runs on mount
  // and may still be in flight) can't overwrite an optimistic toggle.
  const pinsTouched = useRef(false)

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
  const sectionContainerRef = useRef<HTMLDivElement>(null)

  // Tier the cold-load fetches so the connection pool isn't saturated
  // by below-the-fold sections. T1 fires on mount, T2 one rAF later,
  // T3 on idle. Effects depend on the derived booleans, not `tier`
  // itself, so a 2→3 transition doesn't re-fire T2 fetches.
  const [tier, setTier] = useState<1 | 2 | 3>(1)
  const tier2 = tier >= 2
  const tier3 = tier >= 3
  useEffect(() => {
    const rafId = requestAnimationFrame(() => setTier((t) => (t < 2 ? 2 : t)))
    type Ric = (cb: IdleRequestCallback, opts?: IdleRequestOptions) => number
    const w = window as Window & { requestIdleCallback?: Ric; cancelIdleCallback?: (h: number) => void }
    const ricHandle = w.requestIdleCallback
      ? w.requestIdleCallback(() => setTier(3), { timeout: 1000 })
      : window.setTimeout(() => setTier(3), 100)
    return () => {
      cancelAnimationFrame(rafId)
      if (w.cancelIdleCallback) w.cancelIdleCallback(ricHandle as number)
      else clearTimeout(ricHandle)
    }
  }, [])

  useEffect(() => {
    const config = loadSectionsConfig()
    setSectionOrder(config.order)
    setSectionCollapsed(config.collapsed)
  }, [])

  useEffect(() => {
    setActiveList(null)
    setListAddresses([])
    setPreviewPublic(false)
  }, [address])

  useEscapeKey(useCallback(() => setActiveList(null), []), !!activeList)
  useBodyScrollLock(!!activeList)

  useEffect(() => {
    if (!isOwner) setEditing(false)
  }, [isOwner])

  // Tier 1 — header + first section.
  useEffect(() => {
    fetch(`/api/profile/${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setProfile(d.profile ?? { address, updatedAt: 0 }))
      .catch(() => setProfile({ address, updatedAt: 0 }))
      .finally(() => setLoadingProfile(false))
  }, [address])

  // Pass-validity snapshot — drives the "Valid Pass" badge on collected
  // Pass NFTs. Silently fails when the gate isn't configured (returns
  // passCollection=null, validBalance=0); in that case the badge is
  // never rendered and the fetch is just a cheap no-op.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/pass-validity?address=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { passCollection: string | null; validBalance: number } | null) => {
        if (cancelled || !d || !d.passCollection) return
        setPassBadge({ passCollection: d.passCollection, hasValidity: d.validBalance > 0 })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [address])

  useEffect(() => {
    fetch(`/api/timeline?creator=${address}&limit=50`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setMoments(Array.isArray(d.moments) ? d.moments : []))
      .catch(() => setMoments([]))
      .finally(() => setLoadingMoments(false))
  }, [address])

  // Pinned showcase refs — Tier 1 because the render mode (pinned-only vs
  // full) depends on it. Tiny payload; degrades to no-pins on any failure.
  useEffect(() => {
    pinsTouched.current = false
    setPins(EMPTY_PINS)
    fetch(`/api/profile/${address}/pins`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      // Normalize per-category so a partial/garbled payload can't leave a
      // category undefined (pins[cat].includes / .length would then throw).
      // Skip if the owner already toggled — don't clobber an optimistic pin.
      .then((d) => { if (!pinsTouched.current) setPins({
        mints: Array.isArray(d?.pins?.mints) ? d.pins.mints : [],
        collected: Array.isArray(d?.pins?.collected) ? d.pins.collected : [],
        listings: Array.isArray(d?.pins?.listings) ? d.pins.listings : [],
      }) })
      .catch(() => { if (!pinsTouched.current) setPins(EMPTY_PINS) })
  }, [address])

  // Tier 2 — visible just below the header.
  useEffect(() => {
    if (!tier2) return
    if (!connectedAddress || isOwner) { setFollowing(false); return }
    fetch(`/api/follow/${address}?follower=${connectedAddress}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setFollowing(d.following === true))
      .catch(() => {})
  }, [address, connectedAddress, isOwner, tier2])

  useEffect(() => {
    if (!tier2) return
    fetch(`/api/follow/${address}?count=1`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => {
        setFollowingCount(d.followingCount ?? 0)
        setFollowerCount(d.followerCount ?? 0)
      })
      .catch(() => { setFollowingCount(0); setFollowerCount(0) })
  }, [address, tier2])

  useEffect(() => {
    if (!tier2) return
    fetch(`/api/timeline?collector=${address}&limit=50`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setCollected(Array.isArray(d.moments) ? d.moments : []))
      .catch(() => setCollected([]))
      .finally(() => setLoadingCollected(false))
  }, [address, tier2])

  useEffect(() => {
    if (!tier2) return
    fetch(`/api/collections?artist=${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setArtistCollections(Array.isArray(d.collections) ? d.collections : []))
      .catch(() => setArtistCollections([]))
      .finally(() => setLoadingCollections(false))
  }, [address, tier2])

  // Tier 3 — below the fold, usually empty for non-artist profiles.
  useEffect(() => {
    if (!tier3) return
    fetch(`/api/listings?seller=${address}&limit=50`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setListings(Array.isArray(d.listings) ? d.listings.filter((l: Listing) => l.status === 'active') : []))
      .catch(() => setListings([]))
      .finally(() => setLoadingListings(false))
  }, [address, tier3])

  // Sales + Airdrops are owner-dashboard-only sections — a visitor's curated
  // view never renders them, so skip the fetches for non-owners. Mark them
  // resolved (loading=false) on the visitor path so the flags don't stay true
  // for the component's life (which would leave their section counts null).
  useEffect(() => {
    if (!isOwner) { setLoadingPayments(false); return }
    if (!tier3) return
    fetch(`/api/payments?artist=${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setPayments(Array.isArray(d.payments) ? d.payments : []))
      .catch(() => setPayments([]))
      .finally(() => setLoadingPayments(false))
  }, [address, tier3, isOwner])

  useEffect(() => {
    if (!isOwner) { setLoadingAirdrops(false); return }
    if (!tier3) return
    fetch(`/api/airdrops?artist_address=${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setAirdrops(Array.isArray(d.airdrops) ? d.airdrops : []))
      .catch(() => setAirdrops([]))
      .finally(() => setLoadingAirdrops(false))
  }, [address, tier3, isOwner])

  // ─── section drag / collapse ──────────────────────────────────────────────

  function persistSections(order: SectionId[], collapsed: Partial<Record<SectionId, boolean>>) {
    try { localStorage.setItem(SECTIONS_KEY, JSON.stringify({ order, collapsed })) } catch {}
  }

  function toggleCollapsed(section: SectionId) {
    const next = { ...sectionCollapsed, [section]: !sectionCollapsed[section] }
    setSectionCollapsed(next)
    persistSections(sectionOrder, next)
  }

  // Section drag-to-reorder — same long-press gesture model the discover
  // tab bar and notification filter row use. `curate` is selector-
  // excluded so it can't appear as a swap target (and won't be in
  // `sectionOrder` so it can't appear as a drag source either).
  const { draggingId: draggingSection, dragOffset: sectionDragOffsetY, bindItem: bindSection } =
    useLongPressDrag<SectionId>({
      axis: 'y',
      order: sectionOrder,
      onReorder: (next) => {
        setSectionOrder(next)
        persistSections(next, sectionCollapsed)
      },
      onTap: toggleCollapsed,
      containerRef: sectionContainerRef,
      itemSelector: '[data-section]:not([data-section="curate"])',
    })

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

  // ─── pinned showcase ──────────────────────────────────────────────────────

  async function togglePin(category: PinCategory, collectionAddress: string, tokenId: string) {
    // No wallet-connection gate: pinning authenticates via the session cookie
    // / FC JWT (authorizeOwner), not a wallet signature — and an FC Mini App
    // owner is `isOwner` (so sees the toggle) before wagmi attaches an address.
    // A missing session surfaces as the server's 401 → toast below.
    pinsTouched.current = true // from here, optimistic state wins over the GET
    const key = `${collectionAddress.toLowerCase()}:${tokenId}`
    const wasPinned = pins[category].includes(key)
    // Functional add/remove scoped to this key, so rapid taps across cards
    // can't clobber each other's optimistic state. New pins go to the front
    // to match the server's newest-pinned-first ordering.
    const apply = (pinned: boolean) =>
      setPins((p) => {
        const without = p[category].filter((k) => k !== key)
        return { ...p, [category]: pinned ? [key, ...without] : without }
      })
    apply(!wasPinned)
    try {
      const res = await fetch(`/api/profile/${address}/pins`, {
        method: wasPinned ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, collectionAddress, tokenId }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Failed')
      }
    } catch (err) {
      apply(wasPinned) // revert just this key
      toastError(wasPinned ? 'Unpin' : 'Pin', err)
    }
  }

  // Render-as-a-visitor flag. True for a real visitor OR when the owner has
  // toggled the public-view preview. Owner-only CHROME (pushpins, edit, curate,
  // the owner section branch) gates on this so the preview is faithful; the
  // DATA fetches still key off the real `isOwner`.
  const asVisitor = !isOwner || previewPublic

  // Owner-only pin props for a card; {} for visitors so MomentCard/MarketCard
  // render no toggle and keep their memoized identity in every non-owner feed.
  // Membership is a plain .includes over the capped (≤4) ref array — no Set.
  function ownerPinProps(
    category: PinCategory,
    collectionAddress: string,
    tokenId: string,
  ): { pinned?: boolean; onTogglePin?: () => void } {
    if (asVisitor) return {}
    return {
      pinned: pins[category].includes(`${collectionAddress.toLowerCase()}:${tokenId}`),
      onTogglePin: () => togglePin(category, collectionAddress, tokenId),
    }
  }

  // Pinned-showcase derivations. A visitor (`!isOwner`) sees ONLY the owner's
  // pinned moments — filtered from the already-loaded arrays, which keeps the
  // render self-validating (a pin can only show content the owner truly
  // minted/collected/listed). Owners see their full dashboard so they can
  // curate — unless they toggle the public-view preview (`asVisitor`), which
  // renders the visitor path. With no pins, a visitor's view has no sections at
  // all — just the profile header (identity only). orderByPins runs only on the
  // visitor path; off it the full arrays pass straight through.
  const pinnedView = asVisitor
  const ownerHasNoPins = isOwner && pins.mints.length + pins.collected.length + pins.listings.length === 0

  const displayMoments = pinnedView ? orderByPins(moments, (m) => `${m.address.toLowerCase()}:${m.token_id}`, pins.mints) : moments
  const displayCollected = pinnedView ? orderByPins(collected, (m) => `${m.address.toLowerCase()}:${m.token_id}`, pins.collected) : collected
  const displayListings = pinnedView ? orderByPins(listings, (l) => `${l.collectionAddress.toLowerCase()}:${l.tokenId}`, pins.listings) : listings
  const pinSectionLoading: Record<PinCategory, boolean> = {
    mints: loadingMoments,
    collected: loadingCollected,
    listings: loadingListings,
  }

  // ─── section content map ──────────────────────────────────────────────────

  // Profile uses the compact card density everywhere — keeps each section
  // glance-able even when a user has hundreds of mints/collected/listings.
  // Grid is 2/3/4/6 across breakpoints (same density PaginatedGrid uses
  // for its grid view); max-h caps the section at roughly 3 rows tall
  // and the remainder scrolls inside the box. Skeleton uses the same
  // shell so the loading state doesn't visually flip when content arrives.
  const GRID_CLASSES = 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3'
  // Curated showcase layout (visitor view / owner "public view"), mirroring
  // the featured tab's CollectionRow: a horizontal snap-swipe of fixed-width
  // cards on phones, and a four-up row on web (lg+). A section holds at most
  // MAX_PINS_PER_CATEGORY (4) cards — keep the lg column count and the skeleton
  // cap below in sync with that cap (and the hint copy). The dense dashboard
  // grid (GRID_CLASSES) still drives the owner's full mint/collected lists.
  const SHOWCASE_ROW_CLASSES =
    'flex gap-3 overflow-x-auto snap-x snap-mandatory [-webkit-overflow-scrolling:touch] lg:grid lg:grid-cols-4 lg:overflow-visible'
  // grid grid-rows-1 makes the card fill the cell so every box in a section
  // row is the same height regardless of content (price loaded, owned, text
  // moment): the row stretches items to the tallest, this stretches the card
  // to fill that height in turn.
  const SHOWCASE_ITEM_CLASSES = 'grid grid-rows-1 w-64 flex-shrink-0 snap-start lg:w-auto'
  // ~3 rows worth of compact cards across breakpoints — a single value
  // is approximate (row height varies with card width) but lands close
  // enough that users see ~3 rows on mobile and ~3 rows on desktop.
  const SCROLL_BOX_CLASSES = 'max-h-[52rem] overflow-y-auto'

  const skeleton = (n: number) =>
    pinnedView ? (
      // Showcase loading state: same swipe/four-up shell as the cards, capped
      // at the per-category pin limit (4) so it doesn't flash extra tiles.
      <div className={SHOWCASE_ROW_CLASSES}>
        {Array.from({ length: Math.min(n, 4) }).map((_, i) => (
          <div key={i} className={`${SHOWCASE_ITEM_CLASSES} aspect-square bg-surface animate-pulse border border-raised`} />
        ))}
      </div>
    ) : (
      <div className={GRID_CLASSES}>
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
  // Public showcase reframes the owner's raw categories as a curated reel.
  const showcaseSectionLabel: Record<PinCategory, string> = {
    mints: 'Featured Mints',
    collected: 'Prized Possessions',
    listings: 'Curated Listings',
  }
  const sectionCount: Record<SectionId, number | null> = {
    mints: loadingMoments ? null : displayMoments.length,
    collected: loadingCollected ? null : displayCollected.length,
    listings: loadingListings ? null : displayListings.length,
    payments: loadingPayments ? null : payments.length,
    airdrops: loadingAirdrops ? null : airdrops.length,
    // Curate count rendered by the panel itself (it knows the live featured set).
    curate: null,
  }
  // Card-based sections render one of two layouts. The curated SHOWCASE
  // (visitor / public-view, ≤4 cards) is a horizontal snap-swipe on phones and
  // a four-up row on web — no scroll-box or lazy-mount needed at that size. The
  // owner DASHBOARD (full mint/collected/listing lists) keeps the dense grid
  // inside a scroll-clipped box; `index` lets callers flag the first row (lg+ =
  // 6 cards) as priority, and each item is MaybeLazy so mobile defers mount of
  // items past the eager window (desktop renders inline via lazy=false).
  function renderCardCollection<T>(items: T[], renderCard: (item: T, index: number) => React.ReactNode, getItemKey: (item: T) => string) {
    if (pinnedView) {
      return (
        <div className={SHOWCASE_ROW_CLASSES}>
          {items.map((it, index) => (
            <div key={getItemKey(it)} className={SHOWCASE_ITEM_CLASSES}>
              {renderCard(it, index)}
            </div>
          ))}
        </div>
      )
    }
    return (
      <div className={SCROLL_BOX_CLASSES}>
        <div className={GRID_CLASSES}>
          {items.map((it, index) => (
            <MaybeLazy key={getItemKey(it)} index={index} lazy={isMobile}>
              {() => renderCard(it, index)}
            </MaybeLazy>
          ))}
        </div>
      </div>
    )
  }

  const sectionContent: Record<SectionId, React.ReactNode> = {
    mints: collectionsMode && !pinnedView ? (
      loadingCollections ? skeleton(6) : artistCollections.length === 0 ? (
        <p className="text-muted font-mono text-xs">no collections yet</p>
      ) : renderCardCollection(
        artistCollections,
        (c, index) => {
          const collectionName = c.metadata?.name || c.name
          return (
            <div className="flex flex-col bg-[#161616] border border-line overflow-hidden">
              <Link href={`/collection/${c.contractAddress}`} className="relative aspect-square bg-surface block overflow-hidden group/img">
                <CollectionPreviewImage src={c.metadata?.image} alt={collectionName} thumbhash={c.metadata?.kismet_thumbhash} priority={index < 6} />
              </Link>
              <div className="px-2 pt-2 pb-1 gap-0.5 flex flex-col">
                <h3 className="text-[11px] text-ink font-mono truncate">{collectionName}</h3>
                <span className="text-[9px] font-mono text-muted truncate">{shortAddress(c.contractAddress)}</span>
              </div>
              <div className="px-2 pb-2 gap-1 flex flex-col mt-auto">
                <Link
                  href={`/collection/${c.contractAddress}`}
                  className="w-full text-center font-mono border border-line text-dim hover:border-muted hover:text-ink transition-colors py-1 text-[10px]"
                >
                  view
                </Link>
                <Link
                  href={`/mint?collection=${c.contractAddress}&name=${encodeURIComponent(collectionName)}`}
                  className="w-full text-center font-mono border border-accent/40 text-accent hover:border-accent hover:bg-accent/10 transition-colors py-1 text-[10px]"
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
      loadingMoments ? skeleton(6) : displayMoments.length === 0
        ? <p className="text-muted font-mono text-xs">no mints yet</p>
        : renderCardCollection(
            displayMoments,
            (m, index) => <MomentCard moment={m} hidePriceSupply={!pinnedView} compact showCreator priority={index < 6} isMobile={isMobile} {...ownerPinProps('mints', m.address, m.token_id)} />,
            (m) => m.id ?? `${m.address}-${m.token_id}`,
          )
    ),
    collected: loadingCollected ? skeleton(6) : displayCollected.length === 0
      ? <p className="text-muted font-mono text-xs">none collected yet</p>
      : renderCardCollection(
          displayCollected,
          (m, index) => <MomentCard moment={m} hidePriceSupply={!pinnedView} compact showCreator priority={index < 6} passBadge={passBadge ?? undefined} isMobile={isMobile} {...ownerPinProps('collected', m.address, m.token_id)} />,
          (m) => m.id ?? `${m.address}-${m.token_id}`,
        ),
    listings: loadingListings ? skeleton(3) : displayListings.length === 0
      ? (
        <p className="text-muted font-mono text-xs">
          collect a moment on discover then{' '}
          <Link href={`/profile/${address}`} className="accent-grad hover:opacity-80 transition-opacity">list</Link>
          {' '}it here
        </p>
      )
      : renderCardCollection(
          displayListings,
          (l, index) => (
            <MarketCard
              listing={l}
              onRemove={() => setListings((prev) => prev.filter((x) => x.id !== l.id))}
              compact
              showCreator
              priority={index < 6}
              {...ownerPinProps('listings', l.collectionAddress, l.tokenId)}
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
    <div
      className="max-w-4xl mx-auto px-4 py-12 flex flex-col gap-12"
      style={theme ? themeCssVars(theme) : undefined}
    >
      {/* Owner-only permissions banner. Hidden when missingCount is 0
          to keep healthy profiles uncluttered. */}
      {!asVisitor && ownCollectionsMissingAdmin > 0 && (
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

      {/* Profile header — `relative isolate` so the themed backdrop band can
          sit behind the header (-z) yet paint above main's opaque bg. It's a
          modal-free region, so isolating it can't trap ProfileView's overlays. */}
      <div ref={headerRef} className="relative isolate flex flex-col gap-4">
        {theme && <ProfileThemeBackdrop theme={theme} inView={headerInView} />}
        <div className="flex flex-wrap items-center gap-6">
          <div className="relative">
            {/* Bloom glow behind the avatar — the bloom effect extended to the
                avatar so it breathes with the backdrop. Behind + non-interactive
                so it never blocks the edit control; reduced-motion viewers get a
                static halo (the keyframe lives only in the no-preference query). */}
            {theme && theme.motion?.bloom && (
              <div
                aria-hidden
                className="pointer-events-none absolute -inset-6 rounded-full"
                style={{
                  zIndex: -1,
                  background: `radial-gradient(circle, ${theme.palette.primary}40, transparent 70%)`,
                  animation: 'kf-theme-bloom 6s ease-in-out infinite',
                  animationPlayState: headerInView ? 'running' : 'paused',
                }}
              />
            )}
            {!loadingProfile ? (
              theme ? (
                <PaletteRing stops={theme.palette.ringStops} ringStart={theme.geometry.ringStart} size={80}>
                  <ProfileAvatar address={address} avatarUrl={profile?.avatarUrl} size={80} editable={!asVisitor} onEdit={openEdit} />
                </PaletteRing>
              ) : (
                <ProfileAvatar address={address} avatarUrl={profile?.avatarUrl} size={80} editable={!asVisitor} onEdit={openEdit} />
              )
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
                    {!asVisitor && (
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
            {theme && <ProvenanceChip theme={theme} />}
            {/* Owner-only "public view" toggle — always under the follower
                count. Flips to the exit control while previewing: the one piece
                of owner chrome kept visible so the preview stays escapable. */}
            {isOwner &&
              (previewPublic ? (
                <button
                  onClick={() => setPreviewPublic(false)}
                  className="self-start mt-3 text-xs font-mono px-2.5 py-1 border border-accent/40 text-accent hover:border-accent hover:bg-accent/10 transition-colors"
                >
                  exit public view
                </button>
              ) : (
                <div className="self-start mt-3 flex items-center gap-2">
                  <button
                    onClick={() => setPreviewPublic(true)}
                    className="text-xs font-mono px-2.5 py-1 border border-line text-muted hover:border-dim hover:text-dim transition-colors"
                  >
                    public view
                  </button>
                  <button
                    onClick={() => setCustomizing(true)}
                    className="text-xs font-mono px-2.5 py-1 border border-line text-muted hover:border-dim hover:text-dim transition-colors"
                  >
                    ✦ customize
                  </button>
                </div>
              ))}
          </div>
          {/* Earnings card — right of the identity block (wraps below on
              mobile). Private by default: the owner sees it with a pin toggle,
              visitors only once pinned public. Renders nothing otherwise. */}
          <ProfileStats address={address} asVisitor={asVisitor} />
        </div>

      </div>

      {/* Customize-profile panel — owner-only content-derived theme picker.
          Lifts the chosen theme to state so the re-skin / ring / backdrop
          apply live (no reload). Owner-gated twice: the trigger is owner-only,
          and the route re-validates ownership server-side. */}
      {customizing && isOwner && (
        <CustomizePanel
          address={address}
          moments={moments}
          collected={collected}
          listings={listings}
          theme={theme}
          onThemeChange={setTheme}
          onClose={closeCustomize}
        />
      )}

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
      {editing && !asVisitor && (
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

      {/* Owner-only agent surfaces, consolidated here (replacing the former global
          "Agent" nav tab): the autonomous Agent Collect setup + the Base MCP skill
          entry. Owner chrome — hidden while previewing the public view. Both
          self-gate on smart-wallet eligibility, so an EOA owner sees neither. */}
      {isOwner && !previewPublic && (
        <div className="mb-4 flex flex-col gap-3">
          <AgentCollectPanel />
          <AgentSkillCard />
        </div>
      )}

      {/* Owner-only curation hint, shown only when nothing is pinned: an owner
          only ever sees this (full) dashboard, so without it they'd have no
          prompt to feature artworks on their otherwise detail-only profile. */}
      {ownerHasNoPins && !previewPublic && (
        <div className="border border-line bg-surface/40 px-4 py-3 mb-4">
          <p className="text-xs font-mono text-muted leading-relaxed">
            Tap the <Pin size={14} strokeWidth={1.5} className="inline align-middle text-dim" aria-label="pin" /> on any artwork below to feature it on your profile.
            {' '}<span className="text-dim">Pin</span> up to 4 of your mints, collects and listings.
          </p>
        </div>
      )}

      {/* Draggable / collapsible sections. The optional `curate` section is
          appended last for the curator on their own profile and is not
          drag-reorderable — it stays pinned to the bottom. */}
      <div ref={sectionContainerRef} className="flex flex-col">
        {pinnedView ? (
          // Public showcase: the owner's featured Mints / Collected / Listings,
          // renamed and always-expanded (a curated reel — no collapse), empty
          // categories hidden, fixed order, non-draggable.
          (['mints', 'collected', 'listings'] as const)
            // Only categories the owner pinned into; show a skeleton while that
            // category's source loads, then hide it if nothing renders.
            .filter((section) => pins[section].length > 0 && (pinSectionLoading[section] || (sectionCount[section] ?? 0) > 0))
            .map((section) => {
              const count = sectionCount[section]
              return (
                <div key={section} className="border-t border-line">
                  {/* Featured sections don't collapse — always expanded, no chevron. */}
                  <h2 className="py-4 text-xs font-mono text-dim uppercase tracking-wider">
                    {showcaseSectionLabel[section]}{count !== null ? ` (${count})` : ''}
                  </h2>
                  <div className="pb-8">{sectionContent[section]}</div>
                </div>
              )
            })
        ) : (
          (showCurate ? [...sectionOrder, 'curate' as const] : sectionOrder).map((section) => {
          const isCollapsed = sectionCollapsed[section] ?? false
          const count = sectionCount[section]
          const isReorderable = section !== 'curate'
          const isDragging = draggingSection === section
          return (
            <div
              key={section}
              data-section={section}
              className={`border-t border-line transition-opacity duration-150 ${isDragging ? 'opacity-40' : 'opacity-100'}`}
              style={isDragging ? {
                transform: `translate3d(0, ${sectionDragOffsetY}px, 0) scale(1.02)`,
                position: 'relative',
                zIndex: 10,
                boxShadow: '0 6px 16px rgba(0, 0, 0, 0.45)',
              } : undefined}
            >
              <div
                {...(isReorderable
                  ? bindSection(section)
                  : { onClick: () => toggleCollapsed(section) })}
                // Enter / Space activation lives outside the pointer path,
                // matching the TabBar treatment. `e.target === e.currentTarget`
                // ensures bubbled keydown from the inner "collections"
                // button doesn't also toggle the section.
                onKeyDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    toggleCollapsed(section)
                  }
                }}
                role="button"
                tabIndex={0}
                aria-expanded={!isCollapsed}
                // touch-action: none on reorderable headers — the drag
                // axis is vertical, and so is the page's natural scroll,
                // so `pan-y` here would let the browser claim the gesture
                // before our long-press timer could fire (the symptom
                // was unresponsive drag on Mini App webviews). Headers
                // are short (~3rem); users still have the whole section
                // body below for normal page scrolling.
                className={`flex items-center gap-2 py-4 select-none ${isReorderable ? 'touch-none cursor-grab active:cursor-grabbing' : 'cursor-pointer'}`}
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
                    onPointerDown={(e) => e.stopPropagation()}
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
        })
        )}
      </div>
    </div>
  )
}
