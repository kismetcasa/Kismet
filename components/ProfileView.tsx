'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useAccount, useSignMessage } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Pencil, ChevronRight, Copy, Check, X, Search, ShieldAlert, Pin, BadgeCheck } from 'lucide-react'
import { SOCIAL_PLATFORMS, socialLink, type SocialPlatformKey } from '@/lib/socials'
import { ProfileAvatar } from './ProfileAvatar'
import { ProfileStats } from './ProfileStats'
import { PaletteRing } from './PaletteRing'
import { ProfileThemeBackdrop } from './ProfileThemeBackdrop'
import { CustomizePanel } from './CustomizePanel'
import { themeCssVars } from '@/lib/themeStyle'
import { foldSearch } from '@/lib/searchText'
import { orderByPins, pinsFirst, visibleToPublic, MAX_PINS_PER_CATEGORY, type PublicViewMode } from '@/lib/showcaseOrder'
import type { ProfileTheme } from '@/lib/profileTheme'
import type { EarningsAmounts } from '@/lib/earningsFormat'
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
// Compact status card that opens the full setup/management panel in a modal
// (bottom sheet on mobile / Base app, centered on desktop) — progressive
// disclosure instead of an always-open form. Self-gates via useAgent.
const AgentCollectEntry = dynamic(
  () => import('./AgentCollectEntry').then((m) => m.AgentCollectEntry),
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

// Ordering (orderByPins for the curated showcase, pinsFirst for the full
// profile) lives in lib/showcaseOrder — pure, Redis-free, and CI-verified by
// scripts/verify-showcase-order.ts. The ref keys mirror lib/showcase's
// "<collection>:<tokenId>" member form.
const momentPinKey = (m: Moment) => `${m.address.toLowerCase()}:${m.token_id}`
const listingPinKey = (l: Listing) => `${l.collectionAddress.toLowerCase()}:${l.tokenId}`

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
      href={`/artwork/${coll}/${tid}`}
      className="self-start inline-flex items-center gap-1.5 max-w-full text-[11px] font-mono text-muted hover:text-dim transition-colors"
      title={`Theme derived from ${theme.momentName ?? 'this artwork'}`}
    >
      <span aria-hidden className="text-accent">✦</span>
      <span className="truncate">themed from {theme.momentName ?? 'this artwork'}</span>
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
  // User-claimed social handles/links (X, Farcaster, Instagram, website).
  socials?: Partial<Record<SocialPlatformKey, string>>
  // Proof-of-ownership socials inherited from Farcaster (X only today);
  // outranks the claimed `socials.x` and renders with a verified badge.
  verifiedSocials?: { x?: string }
  // Server-computed: collapses the username → farcaster → ens fallback
  // chain into a single field. See app/api/profile/[address]/route.ts.
  displayName?: string | null
  earnings?: {
    eth: number
    usdc: number
    usd: number
    mints: number
    primary?: EarningsAmounts
    secondary?: EarningsAmounts
  } | null
  // FC-verified sibling wallets of this profile's identity (lowercase).
  // Feeds the owner check below; absent for non-FC profiles.
  fcWallets?: string[]
  updatedAt: number
}

