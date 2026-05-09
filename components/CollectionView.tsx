'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount, usePublicClient, useReadContract } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { ArrowLeft, Star, Eye, EyeOff, ShieldCheck, Trash2 } from 'lucide-react'
import { resolveUri, shortAddress, type Moment, type MomentAdmin } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { toastError } from '@/lib/toast'
import { useAdmin } from '@/contexts/AdminContext'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { useGrantPermission } from '@/hooks/useGrantPermission'
import { useCollectionMinters } from '@/hooks/useCollectionMinters'
import { useAuthorizedCreators } from '@/hooks/useAuthorizedCreators'
import { fetchInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { COLLECTION_ABI } from '@/lib/collections'
import { hasAdminBit, hasMinterBit } from '@/lib/permissions'
import { MomentCard } from './MomentCard'
import { ProfileAvatar } from './ProfileAvatar'

interface AvatarProfile {
  name: string
  avatarUrl?: string
}

function AvatarRow({
  addr,
  profiles,
}: {
  addr: string
  profiles: Record<string, AvatarProfile>
}) {
  const p = profiles[addr.toLowerCase()]
  return (
    <Link
      href={`/profile/${addr}`}
      className="flex items-center gap-2.5 border border-[#2a2a2a] hover:border-[#555] px-3 py-2 transition-colors w-full sm:w-auto"
    >
      <ProfileAvatar address={addr} avatarUrl={p?.avatarUrl} size={24} />
      <span className="text-xs font-mono text-[#888] truncate">
        {p?.name || shortAddress(addr)}
      </span>
    </Link>
  )
}

interface CollectionViewProps {
  address: string
  collectionName?: string
  collectionImage?: string
  collectionDescription?: string
  // Whether this collection was deployed through our platform (KV-tracked).
  // Used to distinguish "empty — indexing" from "empty — truly nothing here".
  isTracked?: boolean
  defaultAdminUsername?: string
  defaultAdminAddress?: string
  payoutRecipient?: string
  createdAt?: string
  initialHidden?: boolean
}

function formatCreatedDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return ''
  }
}

