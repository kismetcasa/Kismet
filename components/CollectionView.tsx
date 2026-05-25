'use client'

import { useState, useEffect, useRef } from 'react'
import { MomentImage } from './MomentImage'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount, usePublicClient, useReadContract, useReadContracts } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { ArrowLeft, Star, Eye, EyeOff, ShieldCheck, Trash2, Copy, Check } from 'lucide-react'
import { shortAddress, inferCollectCurrency, type Moment } from '@/lib/inprocess'
import { ZORA_1155_TOKEN_INFO_ABI } from '@/lib/zoraMint'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { toastError } from '@/lib/toast'
import { useAdmin } from '@/contexts/AdminContext'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { useGrantPermission, type PermissionOp } from '@/hooks/useGrantPermission'
import { useAuthorizedCreators } from '@/hooks/useAuthorizedCreators'
import { fetchInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { COLLECTION_ABI } from '@/lib/collections'
import { hasAdminBit, hasMinterBit } from '@/lib/permissions'
import { resolveAddressOrEns } from '@/lib/address'
import { MomentCard } from './MomentCard'
import { MaybeLazy } from './LazyMount'
import { ProfileAvatar } from './ProfileAvatar'
import { CollectAllAction } from './CollectAllAction'
import { useFarcaster } from '@/providers/FarcasterProvider'

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
      className="flex items-center gap-2 sm:gap-2.5 border border-line hover:border-muted px-2.5 sm:px-3 py-2 transition-colors w-full sm:w-auto"
    >
      <span className="shrink-0">
        <ProfileAvatar address={addr} avatarUrl={p?.avatarUrl} size={24} />
      </span>
      <span className="text-xs font-mono text-dim truncate min-w-0">
        {p?.name || shortAddress(addr)}
      </span>
    </Link>
  )
}