export function ProfileView({ address, isMobile = false, theme: initialTheme }: ProfileViewProps) {
  const { address: connectedAddress } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signMessageAsync } = useSignMessage()
  const { isInMiniApp, identity: fcIdentity } = useFarcaster()
  const { isAdmin, isCurator } = useAdmin()

  const [profile, setProfile] = useState<Profile | null>(null)

  // Owner via wagmi (web + Mini App) OR via FC identity (Mini App users
  // whose wagmi wallet is currently a different sibling) OR via the FID
  // sibling set from the profile payload. The third branch is the web
  // equivalent of the second: fcIdentity is null outside a Mini App, and the
  // page 307-redirects every profile URL to its canonical address — so a web
  // FC user connected with a non-canonical sibling wallet landed here with
  // neither branch matching and was rendered the VISITOR view of their own
  // profile. Mirrors the server's owner model (authorizeProfileOwner /
  // isViewerFidSibling both canonicalize); server routes still re-validate
  // every write, this only chooses which view to render.
  const isOwner =
    connectedAddress?.toLowerCase() === address.toLowerCase() ||
    fcIdentity?.address?.toLowerCase() === address.toLowerCase() ||
    (!!connectedAddress && !!profile?.fcWallets?.includes(connectedAddress.toLowerCase()))
  // Connected-wallet-STRICT owner gate for the WRITE affordances — the
  // profile edit (pencil / avatar / save) AND the permissions banner. Both
  // require the CONNECTED wallet to BE this exact canonical address:
  //   • the profile PUT verifies a raw wallet signature FROM `address`
  //     (viem verifyMessage against the URL address in
  //     app/api/profile/[address]/route.ts) — no other wallet, sibling or
  //     FC-verified, can produce it;
  //   • the permissions grant is an on-chain tx signed by the connected
  //     wallet that only the collection's on-chain ADMIN can execute.
  // So this excludes BOTH isOwner's fcWallets-sibling branch AND its
  // fcIdentity branch. A Mini App owner whose connected wallet differs from
  // their FC/profile address can satisfy NEITHER write — yet the fcIdentity
  // branch used to surface a false "1 of your collections needs authorize"
  // banner (useCollectionsPermissions reads the CONNECTED wallet's smart
  // wallet, so it checked the wrong one — the collection was fine on-chain)
  // and an edit pencil whose save 401s. Such owners keep the full owner VIEW
  // via isOwner (which retains those branches); they edit/authorize from
  // their canonical wallet. Server routes re-validate every write regardless.
  const canEditProfile =
    connectedAddress?.toLowerCase() === address.toLowerCase()
  // Curators get a Curate panel on their own profile, pinned as the last
  // section. The panel reuses the existing /api/featured plumbing.
  const showCurate = isOwner && isCurator
  // Full-profile view capability. Owners always see their full dashboard;
  // admins get that same full view of ANY profile so they can monitor and
  // curate the platform — every mint/collect/listing card renders, so the
  // per-card FeatureStar can feature anything, not just what a visitor sees.
  // This is a READ capability only: edit/pin/curate chrome stays gated on
  // isOwner / canEditProfile, so an admin viewing someone else is read-only.
  const canViewFull = isOwner || isAdmin
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
  const [socialsInput, setSocialsInput] = useState<Record<SocialPlatformKey, string>>({
    x: '',
    farcaster: '',
    instagram: '',
    website: '',
  })
  const [saving, setSaving] = useState(false)
  const [collectionsMode, setCollectionsMode] = useState(false)
  const [following, setFollowing] = useState(false)
  const [followLoading, setFollowLoading] = useState(false)
  const [addrCopied, setAddrCopied] = useState(false)
  const [linkCopied, setLinkCopied] = useState(false)
  // Owner-only "public view" preview: render the profile exactly as a visitor
  // sees it (no pushpins / edit / curate / owner-only sections — and no
  // hidden artworks: the owner's payloads include their own hidden content
  // for the dashboard, so the preview renders from the visibleToPublic
  // sources below) so the owner can check their curation, then toggle back
  // out.
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
    // Drop the previous profile BEFORE the new address's first paint: isOwner
    // now reads profile.fcWallets, so a stale payload would briefly mark the
    // viewer as owner of the NEW profile (owner chrome + owner fetches on
    // someone else's page) until the fresh fetch lands.
    setProfile(null)
    setLoadingProfile(true)
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
  // True once the initial pins GET resolves. Gates the un-pinned mints
  // fallback so it engages only once we KNOW the artist hasn't pinned. Pins
  // start empty, so without this gate every profile — even a curated one —
  // would render the "Recent Mints" fallback during the pins fetch, then flip
  // to the pinned set. Reset per address below.
  const [pinsLoaded, setPinsLoaded] = useState(false)
  // Set once the owner toggles a pin, so the initial GET (which runs on mount
  // and may still be in flight) can't overwrite an optimistic toggle.
  const pinsTouched = useRef(false)
  // What visitors see: the full profile with pinned items first ('full', the
  // resolved default) or the curated showcase ('curated' — explicit choice,
  // or the grandfathered default for profiles that pinned before the setting
  // existed; the server resolves all of that and sends one value). Seeded
  // 'curated' — the fail-private value, and harmless either way: the public
  // view renders no sections at all until pinsLoaded, so the seed never
  // paints the wrong mode.
  const [publicView, setPublicView] = useState<PublicViewMode>('curated')
  // Mirrors pinsTouched for the mode. Tracked separately: a mode toggle must
  // not block the pins payload from applying, nor a pin toggle the mode.
  const viewTouched = useRef(false)
  const [savingView, setSavingView] = useState(false)

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

  // Tier 1 — header + first section. Cancellation guard: without it, rapid
  // navigation lets a SLOW previous profile's response land after the new
  // one and clobber it — and isOwner reads profile.fcWallets, so that stale
  // payload could mark the viewer as owner of someone else's profile.
  useEffect(() => {
    let cancelled = false
    fetch(`/api/profile/${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => { if (!cancelled) setProfile(d.profile ?? { address, updatedAt: 0 }) })
      .catch(() => { if (!cancelled) setProfile({ address, updatedAt: 0 }) })
      .finally(() => { if (!cancelled) setLoadingProfile(false) })
    return () => {
      cancelled = true
    }
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

  // Pinned showcase refs + the owner's public-view mode — Tier 1 because the
  // render mode (curated showcase vs full-with-pins-first) depends on both,
  // and they travel in the one payload so the mode can never flip after the
  // sections have painted. Tiny payload; degrades to no-pins + 'curated' (the
  // pre-setting behavior) on any failure.
  useEffect(() => {
    pinsTouched.current = false
    viewTouched.current = false
    setPins(EMPTY_PINS)
    setPublicView('curated')
    setPinsLoaded(false)
    fetch(`/api/profile/${address}/pins`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      // Normalize per-category so a partial/garbled payload can't leave a
      // category undefined (pins[cat].includes / .length would then throw).
      // Skip if the owner already toggled — don't clobber an optimistic pin.
      .then((d) => {
        if (!pinsTouched.current) setPins({
          mints: Array.isArray(d?.pins?.mints) ? d.pins.mints : [],
          collected: Array.isArray(d?.pins?.collected) ? d.pins.collected : [],
          listings: Array.isArray(d?.pins?.listings) ? d.pins.listings : [],
        })
        // Same optimistic-write guard for the mode; anything unexpected in
        // the payload reads as 'curated' (fail-private, matching the server).
        if (!viewTouched.current) setPublicView(d?.publicView === 'full' ? 'full' : 'curated')
      })
      .catch(() => { if (!pinsTouched.current) setPins(EMPTY_PINS) })
      // Mark loaded on both paths — on error we fall back to no-pins, which
      // (for an artist with mints) is exactly when the recent-mints default
      // should engage rather than leaving the profile blank.
      .finally(() => setPinsLoaded(true))
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

  // Sales + Airdrops are full-dashboard-only sections — a visitor's curated
  // view never renders them, so skip the fetches unless the viewer can see the
  // full profile (owner or admin). Mark them resolved (loading=false) on the
  // curated path so the flags don't stay true for the component's life (which
  // would leave their section counts null).
  useEffect(() => {
    if (!canViewFull) { setLoadingPayments(false); return }
    if (!tier3) return
    fetch(`/api/payments?artist=${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setPayments(Array.isArray(d.payments) ? d.payments : []))
      .catch(() => setPayments([]))
      .finally(() => setLoadingPayments(false))
  }, [address, tier3, canViewFull])

  useEffect(() => {
    if (!canViewFull) { setLoadingAirdrops(false); return }
    if (!tier3) return
    fetch(`/api/airdrops?artist_address=${address}`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((d) => setAirdrops(Array.isArray(d.airdrops) ? d.airdrops : []))
      .catch(() => setAirdrops([]))
      .finally(() => setLoadingAirdrops(false))
  }, [address, tier3, canViewFull])

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
    setSocialsInput({
      x: profile?.socials?.x ?? '',
      farcaster: profile?.socials?.farcaster ?? '',
      instagram: profile?.socials?.instagram ?? '',
      website: profile?.socials?.website ?? '',
    })
    setEditing(true)
  }

  async function saveProfile() {
    if (!canEditProfile || !connectedAddress) { openConnectModal?.(); return }
    setSaving(true)
    try {
      const nonceRes = await fetch(`/api/profile/${address}/nonce`)
      if (!nonceRes.ok) throw new Error(`Could not fetch nonce (HTTP ${nonceRes.status})`)
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce (empty response)')
      const message = `Update Kismet profile\nAddress: ${address.toLowerCase()}\nNonce: ${nonce}`
      const signature = await signMessageAsync({ message })
      const res = await fetch(`/api/profile/${address}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: usernameInput.trim() || undefined, avatarUrl: avatarInput.trim() || undefined, socials: socialsInput, signature, nonce }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error ?? 'Failed to save') }
      const { profile: updated } = await res.json()
      // MERGE over the enriched GET payload — the PUT returns only the bare
      // store projection, and replacing wholesale dropped fcWallets (killing
      // the sibling owner check until reload) plus earnings/ensName/farcaster.
      // displayName: a new username takes over (server precedence); when
      // cleared, keep a non-username-derived displayName (FC/ENS enrichment)
      // and let the render fallback chain handle the rest.
      setProfile((prev) => ({
        ...(prev ?? { address, updatedAt: 0 }),
        ...updated,
        displayName:
          updated.username ??
          (prev && prev.displayName !== prev.username ? prev.displayName : null),
      }))
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
      if (!nonceRes.ok) throw new Error(`Could not fetch nonce (HTTP ${nonceRes.status})`)
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce (empty response)')
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

  // Owner control for the visitor default (curated showcase vs full profile).
  // Optimistic like togglePin; the chips disable while a save is in flight so
  // opposite taps can't interleave into a state/server mismatch.
  async function saveViewMode(mode: PublicViewMode) {
    if (mode === publicView || savingView) return
    viewTouched.current = true // from here, optimistic state wins over the GET
    const prev = publicView
    setPublicView(mode)
    setSavingView(true)
    try {
      const res = await fetch(`/api/profile/${address}/public-view`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error ?? 'Failed')
      }
    } catch (err) {
      setPublicView(prev)
      toastError('Save', err)
    } finally {
      setSavingView(false)
    }
  }

  // Owner-write-chrome gate. True for anyone who isn't the owner (incl. an
  // admin viewing someone else) OR an owner previewing the public view. Edit /
  // pin / curate affordances gate on `!asVisitor`, so they only ever show to
  // the owner in their own full view — an admin's full view stays read-only.
  const asVisitor = !isOwner || previewPublic
  // Render-mode gate, deliberately separate from write-chrome: show the full
  // owner-style dashboard (every section incl. Sales/Airdrops, un-curated
  // lists) vs the owner's chosen public view. Owners and admins see the
  // dashboard; `previewPublic` flips either of them to the public view.
  // Everyone else gets the public view.
  const fullView = canViewFull && !previewPublic

  // Public-view split. What the public view SHOWS is the owner's saved
  // preference (`publicView`, delivered with the pins payload):
  //   'curated' — the showcase: ONLY pinned moments, filtered from the
  //     already-loaded arrays, which keeps the render self-validating (a pin
  //     can only show content the owner truly minted/collected/listed). With
  //     no pins it has no sections at all — just the profile header — except
  //     the recent-mints fallback below.
  //   'full' — the full profile: every artwork section complete, with the
  //     pinned items floated to the front of each grid (pinsFirst).
  // Sales / Airdrops / owner chrome stay dashboard-only in BOTH modes.
  const showcaseView = !fullView && publicView === 'curated'
  const publicFullView = !fullView && publicView === 'full'
  // Gated on pinsLoaded so the owner's zero-pin hint can't flash while the
  // initial pins GET is still in flight.
  const ownerHasNoPins =
    isOwner && pinsLoaded && pins.mints.length + pins.collected.length + pins.listings.length === 0

  // Un-pinned mints fallback (curated mode only — the full profile already
  // shows everything). An artist who hasn't pinned any mints still gets a
  // populated showcase — their most-recent mints, up to the pin cap — so a
  // new artist's public profile isn't blank. Scoped to mints only (the
  // artist's own work); collected/listings stay curated-only, preserving the
  // blank-until-pinned philosophy for pure collectors. `moments` is already
  // loaded for every visitor (Tier 1) and sorted newest-first, so this is a
  // plain slice — no extra fetch. The moment the artist pins one mint,
  // pins.mints.length > 0 flips this off and the pinned set replaces the
  // default. (The slice matches MAX_PINS_PER_CATEGORY so the fallback fills
  // the same showcase footprint a fully-pinned section would.)
  const mintsFallback = showcaseView && pinsLoaded && pins.mints.length === 0

  // Visitor-parity sources for the two public-view modes. The OWNER's own
  // payloads deliberately include their hidden content — /api/timeline
  // returns the creator's hidden mints flagged `hidden: true` (so the
  // dashboard can badge them for unhide), and the seller-scope /api/listings
  // flags content-hidden rows the same way — while a real visitor's fetch
  // drops those rows server-side. The public view (and the owner/admin
  // preview, which is this same client re-rendering the owner's arrays) must
  // render from the filtered sources, or the preview shows mints visitors
  // never see and its section counts overcount. Ordering runs AFTER the
  // filter so the recent-mints fallback slice backfills with the next
  // VISIBLE mint — exactly what a visitor's pre-filtered feed slices — and a
  // pinned-but-hidden ref falls away like any stale ref. Dashboard branches
  // keep the raw arrays: surfacing your own hidden work there is the point.
  // `collected` needs no filter — the collector feed drops hidden moments
  // for every viewer, owner included. For visitors both filters are identity
  // no-ops (their payloads arrive pre-filtered, nothing is flagged).
  const publicMoments = visibleToPublic(moments)
  const publicListings = visibleToPublic(listings)

  const displayMoments = showcaseView
    ? (mintsFallback ? publicMoments.slice(0, MAX_PINS_PER_CATEGORY) : orderByPins(publicMoments, momentPinKey, pins.mints))
    : publicFullView
      ? pinsFirst(publicMoments, momentPinKey, pins.mints)
      : moments
  const displayCollected = showcaseView
    ? orderByPins(collected, momentPinKey, pins.collected)
    : publicFullView
      ? pinsFirst(collected, momentPinKey, pins.collected)
      : collected
  const displayListings = showcaseView
    ? orderByPins(publicListings, listingPinKey, pins.listings)
    : publicFullView
      ? pinsFirst(publicListings, listingPinKey, pins.listings)
      : listings
  const pinSectionLoading: Record<PinCategory, boolean> = {
    mints: loadingMoments,
    collected: loadingCollected,
    listings: loadingListings,
  }

  // Pin props for a card. Owner dashboard: the live toggle. Visitor-facing
  // FULL profile: a read-only `pinned` marker on the featured items so the
  // pins-first ordering is legible. Curated showcase and every other case:
  // {} — no pin chrome, and the memoized card identity stays intact.
  // Membership is a plain .includes over the ref array (capped at
  // MAX_PINS_PER_CATEGORY) — no Set.
  function cardPinProps(
    category: PinCategory,
    collectionAddress: string,
    tokenId: string,
  ): { pinned?: boolean; onTogglePin?: () => void } {
    const isPinned = pins[category].includes(`${collectionAddress.toLowerCase()}:${tokenId}`)
    if (!asVisitor) {
      return { pinned: isPinned, onTogglePin: () => togglePin(category, collectionAddress, tokenId) }
    }
    if (publicFullView && isPinned) return { pinned: true }
    return {}
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
  // cards on phones, and a three-up row on web (lg+) — the same column count
  // as the discover feed, so showcase cards render at the platform's standard
  // full-card scale. (Was four-up to match the original 4-pin cap, but
  // ~270px cards read too small next to every other surface; at the 6-pin
  // cap the three-up grid fills exactly two rows.) The dense dashboard grid
  // (GRID_CLASSES) still drives the owner's full mint/collected lists.
  const SHOWCASE_ROW_CLASSES =
    'flex gap-3 overflow-x-auto snap-x snap-mandatory [-webkit-overflow-scrolling:touch] lg:grid lg:grid-cols-3 lg:gap-4 lg:overflow-visible'
  // grid grid-rows-1 makes the card fill the cell so every box in a section
  // row is the same height regardless of content (price loaded, owned, text
  // moment): the row stretches items to the tallest, this stretches the card
  // to fill that height in turn.
  const SHOWCASE_ITEM_CLASSES = 'grid grid-rows-1 w-72 flex-shrink-0 snap-start lg:w-auto'
  // ~3 rows worth of compact cards across breakpoints — a single value
  // is approximate (row height varies with card width) but lands close
  // enough that users see ~3 rows on mobile and ~3 rows on desktop.
  const SCROLL_BOX_CLASSES = 'max-h-[52rem] overflow-y-auto'

  const skeleton = (n: number) =>
    showcaseView ? (
      // Showcase loading state: same swipe/three-up shell as the cards, capped
      // at the per-category pin limit so it doesn't flash extra tiles.
      <div className={SHOWCASE_ROW_CLASSES}>
        {Array.from({ length: Math.min(n, MAX_PINS_PER_CATEGORY) }).map((_, i) => (
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
  // (public view in 'curated' mode, ≤6 cards) is a horizontal snap-swipe on
  // phones and a three-up grid (two full rows when a section is pinned to
  // the cap) on web — no scroll-box or lazy-mount needed at that size. FULL lists (the owner dashboard AND the public view in 'full'
  // mode) keep the dense grid inside a scroll-clipped box; `index` lets
  // callers flag the first row (lg+ = 6 cards) as priority, and each item is
  // MaybeLazy so mobile defers mount of items past the eager window (desktop
  // renders inline via lazy=false).
  function renderCardCollection<T>(items: T[], renderCard: (item: T, index: number) => React.ReactNode, getItemKey: (item: T) => string) {
    if (showcaseView) {
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
    mints: collectionsMode && fullView ? (
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
            // Curated showcase renders the STANDARD full card (the same card
            // as the discover feed — full action row, meta slot, copy/open
            // affordances) at feed scale; compact is for the dense grids (the
            // owner dashboard and the visitor-facing full profile).
            (m, index) => <MomentCard moment={m} hidePriceSupply={!showcaseView} compact={!showcaseView} showCreator priority={index < 6} isMobile={isMobile} {...cardPinProps('mints', m.address, m.token_id)} />,
            (m) => m.id ?? `${m.address}-${m.token_id}`,
          )
    ),
    collected: loadingCollected ? skeleton(6) : displayCollected.length === 0
      ? <p className="text-muted font-mono text-xs">none collected yet</p>
      : renderCardCollection(
          displayCollected,
          (m, index) => <MomentCard moment={m} hidePriceSupply={!showcaseView} compact={!showcaseView} showCreator priority={index < 6} passBadge={passBadge ?? undefined} isMobile={isMobile} {...cardPinProps('collected', m.address, m.token_id)} />,
          (m) => m.id ?? `${m.address}-${m.token_id}`,
        ),
    listings: loadingListings ? skeleton(3) : displayListings.length === 0
      ? (
        <p className="text-muted font-mono text-xs">
          collect an artwork on discover then{' '}
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
              compact={!showcaseView}
              showCreator
              priority={index < 6}
              {...cardPinProps('listings', l.collectionAddress, l.tokenId)}
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
              className="text-[10px] font-mono text-subtle hover:text-dim transition-colors flex-shrink-0"
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
              href={`/artwork/${a.collectionAddress}/${a.tokenId}`}
              className="text-xs font-mono text-subtle hover:text-dim transition-colors flex-shrink-0"
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
  // Owner-only entry point to the /permissions dashboard. We pass an empty
  // list for non-owners so the wagmi multicall doesn't fire — visitors don't
  // need (and shouldn't see) someone else's permission state. Gated on the
  // connected-wallet-STRICT canEditProfile (see its definition): the check
  // reads the CONNECTED wallet's smart-wallet admin state, so any wallet that
  // isn't this profile's owner — a sibling OR a Mini App wallet that differs
  // from the FC/profile address — would report the owner's collections as
  // missing admin and raise an alert whose grant flow that wallet cannot
  // execute (the false positive this strict gate exists to prevent).
  const collectionAddressesForPerms = canEditProfile
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
      className="max-w-6xl mx-auto px-4 py-12 flex flex-col gap-12"
      style={theme ? themeCssVars(theme) : undefined}
    >
      {/* Admin full-view banner — shown only to an admin viewing someone
          else's profile. Says which of the two surfaces is on screen — the
          owner-style full dashboard (all sections incl. Sales/Airdrops,
          read-only) vs the public-view preview — and names the profile's
          RESOLVED visitor mode (curated showcase vs full profile) once the
          pins payload lands, so the admin can tell the artist's choice at a
          glance instead of diffing layouts (a full-mode preview looks close
          to the dashboard; the mode label is what disambiguates). Falls back
          to the modeless wording until resolution so it never claims a mode
          it doesn't know. */}
      {isAdmin && !isOwner && (
        <div className="border border-accent/40 bg-accent/5 px-3 py-2 flex items-center gap-2">
          <ShieldAlert size={13} className="text-accent flex-shrink-0" />
          <p className="text-[11px] font-mono text-dim">
            {previewPublic
              ? `Admin preview (read-only) — the public view${
                  pinsLoaded
                    ? publicView === 'full'
                      ? ': full profile, pinned artworks first'
                      : ': curated showcase'
                    : ''
                }.`
              : `Admin view — full profile (read-only). ${
                  pinsLoaded
                    ? publicView === 'full'
                      ? 'Visitors see the full profile, pinned artworks first.'
                      : 'Visitors see the curated showcase.'
                    : 'This is not the public view.'
                }`}
          </p>
        </div>
      )}

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
        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
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
                  <ProfileAvatar address={address} avatarUrl={profile?.avatarUrl} size={80} editable={!asVisitor && canEditProfile} onEdit={openEdit} />
                </PaletteRing>
              ) : (
                <ProfileAvatar address={address} avatarUrl={profile?.avatarUrl} size={80} editable={!asVisitor && canEditProfile} onEdit={openEdit} />
              )
            ) : (
              <div className="w-20 h-20 rounded-full bg-raised animate-pulse" />
            )}
          </div>
          <div className="flex flex-col gap-1 order-3 w-full sm:order-2 sm:w-auto">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1 flex-1 min-w-0">
                {loadingProfile ? (
                  <div className="h-4 w-28 bg-raised animate-pulse rounded" />
                ) : (
                  <>
                    <p className="text-ink font-mono text-sm truncate">{displayName}</p>
                    {!asVisitor && canEditProfile && (
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
                      className="flex-shrink-0 p-1 text-subtle hover:text-dim transition-colors"
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
              <span className="text-subtle text-xs">·</span>
              <button
                onClick={() => openList('followers')}
                className={`text-xs font-mono transition-colors ${activeList === 'followers' ? 'text-ink' : 'text-muted hover:text-dim'}`}
              >
                <span className="text-ink">{followerCount ?? '—'}</span>{' '}followers
              </button>
            </div>
            {/* Social links. X prefers the Farcaster-verified handle (badged);
                every entry is re-validated by socialLink() before it reaches an
                href, and rendered with rel="noopener noreferrer nofollow ugc". */}
            {!loadingProfile && (() => {
              const items = SOCIAL_PLATFORMS.flatMap((p) => {
                const verified = p.key === 'x' ? profile?.verifiedSocials?.x : undefined
                const value = verified ?? profile?.socials?.[p.key]
                if (!value) return []
                const link = socialLink(p.key, value)
                return link ? [{ ...link, key: p.key, verified: !!verified }] : []
              })
              if (!items.length) return null
              return (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1">
                  {items.map((it) => (
                    <a
                      key={it.key}
                      href={it.url}
                      target="_blank"
                      rel="noopener noreferrer nofollow ugc"
                      title={`${it.label}: ${it.display}${it.verified ? ' (verified via Farcaster)' : ''}`}
                      className="inline-flex items-center gap-1 text-xs font-mono text-muted hover:text-ink transition-colors"
                    >
                      <span className="text-subtle uppercase tracking-wider">{it.short}</span>
                      <span className="truncate max-w-[11rem]">{it.display}</span>
                      {it.verified && <BadgeCheck size={11} className="text-accent flex-shrink-0" />}
                    </a>
                  ))}
                </div>
              )
            })()}
            {theme && <ProvenanceChip theme={theme} />}
            {/* "Public view" toggle — always under the follower count. Shown to
                anyone who can see the full profile (owner or admin) so they can
                flip between the full view and the public view. While previewing,
                the exit control stays visible so the preview is escapable — and
                the OWNER also gets the "visitors see" chooser right here, where
                its effect is live on screen: the preview re-renders in whichever
                mode is picked, and the choice saves immediately as the profile's
                visitor default. Customize is owner-only (it writes the profile
                theme). */}
            {canViewFull &&
              (previewPublic ? (
                <div className="self-start mt-3 flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => setPreviewPublic(false)}
                    className="text-xs font-mono px-2.5 py-1 border border-accent/40 text-accent hover:border-accent hover:bg-accent/10 transition-colors"
                  >
                    exit public view
                  </button>
                  {isOwner && (
                    <div
                      className="flex items-center gap-1.5"
                      role="group"
                      aria-label="What visitors see by default"
                    >
                      {/* Disabled until the resolved mode is known — the chips
                          act on (and display) server truth, never the seed. */}
                      <span className="text-[11px] font-mono text-muted">visitors see</span>
                      <button
                        onClick={() => saveViewMode('curated')}
                        disabled={savingView || !pinsLoaded}
                        aria-pressed={publicView === 'curated'}
                        className={`text-xs font-mono px-2.5 py-1 border transition-colors disabled:opacity-40 ${
                          publicView === 'curated'
                            ? 'border-accent/40 text-accent'
                            : 'border-line text-muted hover:border-dim hover:text-dim'
                        }`}
                      >
                        showcase
                      </button>
                      <button
                        onClick={() => saveViewMode('full')}
                        disabled={savingView || !pinsLoaded}
                        aria-pressed={publicView === 'full'}
                        className={`text-xs font-mono px-2.5 py-1 border transition-colors disabled:opacity-40 ${
                          publicView === 'full'
                            ? 'border-accent/40 text-accent'
                            : 'border-line text-muted hover:border-dim hover:text-dim'
                        }`}
                      >
                        full profile
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="self-start mt-3 flex items-center gap-2">
                  <button
                    onClick={() => setPreviewPublic(true)}
                    className="text-xs font-mono px-2.5 py-1 border border-line text-muted hover:border-dim hover:text-dim transition-colors"
                  >
                    public view
                  </button>
                  {isOwner && (
                    <button
                      onClick={() => setCustomizing(true)}
                      className="text-xs font-mono px-2.5 py-1 border border-line text-muted hover:border-dim hover:text-dim transition-colors"
                    >
                      ✦ customize
                    </button>
                  )}
                </div>
              ))}
          </div>
          {/* Earnings card — top-right corner across from the pfp (on mobile
              it shares the top row with the pfp; the identity column drops
              below). Private by default: the owner sees it with a pin toggle,
              visitors only once pinned public. Admins get a read-only view of
              any artist's figures (incl. private) for verification — but not
              while previewing the public view, where they should see exactly
              what a visitor sees. Renders nothing otherwise. */}
          <ProfileStats
            address={address}
            asVisitor={asVisitor}
            adminView={isAdmin && !isOwner && !previewPublic}
            initialEarnings={profile?.earnings ?? null}
          />
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
                  className="w-full bg-transparent text-xs font-mono text-ink placeholder-subtle focus:outline-none"
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
                // Raw for the address match (hex, no folding needed); folded for
                // the name so this list filter matches accented display names too
                // (same "gonz" vs "gønz" fix as global search).
                const q = searchQuery.toLowerCase().trim()
                const fq = foldSearch(searchQuery)
                const filtered = q
                  ? listAddresses.filter((a) =>
                      a.toLowerCase().includes(q) ||
                      (fq !== '' && foldSearch(nameMapRef.current[a] ?? '').includes(fq))
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
              className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-mono text-muted uppercase tracking-wider">Avatar URL</label>
            <input
              type="url"
              value={avatarInput}
              onChange={(e) => setAvatarInput(e.target.value)}
              placeholder="https://… (leave blank for gradient avatar)"
              className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
            />
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-xs font-mono text-muted uppercase tracking-wider">Social Links</label>
            {SOCIAL_PLATFORMS.map((p) => {
              // X proven-owned via Farcaster is shown read-only + badged — a
              // manual handle can't outrank a verified one, so don't offer the field.
              const verifiedX = p.key === 'x' ? profile?.verifiedSocials?.x : undefined
              if (verifiedX) {
                return (
                  <div key={p.key} className="flex items-center gap-2 text-xs font-mono">
                    <span className="w-16 flex-shrink-0 text-subtle uppercase tracking-wider">{p.label}</span>
                    <span className="text-ink truncate">@{verifiedX}</span>
                    <BadgeCheck size={12} className="text-accent flex-shrink-0" />
                    <span className="text-subtle">verified via Farcaster</span>
                  </div>
                )
              }
              return (
                <div key={p.key} className="flex items-center gap-2">
                  <span className="w-16 flex-shrink-0 text-xs font-mono text-subtle uppercase tracking-wider">{p.label}</span>
                  <input
                    type="text"
                    value={socialsInput[p.key]}
                    onChange={(e) => setSocialsInput((s) => ({ ...s, [p.key]: e.target.value }))}
                    placeholder={p.placeholder}
                    maxLength={200}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="flex-1 min-w-0 bg-surface border border-line px-3 py-2 text-sm text-ink font-mono placeholder-subtle focus:outline-none focus:border-muted"
                  />
                </div>
              )
            })}
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

      {/* Owner-only curation hint, shown only when nothing is pinned: an owner
          only ever sees this (full) dashboard, so without it they'd have no
          prompt to shape their public profile. Gated on pinsLoaded (inside
          ownerHasNoPins) so it can't flash while the pins GET is in flight,
          and on having something pinnable so an empty profile isn't nudged
          toward a pin it can't make. The copy tracks what visitors ACTUALLY
          see right now — recent mints (artist), header only (collector with
          nothing pinned), or the full profile — so the un-pinned state is
          never a mystery, and it points at the public-view chooser. */}
      {ownerHasNoPins && !previewPublic && moments.length + collected.length + listings.length > 0 && (
        <div className="border border-line bg-surface/40 px-4 py-3 mb-4">
          <p className="text-xs font-mono text-muted leading-relaxed">
            {publicView === 'full' ? (
              <>
                Visitors see your full profile. Tap the <Pin size={14} strokeWidth={1.5} className="inline align-middle text-dim" aria-label="pin" /> on any artwork below to feature up to {MAX_PINS_PER_CATEGORY} in each section — pinned artworks show first.
                {' '}<span className="text-dim">Prefer a minimal page? Open public view and choose showcase.</span>
              </>
            ) : (
              <>
                {/* publicMoments, not moments: hidden mints never reach the
                    visitor fallback, so an artist whose visible work is all
                    hidden gets the header-only wording. */}
                {publicMoments.length > 0
                  ? `Until you pin, visitors see your ${MAX_PINS_PER_CATEGORY} most recent mints. `
                  : 'Until you pin, visitors see only your profile header. '}
                Tap the <Pin size={14} strokeWidth={1.5} className="inline align-middle text-dim" aria-label="pin" /> on any artwork below to feature it — up to {MAX_PINS_PER_CATEGORY} each of your mints, collects and listings.
                {' '}<span className="text-dim">Prefer to show everything? Open public view and switch visitors to your full profile.</span>
              </>
            )}
          </p>
        </div>
      )}

      {/* Draggable / collapsible sections. The optional `curate` section is
          appended last for the curator on their own profile and is not
          drag-reorderable — it stays pinned to the bottom. */}
      <div ref={sectionContainerRef} className="flex flex-col">
        {!fullView ? (
          // Public view — what visitors see, in the owner's chosen mode.
          // 'curated': the featured Mints / Collected / Listings showcase,
          // renamed, ≤6 full-size cards each, empty categories hidden.
          // 'full': the same three sections complete — dense grid, pinned
          // items first, dashboard labels + counts. Sales / Airdrops stay
          // dashboard-only in both. Fixed order, always expanded (a public
          // reel — no collapse), non-draggable.
          (['mints', 'collected', 'listings'] as const)
            // Curated keeps categories the owner pinned into — plus the
            // un-pinned mints fallback (artist's recent work); full keeps any
            // category with content. Either way, show a skeleton while the
            // category's source loads, then hide it if nothing renders.
            .filter((section) => {
              const active =
                publicFullView || pins[section].length > 0 || (section === 'mints' && mintsFallback)
              return active && (pinSectionLoading[section] || (sectionCount[section] ?? 0) > 0)
            })
            .map((section) => {
              const count = sectionCount[section]
              // Curated sections re-frame the categories as a highlight reel —
              // with the honest "Recent Mints" label when the un-pinned
              // fallback (not the artist's curation) is what's showing. The
              // full profile keeps the plain dashboard names.
              const label = publicFullView
                ? sectionLabel[section]
                : section === 'mints' && mintsFallback
                  ? 'Recent Mints'
                  : showcaseSectionLabel[section]
              return (
                <div key={section} className="border-t border-line">
                  {/* Public sections don't collapse — always expanded, no chevron. */}
                  <h2 className="py-4 text-xs font-mono text-dim uppercase tracking-wider">
                    {label}{count !== null ? ` (${count})` : ''}
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

      {/* Owner-only agent surfaces (replacing the former global "Agent" nav
          tab): the autonomous Agent Collect setup + the Base MCP skill entry.
          Placed AFTER the artwork sections — the profile leads with the art;
          tools trail it (artist feedback). Owner chrome — hidden while
          previewing the public view. Both self-gate on smart-wallet
          eligibility, so an EOA owner sees neither. */}
      {isOwner && !previewPublic && (
        <div className="mt-4 grid grid-cols-1 items-stretch gap-3 sm:grid-cols-2">
          <AgentCollectEntry />
          <AgentSkillCard />
        </div>
      )}
    </div>
  )
}