export function CollectionView({
  address,
  collectionName,
  collectionImage,
  collectionDescription,
  isTracked = false,
  defaultAdminUsername,
  defaultAdminAddress,
  payoutRecipient,
  createdAt,
  initialHidden = false,
}: CollectionViewProps) {
  const router = useRouter()
  const { address: connectedAddress } = useAccount()
  const { isAdmin, featuredCollectionAddrs, toggleFeaturedCollection } = useAdmin()
  const [profiles, setProfiles] = useState<Record<string, AvatarProfile>>({})
  const [hidden, setHidden] = useState(initialHidden)
  const [resolvedAdminName, setResolvedAdminName] = useState<string | null>(
    defaultAdminUsername
      ? `@${defaultAdminUsername}`
      : defaultAdminAddress
        ? null  // resolve via profile cache below
        : null
  )
  // Moments fetched client-side so the header renders immediately from server
  // data, and hidden-moment filtering is applied via the session-aware
  // /api/timeline route (creator sees their own hidden moments; others don't).
  const [moments, setMoments] = useState<Moment[] | null>(null)
  const [hidePending, setHidePending] = useState(false)
  const { ensureSession } = useUploadSession()

  const isFeatured = featuredCollectionAddrs.has(address.toLowerCase())
  const isCreator =
    !!connectedAddress &&
    !!defaultAdminAddress &&
    connectedAddress.toLowerCase() === defaultAdminAddress.toLowerCase()

  // The Authorize banner used to render only for the displayed creator
  // (the address inprocess returns as defaultAdmin). That misses a real
  // case: when a platform operator deployed a collection on an artist's
  // behalf, the operator stayed as on-chain admin while the artist is
  // shown as the creator. The chain enforces that only the actual admin
  // can call addPermission, so we read the connected viewer's own
  // permissions and let any wallet with on-chain ADMIN trigger the
  // grant — not just the displayed creator. The grantee is still
  // resolved from defaultAdminAddress (we authorize the artist's smart
  // wallet, regardless of who's signing the tx).
  const { data: viewerPerms } = useReadContract({
    address: address as `0x${string}`,
    abi: COLLECTION_ABI,
    functionName: 'permissions',
    args: connectedAddress ? [0n, connectedAddress as `0x${string}`] : undefined,
    query: { enabled: !!connectedAddress },
  })
  const viewerHasAdmin =
    viewerPerms !== undefined && hasAdminBit(viewerPerms as bigint)
  const canGrantHere = isCreator || viewerHasAdmin
  // MINTER-only viewers (granted via the "Authorize minters" panel by
  // an admin) can call adminMint directly — that's what Zora's MINTER
  // bit unlocks. They CAN'T setupNewToken (that's ADMIN-only), so the
  // chip routes them to the Airdrop tab where adminMint actually lives.
  const viewerHasMinter =
    viewerPerms !== undefined && hasMinterBit(viewerPerms as bigint)

  // Resolve the *connected viewer's* inprocess smart wallet so we can
  // surface the creator-tier chip. MintForm relays through inprocess
  // and the actor on chain is the smart wallet, not the EOA — so a
  // creator authorization grants ADMIN to the smart wallet, and the
  // chip's gate has to read the smart wallet's perms (not the EOA's).
  const { address: viewerSmartWallet } = useInprocessSmartWallet(connectedAddress)
  const { data: viewerSmartWalletPerms } = useReadContract({
    address: address as `0x${string}`,
    abi: COLLECTION_ABI,
    functionName: 'permissions',
    args:
      viewerSmartWallet && isAddress(viewerSmartWallet)
        ? [0n, viewerSmartWallet as `0x${string}`]
        : undefined,
    query: {
      enabled: !!viewerSmartWallet && isAddress(viewerSmartWallet),
    },
  })
  const viewerSmartWalletHasAdmin =
    viewerSmartWalletPerms !== undefined &&
    hasAdminBit(viewerSmartWalletPerms as bigint)

  // Tier resolution for the chip: creator wins over minter — ADMIN is
  // a strict superset of MINTER for mint flows. Drop both chips for
  // viewers who already see the full authorize panel below.
  const showCreatorChip = !canGrantHere && viewerSmartWalletHasAdmin
  const showMinterChip = !canGrantHere && !showCreatorChip && viewerHasMinter

  // Retroactive authorize flow — for collections deployed before we
  // started granting the artist's inprocess smart wallet ADMIN as a
  // setupAction. The smart wallet on inprocess is per-EOA, so we look
  // up the wallet bound to *this collection's creator*
  // (defaultAdminAddress) — that's the wallet whose ADMIN status the
  // banner is gating on, and that's the grantee on the addPermission
  // tx fired from canGrantHere viewers.
  const { address: inprocessSmartWallet } = useInprocessSmartWallet(
    defaultAdminAddress,
  )
  const inprocessConfigured =
    !!inprocessSmartWallet && isAddress(inprocessSmartWallet)
  const { data: inprocessPerms, refetch: refetchInprocessPerms } = useReadContract({
    address: address as `0x${string}`,
    abi: COLLECTION_ABI,
    functionName: 'permissions',
    args: inprocessConfigured
      ? [0n, inprocessSmartWallet as `0x${string}`]
      : undefined,
    query: { enabled: inprocessConfigured && canGrantHere },
  })
  const inprocessIsAdmin =
    inprocessPerms !== undefined && hasAdminBit(inprocessPerms as bigint)
  const showAuthorize = canGrantHere && inprocessConfigured && inprocessPerms !== undefined && !inprocessIsAdmin

  // Centralized addPermission flow — same hook AirdropForm uses. Banner
  // grants the smart wallet ADMIN at tokenId 0 (collection-wide) since
  // the user is defaultAdmin of their own collections.
  const {
    grant,
    reset: resetGrant,
    busy: authorizing,
    receipt: authorizeReceipt,
  } = useGrantPermission()

  // Separate hook instance for the post-deploy minter grants — keeps its
  // tx watcher independent of the smart-wallet authorize banner so a
  // pending minter grant doesn't fight with a concurrent banner click.
  const {
    grant: grantMinter,
    revoke: revokeMinter,
    reset: resetMinterGrant,
    busy: minterGranting,
    hash: minterHash,
    receipt: minterReceipt,
  } = useGrantPermission()
  // The hook clears `busy` as soon as a tx is submitted, so on its own
  // it doesn't keep the buttons disabled while the tx is mining — a
  // fast second click would clobber the hash and orphan the first tx.
  // Gate the UI on busy OR (hash set without a receipt) so a tx that's
  // mid-mine still locks the panel.
  const minterTxPending = !!minterHash && !minterReceipt
  const isMinterBusy = minterGranting || minterTxPending
  const [minterInput, setMinterInput] = useState('')
  const [revokingAddr, setRevokingAddr] = useState<string | null>(null)
  // Captures the in-flight action so the receipt effect knows whether
  // a confirmed receipt corresponds to a grant or a revoke. Uses a ref
  // (not state) so the effect can read it without re-firing when we
  // clear revokingAddr inside the effect itself — that's the
  // double-toast trap.
  const pendingMinterActionRef = useRef<'grant' | 'revoke' | null>(null)

  // Live list of MINTER-bit holders, scoped collection-wide. Refetched
  // after every grant/revoke confirms so the panel mirrors chain state
  // without a manual reload.
  const {
    minters: authorizedMinters,
    loading: mintersLoading,
    refetch: refetchMinters,
  } = useCollectionMinters(canGrantHere ? (address as `0x${string}`) : undefined)

  // ─── Authorized creators (ADMIN tier) ───────────────────────────────
  // Distinct from minters: granting ADMIN to the target's smart wallet
  // unlocks setupNewToken (mint into the collection via MintForm).
  // MINTER bit only unlocks adminMint, which is the airdrop flow. We
  // use a separate hook instance to keep the watchers independent —
  // the user can fire creator + minter grants in interleaved order
  // without one's receipt clobbering the other's.
  const {
    grantBatch: grantCreatorBatch,
    revokeBatch: revokeCreatorBatch,
    reset: resetCreatorGrant,
    busy: creatorGranting,
    hash: creatorHash,
    receipt: creatorReceipt,
  } = useGrantPermission()
  const creatorTxPending = !!creatorHash && !creatorReceipt
  const isCreatorBusy = creatorGranting || creatorTxPending
  const [creatorInput, setCreatorInput] = useState('')
  const [revokingCreatorEoa, setRevokingCreatorEoa] = useState<string | null>(null)
  // Tracks the in-flight {EOA, smartWallet, label} so the receipt
  // effect can call /api/collection/authorized-creators after the tx
  // confirms. Ref vs state for the same reason as the minter ref.
  const pendingCreatorRef = useRef<
    | { kind: 'grant'; eoa: string; smartWallet: string; label?: string }
    | { kind: 'revoke'; eoa: string }
    | null
  >(null)
  const {
    creators: authorizedCreators,
    loading: creatorsLoading,
    refetch: refetchCreators,
  } = useAuthorizedCreators(canGrantHere ? (address as `0x${string}`) : undefined)

  // Mainnet client for client-side ENS resolution. Wagmi already
  // configures a mainnet transport for ENS (lib/wagmi.ts), so we reuse
  // it instead of standing up a duplicate viem client. Falls through to
  // strict 0x validation when the read fails (offline, RPC blip, .eth
  // record missing).
  const mainnetClient = usePublicClient({ chainId: mainnet.id })
  async function resolveMinterInput(raw: string): Promise<`0x${string}` | null> {
    const trimmed = raw.trim()
    if (isAddress(trimmed)) return trimmed.toLowerCase() as `0x${string}`
    if (trimmed.endsWith('.eth') && mainnetClient) {
      try {
        const resolved = await mainnetClient.getEnsAddress({ name: trimmed })
        return resolved ? (resolved.toLowerCase() as `0x${string}`) : null
      } catch {
        return null
      }
    }
    return null
  }

  useEffect(() => {
    if (!minterReceipt) return
    // Read+clear the pending action ref so a stale receipt persisting
    // in wagmi's cache after resetMinterGrant() can't re-fire the toast.
    const action = pendingMinterActionRef.current
    if (!action) return
    pendingMinterActionRef.current = null
    const wasRevoke = action === 'revoke'
    resetMinterGrant()
    setRevokingAddr(null)
    if (minterReceipt.status === 'reverted') {
      toast.error(wasRevoke ? 'Revoke failed' : 'Authorize failed', {
        id: 'authorize-minter',
        description: 'The transaction reverted on-chain — only collection admins can change minter permissions.',
      })
      return
    }
    if (!wasRevoke) setMinterInput('')
    toast.success(wasRevoke ? 'Minter revoked' : 'Minter authorized', { id: 'authorize-minter' })
    void refetchMinters()
  }, [minterReceipt, resetMinterGrant, refetchMinters])

  async function handleAuthorizeMinter() {
    const raw = minterInput.trim()
    if (!raw) return
    try {
      toast.loading('Resolving address…', { id: 'authorize-minter' })
      const target = await resolveMinterInput(raw)
      if (!target) {
        toast.error(
          raw.endsWith('.eth')
            ? `Could not resolve ${raw}`
            : 'Invalid address — paste a 0x… or vitalik.eth name',
          { id: 'authorize-minter' },
        )
        return
      }
      toast.loading('Confirm in wallet…', { id: 'authorize-minter' })
      const outcome = await grantMinter({
        collection: address as `0x${string}`,
        grantee: target,
        tokenId: 0n,
        bit: 'minter',
      })
      if (outcome === 'submitted') {
        pendingMinterActionRef.current = 'grant'
        toast.loading('Authorizing minter…', { id: 'authorize-minter' })
        return
      }
      // Already had MINTER on chain — refetch so the list shows them
      // immediately even if our log scan hadn't caught up yet.
      setMinterInput('')
      toast.success('Already a minter on this collection', { id: 'authorize-minter' })
      void refetchMinters()
    } catch (err) {
      toastError('Authorize minter', err, { id: 'authorize-minter' })
    }
  }

  async function handleRevokeMinter(target: `0x${string}`) {
    if (isMinterBusy) return
    setRevokingAddr(target.toLowerCase())
    try {
      toast.loading('Confirm in wallet…', { id: 'authorize-minter' })
      const outcome = await revokeMinter({
        collection: address as `0x${string}`,
        grantee: target,
        tokenId: 0n,
        bit: 'minter',
      })
      if (outcome === 'submitted') {
        pendingMinterActionRef.current = 'revoke'
        toast.loading('Revoking minter…', { id: 'authorize-minter' })
        return
      }
      // Bit wasn't set on chain — refetch to drop them from the list.
      setRevokingAddr(null)
      toast.success('Already not a minter', { id: 'authorize-minter' })
      void refetchMinters()
    } catch (err) {
      setRevokingAddr(null)
      toastError('Revoke minter', err, { id: 'authorize-minter' })
    }
  }

  // ─── Authorize creators (ADMIN to smart wallet) ─────────────────────
  async function handleAuthorizeCreator() {
    if (isCreatorBusy) return
    const raw = creatorInput.trim()
    if (!raw) return
    try {
      toast.loading('Resolving address…', { id: 'authorize-creator' })
      const eoa = await resolveMinterInput(raw)
      if (!eoa) {
        toast.error(
          raw.endsWith('.eth')
            ? `Could not resolve ${raw}`
            : 'Invalid address — paste a 0x… or vitalik.eth name',
          { id: 'authorize-creator' },
        )
        return
      }
      // Resolve the target's inprocess smart wallet — that's the
      // actor MintForm relays through, so it's where ADMIN must land.
      // If inprocess can't resolve it (almost never — the lookup is
      // deterministic from the EOA), block the grant rather than
      // ship a half-authorization that mints would silently fail on.
      toast.loading('Resolving mint wallet…', { id: 'authorize-creator' })
      const smartWallet = await fetchInprocessSmartWallet(eoa)
      if (!smartWallet || !isAddress(smartWallet)) {
        toast.error(
          'Could not resolve a mint wallet for that address — try again in a moment',
          { id: 'authorize-creator' },
        )
        return
      }
      const swLower = smartWallet.toLowerCase() as `0x${string}`
      const label = raw.endsWith('.eth') ? raw : undefined
      toast.loading('Confirm in wallet…', { id: 'authorize-creator' })
      const outcome = await grantCreatorBatch([
        // ADMIN to smart wallet → unlocks setupNewToken via MintForm.
        { collection: address as `0x${string}`, grantee: swLower, tokenId: 0n, bit: 'admin' },
        // MINTER to EOA → unlocks adminMint from the user's own
        // wallet, so the same authorization also works for direct
        // airdrops without going through the inprocess relay.
        { collection: address as `0x${string}`, grantee: eoa, tokenId: 0n, bit: 'minter' },
      ])
      if (outcome === 'submitted') {
        pendingCreatorRef.current = { kind: 'grant', eoa, smartWallet: swLower, label }
        toast.loading('Authorizing creator…', { id: 'authorize-creator' })
        return
      }
      // Both bits were already set on chain. Persist the KV mapping
      // anyway so the list shows the entry — without it, a re-grant
      // under the same admin would never visibly land.
      try {
        await fetch('/api/collection/authorized-creators', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collection: address,
            eoa,
            smartWallet: swLower,
            label,
          }),
        })
      } catch {
        // KV write failure is non-fatal; the chain grant exists.
      }
      setCreatorInput('')
      toast.success('Already an authorized creator', { id: 'authorize-creator' })
      void refetchCreators()
    } catch (err) {
      toastError('Authorize creator', err, { id: 'authorize-creator' })
    }
  }

  async function handleRevokeCreator(eoa: string, smartWallet: string) {
    if (isCreatorBusy) return
    setRevokingCreatorEoa(eoa.toLowerCase())
    try {
      toast.loading('Confirm in wallet…', { id: 'authorize-creator' })
      const outcome = await revokeCreatorBatch([
        {
          collection: address as `0x${string}`,
          grantee: smartWallet as `0x${string}`,
          tokenId: 0n,
          bit: 'admin',
        },
        {
          collection: address as `0x${string}`,
          grantee: eoa as `0x${string}`,
          tokenId: 0n,
          bit: 'minter',
        },
      ])
      if (outcome === 'submitted') {
        pendingCreatorRef.current = { kind: 'revoke', eoa }
        toast.loading('Revoking creator…', { id: 'authorize-creator' })
        return
      }
      // Both bits already cleared on chain — drop the KV row directly
      // so the UI doesn't keep showing a stale entry.
      try {
        await fetch(
          `/api/collection/authorized-creators?collection=${address}&eoa=${eoa}`,
          { method: 'DELETE' },
        )
      } catch {}
      setRevokingCreatorEoa(null)
      toast.success('Already not authorized', { id: 'authorize-creator' })
      void refetchCreators()
    } catch (err) {
      setRevokingCreatorEoa(null)
      toastError('Revoke creator', err, { id: 'authorize-creator' })
    }
  }

  useEffect(() => {
    if (!creatorReceipt) return
    const action = pendingCreatorRef.current
    if (!action) return
    pendingCreatorRef.current = null
    resetCreatorGrant()
    setRevokingCreatorEoa(null)
    if (creatorReceipt.status === 'reverted') {
      toast.error(
        action.kind === 'revoke' ? 'Revoke failed' : 'Authorize failed',
        {
          id: 'authorize-creator',
          description:
            'The transaction reverted on-chain — only collection admins can change creator permissions.',
        },
      )
      return
    }
    // On success, reconcile KV so the list reflects the new state.
    void (async () => {
      try {
        if (action.kind === 'grant') {
          await fetch('/api/collection/authorized-creators', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              collection: address,
              eoa: action.eoa,
              smartWallet: action.smartWallet,
              label: action.label,
            }),
          })
          setCreatorInput('')
        } else {
          await fetch(
            `/api/collection/authorized-creators?collection=${address}&eoa=${action.eoa}`,
            { method: 'DELETE' },
          )
        }
      } catch {
        // KV write failure surfaces only as a stale row; the chain
        // state is correct, and the next grant/revoke will reconcile.
      } finally {
        toast.success(
          action.kind === 'revoke' ? 'Creator revoked' : 'Creator authorized',
          { id: 'authorize-creator' },
        )
        void refetchCreators()
      }
    })()
  }, [creatorReceipt, resetCreatorGrant, refetchCreators, address])

  // When the authorize tx confirms, refetch the permission read so the
  // banner hides itself without a manual reload.
  useEffect(() => {
    if (!authorizeReceipt) return
    resetGrant()
    if (authorizeReceipt.status === 'reverted') {
      toast.error('Authorize failed', { id: 'authorize', description: 'The transaction reverted on-chain.' })
      return
    }
    void refetchInprocessPerms()
    toast.success('Kismet authorized — minting now works for this collection', { id: 'authorize' })
  }, [authorizeReceipt, refetchInprocessPerms, resetGrant])

  async function handleAuthorize() {
    if (!connectedAddress || !inprocessConfigured || !inprocessSmartWallet) return
    try {
      toast.loading('Confirm in wallet…', { id: 'authorize' })
      const outcome = await grant({
        collection: address as `0x${string}`,
        grantee: inprocessSmartWallet as `0x${string}`,
        tokenId: 0n,
        bit: 'admin',
      })
      if (outcome === 'submitted') {
        toast.loading('Authorizing…', { id: 'authorize' })
        return
      }
      // Already had ADMIN on chain — refetch so the banner hides
      // immediately instead of waiting for the (nonexistent) tx.
      void refetchInprocessPerms()
      toast.success('Kismet already authorized for this collection', { id: 'authorize' })
    } catch (err) {
      toastError('Authorize', err, { id: 'authorize' })
    }
  }

  async function handleToggleHidden() {
    if (hidePending) return
    const next = !hidden
    setHidePending(true)
    try {
      // /api/collection/hide reads the Kismet session cookie. Wallet-connect
      // alone doesn't create one — ensureSession prompts a one-time
      // signature when the cookie is missing.
      await ensureSession()
      const res = await fetch('/api/collection/hide', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, hidden: next }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Hide failed')
      }
      setHidden(next)
      toast.success(next ? 'Collection hidden from public' : 'Collection visible again', { id: 'collection-hide' })
    } catch (err) {
      toastError('Hide', err, { id: 'collection-hide' })
    } finally {
      setHidePending(false)
    }
  }

  // Fetch moments client-side. This keeps the server render fast (header data
  // only) and ensures hidden-moment filtering is applied via the session-aware
  // timeline route. Creator sees their own hidden moments; others don't.
  useEffect(() => {
    let cancelled = false
    setMoments(null) // reset to loading when address changes
    fetch(`/api/timeline?collection=${address}&limit=50`)
      .then((r) => (r.ok ? r.json() : { moments: [] }))
      .then((d) => {
        if (cancelled) return
        const loaded: Moment[] = Array.isArray(d.moments) ? d.moments : []
        setMoments(loaded)
        // Fetch profiles for all creators and split admins found in moments
        const creatorSet = new Set(loaded.map((m) => m.creator.address.toLowerCase()))
        const adminAddrs = new Set(
          loaded
            .flatMap((m) => m.admins ?? [])
            .filter((a) => !creatorSet.has(a.address.toLowerCase()))
            .map((a) => a.address.toLowerCase()),
        )
        ;[...creatorSet, ...adminAddrs].forEach((addr) => {
          fetchCreatorProfile(addr).then(({ name, avatarUrl }) => {
            if (!cancelled)
              setProfiles((prev) => ({ ...prev, [addr]: { name, avatarUrl } }))
          })
        })
      })
      .catch(() => { if (!cancelled) setMoments([]) })
    return () => { cancelled = true }
  }, [address])

  // Resolve the collection creator's display name from our platform profile
  // cache. Inprocess only returns a username when one is set in their system;
  // our Redis cache may have a name the user registered with us. Always
  // check Kismet — if it has a resolved username it wins over inprocess's
  // (Kismet is the surface the user updates here). When Kismet returns
  // its shortAddress fallback, we keep whatever inprocess seeded so we
  // don't downgrade an inprocess username back to a raw address.
  useEffect(() => {
    if (!defaultAdminAddress) return
    fetchCreatorProfile(defaultAdminAddress).then(({ name }) => {
      const isUsername = !!name && name !== shortAddress(defaultAdminAddress)
      if (isUsername) {
        setResolvedAdminName(`@${name}`)
      } else if (!defaultAdminUsername) {
        setResolvedAdminName(name || shortAddress(defaultAdminAddress))
      }
    })
  }, [defaultAdminAddress, defaultAdminUsername])

  const loadedMoments = moments ?? []
  const displayName = collectionName || shortAddress(address)
  const firstMoment = loadedMoments[0]
  const rawImgUrl = collectionImage || firstMoment?.metadata?.image
  const imgUrl = rawImgUrl ? resolveUri(rawImgUrl) : null
  const description = collectionDescription

  // Unique creator addresses across all loaded moments
  const uniqueCreators = Array.from(
    new Set(loadedMoments.map((m) => m.creator.address.toLowerCase()))
  )

  // Unique split admin addresses (from moment admins, excluding moment creators)
  const uniqueAdmins = Array.from(
    loadedMoments
      .flatMap((m) => m.admins ?? [])
      .reduce((map, admin) => {
        const lower = admin.address.toLowerCase()
        if (!uniqueCreators.includes(lower)) map.set(lower, admin)
        return map
      }, new Map<string, MomentAdmin>())
      .values()
  )

  const indexing = isTracked && moments !== null && loadedMoments.length === 0

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1.5 text-xs font-mono text-[#555] hover:text-[#888] transition-colors mb-8"
      >
        <ArrowLeft size={12} />
        back
      </button>

      {/* Creator-only banner so the creator knows their collection is hidden */}
      {hidden && isCreator && (
        <div className="px-3 py-2 mb-6 border border-[#2a2a2a] bg-[#1a1a1a] flex items-center gap-2">
          <EyeOff size={11} className="text-[#888]" />
          <p className="text-[10px] font-mono text-[#888] uppercase tracking-widest">
            hidden from public — only you can see this
          </p>
        </div>
      )}

      {/* Collection header */}
      <div className="flex gap-5 mb-10">
        <div className="relative w-24 h-24 sm:w-32 sm:h-32 flex-shrink-0 bg-[#111] border border-[#2a2a2a] overflow-hidden">
          {imgUrl ? (
            <Image
              src={imgUrl}
              alt={displayName}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 96px, 128px"
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-[#2a2a2a] font-mono text-[10px]">no image</span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5 min-w-0 pt-1">
          <h1 className="text-base font-mono text-[#efefef] truncate">
            {displayName}
          </h1>
          {defaultAdminAddress ? (
            <Link
              href={`/profile/${defaultAdminAddress}`}
              className="text-[10px] font-mono text-[#444] hover:text-[#888] transition-colors w-fit"
            >
              {resolvedAdminName ?? shortAddress(defaultAdminAddress)}
            </Link>
          ) : (
            <p className="text-[10px] font-mono text-[#444]">{shortAddress(address)}</p>
          )}
          {/* Enriched chips: payout transparency (only when it differs from
              the admin — same-address payouts are noise) and creation date. */}
          {(payoutRecipient || createdAt) && (
            <div className="flex flex-wrap gap-2 mt-1.5">
              {createdAt && (
                <span className="text-[10px] font-mono text-[#555] uppercase tracking-widest">
                  created {formatCreatedDate(createdAt)}
                </span>
              )}
              {payoutRecipient && (
                <Link
                  href={`/profile/${payoutRecipient}`}
                  className="text-[10px] font-mono text-[#555] hover:text-[#888] uppercase tracking-widest transition-colors"
                  title="Sale proceeds route here"
                >
                  payouts → {shortAddress(payoutRecipient)}
                </Link>
              )}
            </div>
          )}
          {/* Authorization chip: surfaces a viewer's mint capability
              on a collection they don't own. Two tiers, mutually
              exclusive (creator wins). Hidden for creators / admins,
              who already see the full Authorize panel below. */}
          {showCreatorChip && (
            <Link
              href={{
                pathname: '/mint',
                query: {
                  collection: address,
                  ...(displayName ? { name: displayName } : {}),
                },
              }}
              className="mt-2 inline-flex items-center gap-1.5 self-start border border-[#8B5CF6]/40 bg-[#8B5CF6]/5 hover:border-[#8B5CF6] hover:bg-[#8B5CF6]/10 px-2.5 py-1 transition-colors"
              title="Your mint wallet holds ADMIN here — create new moments via MintForm"
            >
              <ShieldCheck size={11} className="text-[#8B5CF6]" />
              <span className="text-[10px] font-mono text-[#efefef] uppercase tracking-widest">
                you can mint here →
              </span>
            </Link>
          )}
          {showMinterChip && (
            <Link
              href={{
                pathname: '/mint',
                query: {
                  tab: 'airdrop',
                  collection: address,
                  ...(displayName ? { name: displayName } : {}),
                },
              }}
              className="mt-2 inline-flex items-center gap-1.5 self-start border border-[#8B5CF6]/40 bg-[#8B5CF6]/5 hover:border-[#8B5CF6] hover:bg-[#8B5CF6]/10 px-2.5 py-1 transition-colors"
              title="You hold MINTER on this collection — airdrop copies via the Airdrop tab"
            >
              <ShieldCheck size={11} className="text-[#8B5CF6]" />
              <span className="text-[10px] font-mono text-[#efefef] uppercase tracking-widest">
                you can airdrop here →
              </span>
            </Link>
          )}
          {description && (
            <p className="text-xs font-mono text-[#555] mt-1 line-clamp-3">{description}</p>
          )}
          <div className="flex items-center gap-3 mt-2">
            {isAdmin && (
              <button
                onClick={() => toggleFeaturedCollection(address)}
                className={`flex items-center gap-1.5 text-xs font-mono transition-colors ${
                  isFeatured ? 'text-yellow-400' : 'text-[#555] hover:text-[#888]'
                }`}
                title={isFeatured ? 'Unfeature collection' : 'Feature collection'}
              >
                <Star size={12} fill={isFeatured ? 'currentColor' : 'none'} strokeWidth={1.5} />
                {isFeatured ? 'unfeature' : 'feature'}
              </button>
            )}
            {isCreator && (
              <button
                onClick={handleToggleHidden}
                disabled={hidePending}
                className={`flex items-center gap-1.5 text-xs font-mono transition-colors disabled:opacity-50 ${
                  hidden ? 'text-[#888] hover:text-[#efefef]' : 'text-[#555] hover:text-[#888]'
                }`}
                title={hidden ? 'Show collection on public feeds' : 'Hide collection from public feeds'}
              >
                {hidden ? <Eye size={12} /> : <EyeOff size={12} />}
                {hidden ? 'hidden' : 'hide'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Authorize banner — surfaces when a collection predates the
          inprocess-admin grant we now bake into deploy. Renders for
          any wallet with on-chain ADMIN (creator OR a platform
          operator who deployed on the artist's behalf), only when
          the grant is actually missing. */}
      {showAuthorize && (
        <div className="mb-8 p-3 sm:p-4 border border-[#8B5CF6]/40 bg-[#8B5CF6]/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <ShieldCheck size={16} className="text-[#8B5CF6] flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-mono text-[#efefef]">
                Authorize Kismet to mint into this collection
              </p>
              <p className="text-[11px] font-mono text-[#888] mt-0.5">
                One-time onchain grant. Required because this collection was deployed before our minting upgrade.
              </p>
            </div>
          </div>
          <button
            onClick={handleAuthorize}
            disabled={authorizing}
            className="flex-shrink-0 text-xs font-mono tracking-wider uppercase px-4 py-2 btn-accent disabled:opacity-50"
          >
            {authorizing ? 'authorizing…' : 'authorize'}
          </button>
        </div>
      )}

      {/* Authorize creators — post-deploy ADMIN grant. Two on-chain
          writes batched via multicall: ADMIN to the target's inprocess
          smart wallet (so MintForm relays land setupNewToken) AND
          MINTER to their EOA (so the same authorization also enables
          adminMint from their own wallet for direct airdrops). Display
          rides on a KV mapping written at grant time — inprocess only
          resolves EOA → smart wallet, so without it we'd render raw
          contract addresses the admin doesn't recognize. */}
      {canGrantHere && (
        <div className="mb-4 p-3 sm:p-4 border border-[#2a2a2a] bg-[#0d0d0d]">
          <div className="flex items-center gap-1.5 mb-2">
            <ShieldCheck size={12} className="text-[#888]" />
            <p className="text-xs font-mono text-[#888] uppercase tracking-wider">
              Authorize creators
            </p>
          </div>
          <p className="text-[11px] font-mono text-[#555] mb-3">
            Grant another wallet permission to mint new tokens into this collection. Full ADMIN access — they can also airdrop, manage permissions, and configure sales. ENS names work.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={creatorInput}
              onChange={(e) => setCreatorInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                e.preventDefault()
                void handleAuthorizeCreator()
              }}
              placeholder="0x… or vitalik.eth"
              className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
            />
            <button
              type="button"
              onClick={() => void handleAuthorizeCreator()}
              disabled={isCreatorBusy || !creatorInput.trim()}
              className="px-4 text-[10px] font-mono tracking-wider uppercase border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-50"
            >
              {isCreatorBusy && !revokingCreatorEoa ? 'authorizing…' : 'authorize'}
            </button>
          </div>
          {creatorsLoading && authorizedCreators.length === 0 ? (
            <ul className="mt-3 flex flex-col gap-1" aria-busy="true">
              {[0, 1].map((i) => (
                <li
                  key={i}
                  className="flex items-center justify-between bg-[#111] border border-[#1a1a1a] px-3 py-2 animate-pulse"
                >
                  <span className="h-3 w-32 bg-[#1a1a1a]" />
                  <span className="h-3 w-3 bg-[#1a1a1a] flex-shrink-0" />
                </li>
              ))}
            </ul>
          ) : (
            authorizedCreators.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1">
                {authorizedCreators.map((c) => {
                  const eoaLower = c.eoa.toLowerCase()
                  const isRevoking = revokingCreatorEoa === eoaLower
                  const otherTxBusy = isCreatorBusy && !isRevoking
                  return (
                    <li
                      key={eoaLower}
                      className={`flex items-center justify-between bg-[#111] border px-3 py-2 ${
                        c.liveOnChain ? 'border-[#2a2a2a]' : 'border-[#1a1a1a] opacity-60'
                      }`}
                      title={
                        c.liveOnChain
                          ? `${c.label ?? c.eoa} → ${c.smartWallet}`
                          : 'Stale — ADMIN was revoked outside this UI'
                      }
                    >
                      <span className="text-xs font-mono text-[#888] truncate">
                        {c.label ?? shortAddress(c.eoa)}
                        {!c.liveOnChain && (
                          <span className="ml-2 text-[#555]">(stale)</span>
                        )}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleRevokeCreator(c.eoa, c.smartWallet)}
                        disabled={otherTxBusy || isRevoking}
                        title="Revoke creator authorization"
                        className="ml-2 text-[#555] hover:text-[#efefef] disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                      >
                        <Trash2 size={12} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )
          )}
        </div>
      )}

      {/* Authorize minters — post-deploy MINTER grants for this
          collection. Visible to anyone with on-chain ADMIN (chain
          enforces the same gate on addPermission). The grant is at
          tokenId 0 so the address can mint copies of any token,
          present and future. ADMIN bit is reserved for the inprocess
          smart wallet (handled by the banner above). */}
      {canGrantHere && (
        <div className="mb-8 p-3 sm:p-4 border border-[#2a2a2a] bg-[#0d0d0d]">
          <div className="flex items-center gap-1.5 mb-2">
            <ShieldCheck size={12} className="text-[#888]" />
            <p className="text-xs font-mono text-[#888] uppercase tracking-wider">
              Authorize minters
            </p>
          </div>
          <p className="text-[11px] font-mono text-[#555] mb-3">
            Grant another wallet permission to mint copies of any token in this collection. ENS names work.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={minterInput}
              onChange={(e) => setMinterInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleAuthorizeMinter()
                }
              }}
              placeholder="0x… or vitalik.eth"
              className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
            />
            <button
              type="button"
              onClick={() => void handleAuthorizeMinter()}
              disabled={isMinterBusy || !minterInput.trim()}
              className="px-4 text-[10px] font-mono tracking-wider uppercase border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors disabled:opacity-50"
            >
              {isMinterBusy && !revokingAddr ? 'authorizing…' : 'authorize'}
            </button>
          </div>
          {mintersLoading && authorizedMinters.length === 0 ? (
            <ul className="mt-3 flex flex-col gap-1" aria-busy="true">
              {[0, 1].map((i) => (
                <li
                  key={i}
                  className="flex items-center justify-between bg-[#111] border border-[#1a1a1a] px-3 py-2 animate-pulse"
                >
                  <span className="h-3 w-32 bg-[#1a1a1a]" />
                  <span className="h-3 w-3 bg-[#1a1a1a] flex-shrink-0" />
                </li>
              ))}
            </ul>
          ) : (
            authorizedMinters.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1">
                {authorizedMinters.map((m) => {
                  const isRevoking = revokingAddr === m.toLowerCase()
                  const otherTxBusy = isMinterBusy && !isRevoking
                  return (
                    <li
                      key={m}
                      className="flex items-center justify-between bg-[#111] border border-[#2a2a2a] px-3 py-2"
                    >
                      <span className="text-xs font-mono text-[#888] truncate">
                        {shortAddress(m)}
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleRevokeMinter(m)}
                        disabled={otherTxBusy || isRevoking}
                        title="Revoke MINTER permission"
                        className="ml-2 text-[#555] hover:text-[#efefef] disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                      >
                        <Trash2 size={12} />
                      </button>
                    </li>
                  )
                })}
              </ul>
            )
          )}
        </div>
      )}

      {/* Artists */}
      {uniqueCreators.length > 0 && (
        <section className="mb-10">
          <h2 className="text-xs font-mono text-[#555] uppercase tracking-widest mb-4">
            {uniqueCreators.length === 1 ? 'artist' : 'artists'}
          </h2>
          <div className="flex flex-wrap gap-2">
            {uniqueCreators.map((addr) => (
              <AvatarRow key={addr} addr={addr} profiles={profiles} />
            ))}
          </div>
        </section>
      )}

      {/* Splits */}
      {uniqueAdmins.length > 0 && (
        <section className="mb-10">
          <h2 className="text-xs font-mono text-[#555] uppercase tracking-widest mb-4">splits</h2>
          <div className="flex flex-wrap gap-2">
            {uniqueAdmins.map((admin) => (
              <AvatarRow key={admin.address} addr={admin.address} profiles={profiles} />
            ))}
          </div>
        </section>
      )}

      {/* NFT grid */}
      <section>
        <h2 className="text-xs font-mono text-[#555] uppercase tracking-widest mb-4">
          moments{loadedMoments.length > 0 ? ` (${loadedMoments.length})` : ''}
        </h2>
        {moments === null ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="aspect-square bg-[#111] border border-[#1a1a1a] animate-pulse" />
            ))}
          </div>
        ) : loadedMoments.length === 0 ? (
          indexing ? (
            <p className="text-xs font-mono text-[#888]">
              indexing your first mint… can take a few minutes. refresh to check.
            </p>
          ) : (
            <p className="text-xs font-mono text-[#555]">no moments in this collection yet</p>
          )
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {loadedMoments.map((m) => (
              <MomentCard key={m.id || `${m.address}-${m.token_id}`} moment={m} hidePriceSupply />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