interface CollectionViewProps {
  address: string
  collectionName?: string
  collectionImage?: string
  collectionThumbhash?: string
  collectionDescription?: string
  // Whether this collection was deployed through our platform (KV-tracked).
  // Used to distinguish "empty — indexing" from "empty — truly nothing here".
  isTracked?: boolean
  defaultAdminUsername?: string
  defaultAdminAddress?: string
  payoutRecipient?: string
  createdAt?: string
  initialHidden?: boolean
  /** Server-passed UA flag. When true, moments grid beyond
   *  EAGER_MOUNT_COUNT items defers mount via LazyMount. Default
   *  false — desktop callers render the grid eagerly, unchanged. */
  isMobile?: boolean
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
  collectionThumbhash,
  collectionDescription,
  isTracked = false,
  defaultAdminUsername,
  defaultAdminAddress,
  payoutRecipient,
  createdAt,
  initialHidden = false,
  isMobile = false,
}: CollectionViewProps) {
  const router = useRouter()
  const { address: connectedAddress } = useAccount()
  const { isAdmin, featuredCollectionAddrs, toggleFeaturedCollection } = useAdmin()
  const { isInMiniApp } = useFarcaster()
  const [profiles, setProfiles] = useState<Record<string, AvatarProfile>>({})
  const [hidden, setHidden] = useState(initialHidden)
  const [linkCopied, setLinkCopied] = useState(false)
  const [resolvedAdminName, setResolvedAdminName] = useState<string | null>(
    defaultAdminUsername ? `@${defaultAdminUsername}` : null,
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

  // Authorize-creators panel is restricted to the deployer
  // (defaultAdmin). Delegated admins still hold ADMIN on chain and
  // could `addPermission` from etherscan, but the UI doesn't surface
  // that — keeps "who can add other artists here" a single, clear
  // role. Authorized artists land on the creator chip → MintForm
  // instead, which is the surface that actually matters to them.
  const canGrantHere = isCreator
  // We still read the viewer's EOA perms — needed for the legacy
  // MINTER chip that surfaces existing on-chain MINTER grants.
  const { data: viewerPerms } = useReadContract({
    address: address as `0x${string}`,
    abi: COLLECTION_ABI,
    functionName: 'permissions',
    args: connectedAddress ? [0n, connectedAddress as `0x${string}`] : undefined,
    query: { enabled: !!connectedAddress },
  })
  // MINTER-only viewers can adminMint but not setupNewToken, so their
  // chip routes to the Airdrop tab.
  const viewerHasMinter =
    viewerPerms !== undefined && hasMinterBit(viewerPerms as bigint)

  // Creator-tier chip reads the smart wallet's perms, since MintForm
  // relays through inprocess and the on-chain actor is the SW.
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

  // Creator wins over minter (ADMIN ⊃ MINTER). Both chips suppressed
  // for viewers who already see the authorize panels.
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

  // ─── Authorized creators (ADMIN tier) ───────────────────────────────
  // The collection-page authorization surface. Per-token airdrop
  // delegation lives in AirdropForm itself (creators delegate one
  // moment at a time from there). Collection-wide MINTER grants
  // aren't exposed in our UI — anyone with legacy MINTER from
  // off-platform still gets the airdrop chip and surfaces in
  // /api/collections/mintable, but new grants go through this panel
  // (ADMIN tier) since it covers airdrop authority too.
  const {
    batch: batchCreator,
    reset: resetCreatorGrant,
    busy: creatorGranting,
    hash: creatorHash,
    receipt: creatorReceipt,
  } = useGrantPermission()
  const creatorTxPending = !!creatorHash && !creatorReceipt
  const isCreatorBusy = creatorGranting || creatorTxPending
  const [creatorInput, setCreatorInput] = useState('')
  const [revokingCreatorEoa, setRevokingCreatorEoa] = useState<string | null>(null)
  // Captures the in-flight action so the receipt effect knows whether
  // to POST or DELETE the KV mapping after the tx confirms. `eoa` is
  // undefined for revokes of chain-only entries (no KV row to drop).
  const pendingCreatorRef = useRef<
    | { kind: 'grant'; eoa: string; smartWallet: string; label?: string }
    | { kind: 'revoke'; eoa: string | undefined }
    | null
  >(null)
  const {
    creators: authorizedCreators,
    loading: creatorsLoading,
    refetch: refetchCreators,
  } = useAuthorizedCreators(
    canGrantHere ? (address as `0x${string}`) : undefined,
  )

  // Mainnet client for client-side ENS resolution. Wagmi already
  // configures a mainnet transport for ENS (lib/wagmi.ts), so we reuse
  // it instead of standing up a duplicate viem client.
  const mainnetClient = usePublicClient({ chainId: mainnet.id })

  // ─── Authorize creators (ADMIN to smart wallet) ─────────────────────
  async function handleAuthorizeCreator() {
    if (isCreatorBusy) return
    const raw = creatorInput.trim()
    if (!raw) return
    try {
      toast.loading('Resolving address…', { id: 'authorize-creator' })
      const eoa = await resolveAddressOrEns(mainnetClient, raw)
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
      // Multicall: grant ADMIN to SW (MintForm relay) + grant ADMIN to
      // EOA (direct from-wallet calls) + clear any pre-existing MINTER
      // on EOA (redundant once ADMIN is set, would otherwise leave a
      // stale row in the Minters list after a minter→creator upgrade).
      // filterRedundant short-circuits any of these that's already in
      // the requested state.
      const outcome = await batchCreator([
        { direction: 'grant', collection: address as `0x${string}`, grantee: swLower, tokenId: 0n, bit: 'admin' },
        { direction: 'grant', collection: address as `0x${string}`, grantee: eoa, tokenId: 0n, bit: 'admin' },
        { direction: 'revoke', collection: address as `0x${string}`, grantee: eoa, tokenId: 0n, bit: 'minter' },
      ])
      if (outcome === 'submitted') {
        pendingCreatorRef.current = { kind: 'grant', eoa, smartWallet: swLower, label }
        toast.loading('Authorizing creator…', { id: 'authorize-creator' })
        return
      }
      // Both bits were already set on chain. Persist the KV mapping
      // anyway so the list shows the entry — without it, a re-grant
      // under the same admin would never visibly land.
      let kvOk = true
      try {
        const res = await fetch('/api/collection/authorized-creators', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            collection: address,
            eoa,
            smartWallet: swLower,
            label,
          }),
        })
        if (!res.ok) {
          kvOk = false
          const detail = await res.text().catch(() => '')
          console.error('[authorize-creator] KV write rejected', {
            status: res.status,
            detail,
          })
        }
      } catch (err) {
        kvOk = false
        console.error('[authorize-creator] KV write failed', err)
      }
      setCreatorInput('')
      if (kvOk) {
        toast.success('Already an authorized creator', { id: 'authorize-creator' })
      } else {
        // On-chain ADMIN exists; KV display row didn't land. The
        // chain-merge in GET will still surface the entry as
        // (unmapped) so the row at least appears.
        toast.warning('Authorized on chain, but couldn’t save display label', {
          id: 'authorize-creator',
          description: 'Check the browser console for the server response.',
        })
      }
      void refetchCreators()
    } catch (err) {
      toastError('Authorize creator', err, { id: 'authorize-creator' })
    }
  }

  async function handleRevokeCreator(eoa: string | undefined, smartWallet: string) {
    if (isCreatorBusy) return
    const eoaLower = eoa?.toLowerCase()
    setRevokingCreatorEoa(eoaLower ?? smartWallet.toLowerCase())
    try {
      toast.loading('Confirm in wallet…', { id: 'authorize-creator' })
      // Off-platform ADMIN grants (etherscan etc.) only ever hit one
      // grantee, so we may not have an EOA to clear. Skip the EOA
      // entry when it's unmapped — the chain only has the SW row.
      const ops: PermissionOp[] = [
        {
          direction: 'revoke',
          collection: address as `0x${string}`,
          grantee: smartWallet as `0x${string}`,
          tokenId: 0n,
          bit: 'admin',
        },
      ]
      if (eoa) {
        ops.push({
          direction: 'revoke',
          collection: address as `0x${string}`,
          grantee: eoa as `0x${string}`,
          tokenId: 0n,
          bit: 'admin',
        })
      }
      const outcome = await batchCreator(ops)
      if (outcome === 'submitted') {
        pendingCreatorRef.current = { kind: 'revoke', eoa }
        toast.loading('Revoking creator…', { id: 'authorize-creator' })
        return
      }
      // Already cleared on chain — drop the KV row directly so the UI
      // doesn't keep showing a stale entry. Chain-only entries (no
      // mapped EOA) have no KV row to drop.
      if (eoa) {
        try {
          await fetch(
            `/api/collection/authorized-creators?collection=${address}&eoa=${eoa}`,
            { method: 'DELETE' },
          )
        } catch {}
      }
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
      let kvOk = true
      try {
        if (action.kind === 'grant') {
          const res = await fetch('/api/collection/authorized-creators', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              collection: address,
              eoa: action.eoa,
              smartWallet: action.smartWallet,
              label: action.label,
            }),
          })
          if (!res.ok) {
            kvOk = false
            const detail = await res.text().catch(() => '')
            console.error('[authorize-creator] KV write rejected', {
              status: res.status,
              detail,
            })
          }
          setCreatorInput('')
        } else if (action.eoa) {
          const res = await fetch(
            `/api/collection/authorized-creators?collection=${address}&eoa=${action.eoa}`,
            { method: 'DELETE' },
          )
          if (!res.ok) {
            kvOk = false
            console.error('[authorize-creator] KV delete rejected', {
              status: res.status,
            })
          }
        }
      } catch (err) {
        kvOk = false
        console.error('[authorize-creator] KV request failed', err)
      } finally {
        if (kvOk) {
          toast.success(
            action.kind === 'revoke' ? 'Creator revoked' : 'Creator authorized',
            { id: 'authorize-creator' },
          )
        } else {
          // Chain state is correct; the chain-merge in GET will still
          // surface the entry as (unmapped) so it doesn't go ghost.
          toast.warning(
            action.kind === 'revoke'
              ? 'Revoked on chain, but couldn’t clear display row'
              : 'Authorized on chain, but couldn’t save display label',
            {
              id: 'authorize-creator',
              description: 'Check the browser console for the server response.',
            },
          )
        }
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
        const creatorSet = new Set(loaded.map((m) => m.creator.address.toLowerCase()))
        creatorSet.forEach((addr) => {
          fetchCreatorProfile(addr).then(({ name, avatarUrl }) => {
            if (!cancelled)
              setProfiles((prev) => ({ ...prev, [addr]: { name, avatarUrl } }))
          })
        })
      })
      .catch(() => { if (!cancelled) setMoments([]) })
    return () => { cancelled = true }
  }, [address])

  // Hydrate profiles for the authorized-creators panel — same cache the
  // moment-creator avatars use, so admins recognize who they're managing.
  // For chain-only entries (no EOA) we look up by smart wallet, which
  // typically returns just a fallback shortAddress.
  useEffect(() => {
    let cancelled = false
    for (const c of authorizedCreators) {
      const addr = (c.eoa ?? c.smartWallet).toLowerCase()
      if (profiles[addr]) continue
      fetchCreatorProfile(addr).then(({ name, avatarUrl }) => {
        if (!cancelled)
          setProfiles((prev) =>
            prev[addr] ? prev : { ...prev, [addr]: { name, avatarUrl } },
          )
      })
    }
    return () => {
      cancelled = true
    }
  }, [authorizedCreators, profiles])

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
  // Same fall-through logic as the URL: prefer collection-level thumbhash;
  // when the cover falls back to firstMoment, use its thumbhash too.
  const coverThumbhash = collectionImage ? collectionThumbhash : firstMoment?.metadata?.kismet_thumbhash
  const description = collectionDescription

  // Total collects: sum on-chain totalMinted per token — no aggregated count
  // exists upstream. Batched into one multicall by wagmi.
  const { data: tokenInfos } = useReadContracts({
    contracts: loadedMoments.map((m) => ({
      address: m.address as `0x${string}`,
      abi: ZORA_1155_TOKEN_INFO_ABI,
      functionName: 'getTokenInfo' as const,
      args: [BigInt(m.token_id)] as const,
    })),
    query: { enabled: loadedMoments.length > 0 },
  })
  const totalSold = tokenInfos?.reduce(
    (sum, r) =>
      r.status === 'success' && r.result
        ? sum + Number((r.result as { totalMinted: bigint }).totalMinted)
        : sum,
    0,
  )

  // Collect-all candidates bucketed by currency; useCollectAll re-checks live
  // eligibility at click time, so passing every priced token is safe.
  const ethCollectIds: string[] = []
  const usdcCollectIds: string[] = []
  for (const m of loadedMoments) {
    if (!m.saleConfig) continue
    if (inferCollectCurrency(m.saleConfig) === 'usdc') usdcCollectIds.push(m.token_id)
    else ethCollectIds.push(m.token_id)
  }

  async function handleShare() {
    const url = `${window.location.origin}/collection/${address}`
    if (isInMiniApp) {
      try {
        const { sdk } = await import('@farcaster/miniapp-sdk')
        await sdk.actions.composeCast({
          text: `Check out ${displayName} on @kismet`,
          embeds: [url],
          channelKey: 'kismet',
        })
        return
      } catch { /* fall through to clipboard */ }
    }
    navigator.clipboard.writeText(url).catch(() => {})
    setLinkCopied(true)
    setTimeout(() => setLinkCopied(false), 1500)
  }

  // Unique creator addresses across all loaded moments — surfaces
  // anyone who has actually shipped a token here, including authorized
  // creators after they mint. Pre-mint authorizations live in the
  // admin panel above; this section is the gallery of contributors.
  const uniqueCreators = Array.from(
    new Set(loadedMoments.map((m) => m.creator.address.toLowerCase())),
  )

  const indexing = isTracked && moments !== null && loadedMoments.length === 0

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <button
        onClick={() => router.back()}
        className="flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim transition-colors mb-8"
      >
        <ArrowLeft size={12} />
        back
      </button>

      {/* Creator-only banner so the creator knows their collection is hidden */}
      {hidden && isCreator && (
        <div className="px-3 py-2 mb-6 border border-line bg-raised flex items-center gap-2">
          <EyeOff size={11} className="text-dim" />
          <p className="text-[10px] font-mono text-dim uppercase tracking-widest">
            hidden from public — only you can see this
          </p>
        </div>
      )}

      {/* Collection header */}
      <div className="flex gap-5 mb-10">
        <div className="relative w-24 h-24 sm:w-32 sm:h-32 flex-shrink-0 bg-surface border border-line overflow-hidden">
          {rawImgUrl ? (
            <MomentImage
              src={rawImgUrl}
              alt={displayName}
              fill
              className="object-cover"
              sizes="(max-width: 640px) 96px, 128px"
              priority
              preferProxy
              thumbhash={coverThumbhash}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <span className="text-line font-mono text-[10px]">no image</span>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1.5 min-w-0 pt-1">
          <h1 className="text-base font-mono text-ink truncate">
            {displayName}
          </h1>
          {defaultAdminAddress ? (
            <Link
              href={`/profile/${defaultAdminAddress}`}
              className="text-[10px] font-mono text-[#444] hover:text-dim transition-colors w-fit"
            >
              {resolvedAdminName ?? shortAddress(defaultAdminAddress)}
            </Link>
          ) : (
            <p className="text-[10px] font-mono text-[#444]">{shortAddress(address)}</p>
          )}
          {/* Enriched chips: payout transparency (only when it differs from
              the admin — same-address payouts are noise) and creation date. */}
          {(payoutRecipient || createdAt || (totalSold !== undefined && totalSold > 0)) && (
            <div className="flex flex-wrap items-center gap-2 mt-1.5">
              {createdAt && (
                <span className="text-[10px] font-mono text-muted uppercase tracking-widest">
                  created {formatCreatedDate(createdAt)}
                </span>
              )}
              {totalSold !== undefined && totalSold > 0 && (
                <>
                  {createdAt && <span className="text-[10px] font-mono text-[#444]">|</span>}
                  <span className="text-[10px] font-mono text-muted uppercase tracking-widest">
                    total sold {totalSold.toLocaleString()}
                  </span>
                </>
              )}
              {payoutRecipient && (
                <Link
                  href={`/profile/${payoutRecipient}`}
                  className="text-[10px] font-mono text-muted hover:text-dim uppercase tracking-widest transition-colors"
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
                  name: displayName,
                },
              }}
              className="mt-2 inline-flex items-center gap-1.5 self-start border border-accent/40 bg-accent/5 hover:border-accent hover:bg-accent/10 px-2.5 py-1 transition-colors"
              title="Your mint wallet holds ADMIN here — create new moments via MintForm"
            >
              <ShieldCheck size={11} className="text-accent" />
              <span className="text-[10px] font-mono text-ink uppercase tracking-widest">
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
                  name: displayName,
                },
              }}
              className="mt-2 inline-flex items-center gap-1.5 self-start border border-accent/40 bg-accent/5 hover:border-accent hover:bg-accent/10 px-2.5 py-1 transition-colors"
              title="You hold MINTER on this collection — airdrop copies via the Airdrop tab"
            >
              <ShieldCheck size={11} className="text-accent" />
              <span className="text-[10px] font-mono text-ink uppercase tracking-widest">
                you can airdrop here →
              </span>
            </Link>
          )}
          {description && (
            <p className="text-xs font-mono text-muted mt-1 line-clamp-3">{description}</p>
          )}
          <div className="flex items-center gap-3 mt-2">
            {isAdmin && (
              <button
                onClick={() => toggleFeaturedCollection(address)}
                className={`flex items-center gap-1.5 text-xs font-mono transition-colors ${
                  isFeatured ? 'text-yellow-400' : 'text-muted hover:text-dim'
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
                  hidden ? 'text-dim hover:text-ink' : 'text-muted hover:text-dim'
                }`}
                title={hidden ? 'Show collection on public feeds' : 'Hide collection from public feeds'}
              >
                {hidden ? <Eye size={12} /> : <EyeOff size={12} />}
                {hidden ? 'hidden' : 'hide'}
              </button>
            )}
            <button
              onClick={handleShare}
              className="flex items-center gap-1.5 text-xs font-mono text-muted hover:text-dim transition-colors"
              title="Share collection"
            >
              {linkCopied
                ? <Check size={12} className="text-[#6ee7b7]" />
                : <Copy size={12} strokeWidth={1.5} />}
              {linkCopied ? 'copied' : 'share'}
            </button>
          </div>
        </div>
      </div>

      {/* Authorize banner — surfaces when a collection predates the
          inprocess-admin grant we now bake into deploy. Renders for
          any wallet with on-chain ADMIN (creator OR a platform
          operator who deployed on the artist's behalf), only when
          the grant is actually missing. */}
      {showAuthorize && (
        <div className="mb-8 p-3 sm:p-4 border border-accent/40 bg-accent/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <ShieldCheck size={16} className="text-accent flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-mono text-ink">
                Authorize Kismet to mint into this collection
              </p>
              <p className="text-[11px] font-mono text-dim mt-0.5">
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

      {/* Authorize creators — multicall grants ADMIN to the target's
          smart wallet (MintForm relay surface) and EOA (direct from-
          wallet calls), and clears any redundant MINTER row on the
          EOA to keep the Minters list clean after an upgrade. */}
      {canGrantHere && (
        <div className="mb-4 p-3 sm:p-4 border border-line bg-[#0d0d0d]">
          <div className="flex items-center gap-1.5 mb-2">
            <ShieldCheck size={12} className="text-dim" />
            <p className="text-xs font-mono text-dim uppercase tracking-wider">
              Authorize creators
            </p>
          </div>
          <p className="text-[11px] font-mono text-muted mb-3">
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
              className="flex-1 bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
            />
            <button
              type="button"
              onClick={() => void handleAuthorizeCreator()}
              disabled={isCreatorBusy || !creatorInput.trim()}
              className="px-4 text-[10px] font-mono tracking-wider uppercase border border-line text-dim hover:border-muted hover:text-ink transition-colors disabled:opacity-50"
            >
              {isCreatorBusy && !revokingCreatorEoa ? 'authorizing…' : 'authorize'}
            </button>
          </div>
          {creatorsLoading && authorizedCreators.length === 0 ? (
            <ul className="mt-3 flex flex-col gap-1" aria-busy="true">
              {[0, 1].map((i) => (
                <li
                  key={i}
                  className="flex items-center justify-between bg-surface border border-raised px-3 py-2 animate-pulse"
                >
                  <span className="h-3 w-32 bg-raised" />
                  <span className="h-3 w-3 bg-raised flex-shrink-0" />
                </li>
              ))}
            </ul>
          ) : (
            authorizedCreators.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1">
                {authorizedCreators.map((c) => {
                  // Chain-only entries (off-platform addPermission, no
                  // KV reverse-lookup) key by smart wallet — that's
                  // the only stable identifier we have.
                  const profileAddr = (c.eoa ?? c.smartWallet).toLowerCase()
                  const isRevoking = revokingCreatorEoa === profileAddr
                  const otherTxBusy = isCreatorBusy && !isRevoking
                  const profile = profiles[profileAddr]
                  // Display priority: profile/username > ENS label > shortAddress.
                  // profileCache returns the address-fallback when no name is
                  // known, so reject that case and bubble up to the next tier.
                  const profileName =
                    profile?.name && profile.name !== shortAddress(profileAddr)
                      ? profile.name
                      : null
                  const display =
                    profileName ?? c.label ?? shortAddress(profileAddr)
                  return (
                    <li
                      key={profileAddr}
                      className={`flex items-center justify-between bg-surface border px-3 py-2 ${
                        c.liveOnChain ? 'border-line' : 'border-raised opacity-60'
                      }`}
                      title={
                        !c.liveOnChain
                          ? 'Stale — ADMIN was revoked outside this UI'
                          : c.eoa
                            ? `${c.label ?? c.eoa} → ${c.smartWallet}`
                            : `Off-platform grant — smart wallet ${c.smartWallet}`
                      }
                    >
                      <Link
                        href={`/profile/${profileAddr}`}
                        className="flex items-center gap-2.5 min-w-0 flex-1 hover:opacity-80 transition-opacity"
                      >
                        <ProfileAvatar
                          address={profileAddr}
                          avatarUrl={profile?.avatarUrl}
                          size={24}
                        />
                        <span className="text-xs font-mono text-dim truncate">
                          {display}
                          {!c.eoa && c.liveOnChain && (
                            <span className="ml-2 text-muted">(unmapped)</span>
                          )}
                          {!c.liveOnChain && (
                            <span className="ml-2 text-muted">(stale)</span>
                          )}
                        </span>
                      </Link>
                      <button
                        type="button"
                        onClick={() => void handleRevokeCreator(c.eoa, c.smartWallet)}
                        disabled={otherTxBusy || isRevoking}
                        title="Revoke creator authorization"
                        className="ml-2 text-muted hover:text-ink disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
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
          <h2 className="text-xs font-mono text-muted uppercase tracking-widest mb-4">
            {uniqueCreators.length === 1 ? 'artist' : 'artists'}
          </h2>
          <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap">
            {uniqueCreators.map((addr) => (
              <AvatarRow key={addr} addr={addr} profiles={profiles} />
            ))}
          </div>
        </section>
      )}

      {/* NFT grid */}
      <section>
        <div className="flex items-center gap-4 mb-4">
          <h2 className="text-xs font-mono text-muted uppercase tracking-widest">
            artworks{loadedMoments.length > 0 ? ` (${loadedMoments.length})` : ''}
          </h2>
          {(ethCollectIds.length > 0 || usdcCollectIds.length > 0) && (
            <CollectAllAction
              plain
              collectionAddress={address}
              ethEligibleTokenIds={ethCollectIds}
              usdcEligibleTokenIds={usdcCollectIds}
            />
          )}
        </div>
        {moments === null ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="aspect-square bg-surface border border-raised animate-pulse" />
            ))}
          </div>
        ) : loadedMoments.length === 0 ? (
          indexing ? (
            <p className="text-xs font-mono text-dim">
              indexing your first mint… can take a few minutes. refresh to check.
            </p>
          ) : (
            <p className="text-xs font-mono text-muted">no moments in this collection yet</p>
          )
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {loadedMoments.map((m, i) => {
              const key = m.id || `${m.address}-${m.token_id}`
              return (
                <MaybeLazy key={key} index={i} lazy={isMobile}>
                  {() => <MomentCard moment={m} hidePriceSupply />}
                </MaybeLazy>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
