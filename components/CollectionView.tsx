'use client'

import { useState, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { isAddress } from 'viem'
import { ArrowLeft, Star, Eye, EyeOff, ShieldCheck } from 'lucide-react'
import { resolveUri, shortAddress, type Moment, type MomentAdmin } from '@/lib/inprocess'
import { fetchCreatorProfile } from '@/lib/profileCache'
import { toastError } from '@/lib/toast'
import { useAdmin } from '@/contexts/AdminContext'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { useEnsureBase } from '@/lib/useEnsureBase'
import {
  COLLECTION_ABI,
  PERMISSION_BIT_ADMIN,
} from '@/lib/collections'
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
  moments: Moment[]
  collectionName?: string
  collectionImage?: string
  collectionDescription?: string
  admins?: MomentAdmin[]
  indexing?: boolean
  // Enriched detail fields from inprocess `GET /api/collection`. Optional —
  // page falls back to the lightweight metadata when these aren't returned
  // (e.g., indexer hasn't picked up the collection yet).
  defaultAdminUsername?: string
  // Default-admin (deployer) address — used to gate the creator-only hide
  // button. Not the same as the on-chain ADMIN bit check; that runs
  // server-side at toggle time. This prop is for UI rendering only.
  defaultAdminAddress?: string
  payoutRecipient?: string
  createdAt?: string
  // Server-rendered initial hidden state (read from KV). Toggled locally
  // after a successful POST to /api/collection/hide.
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
  moments,
  collectionName,
  collectionImage,
  collectionDescription,
  admins = [],
  indexing = false,
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
  const [hidePending, setHidePending] = useState(false)
  const { ensureSession } = useUploadSession()

  const isFeatured = featuredCollectionAddrs.has(address.toLowerCase())
  const isCreator =
    !!connectedAddress &&
    !!defaultAdminAddress &&
    connectedAddress.toLowerCase() === defaultAdminAddress.toLowerCase()

  // Retroactive authorize flow — for collections deployed before we
  // started granting the creator's inprocess smart wallet ADMIN as a
  // setupAction. Without that grant, every /api/mint into the collection
  // reverts at gas estimation. The creator can grant it after the fact
  // with a single addPermission call from their own wallet (they hold
  // ADMIN already as defaultAdmin). The smart wallet on inprocess is
  // per-EOA, so we look up the smart wallet bound to *this collection's
  // creator* (defaultAdminAddress); when the connected viewer is the
  // creator, that's the wallet they're authorizing on the collection.
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
    query: { enabled: inprocessConfigured && isCreator },
  })
  const inprocessIsAdmin =
    inprocessPerms !== undefined &&
    ((inprocessPerms as bigint) & PERMISSION_BIT_ADMIN) === PERMISSION_BIT_ADMIN
  const showAuthorize = isCreator && inprocessConfigured && inprocessPerms !== undefined && !inprocessIsAdmin

  const ensureBase = useEnsureBase()
  const { writeContractAsync } = useWriteContract()
  const [authorizeHash, setAuthorizeHash] = useState<`0x${string}` | undefined>(undefined)
  const [authorizing, setAuthorizing] = useState(false)
  const { data: authorizeReceipt } = useWaitForTransactionReceipt({
    hash: authorizeHash,
    query: { enabled: !!authorizeHash },
  })

  // When the authorize tx confirms, refetch the permission read so the
  // button hides itself without a manual reload.
  useEffect(() => {
    if (!authorizeReceipt) return
    setAuthorizing(false)
    if (authorizeReceipt.status === 'reverted') {
      toast.error('Authorize failed', { id: 'authorize', description: 'The transaction reverted on-chain.' })
      return
    }
    void refetchInprocessPerms()
    toast.success('Kismet authorized — minting now works for this collection', { id: 'authorize' })
  }, [authorizeReceipt, refetchInprocessPerms])

  async function handleAuthorize() {
    if (!connectedAddress || !inprocessConfigured || !inprocessSmartWallet) return
    setAuthorizing(true)
    try {
      await ensureBase()
      toast.loading('Confirm in wallet…', { id: 'authorize' })
      const hash = await writeContractAsync({
        chainId: base.id,
        address: address as `0x${string}`,
        abi: COLLECTION_ABI,
        functionName: 'addPermission',
        // tokenId 0 is the collection-wide permission row; granting ADMIN
        // there gives inprocess admin over every token in the collection,
        // present and future.
        args: [0n, inprocessSmartWallet as `0x${string}`, PERMISSION_BIT_ADMIN],
      })
      setAuthorizeHash(hash)
      toast.loading('Authorizing…', { id: 'authorize' })
    } catch (err) {
      setAuthorizing(false)
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

  const firstMoment = moments[0]
  const displayName = collectionName || shortAddress(address)
  const rawImgUrl = collectionImage || firstMoment?.metadata?.image
  const imgUrl = rawImgUrl ? resolveUri(rawImgUrl) : null
  const description = collectionDescription

  // Unique creator addresses across all moments
  const uniqueCreators = Array.from(
    new Set(moments.map((m) => m.creator.address.toLowerCase()))
  )

  // Unique admin addresses not already in creators
  const uniqueAdmins = admins.filter(
    (a) => !uniqueCreators.includes(a.address.toLowerCase())
  )

  const allAddresses = [...uniqueCreators, ...uniqueAdmins.map((a) => a.address)]

  useEffect(() => {
    allAddresses.forEach((addr) => {
      fetchCreatorProfile(addr).then(({ name, avatarUrl }) => {
        setProfiles((prev: Record<string, AvatarProfile>) => ({ ...prev, [addr.toLowerCase()]: { name, avatarUrl } }))
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

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
            {defaultAdminUsername && (
              <span className="text-[#555] font-normal"> by @{defaultAdminUsername}</span>
            )}
          </h1>
          <p className="text-[10px] font-mono text-[#444]">{shortAddress(address)}</p>
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

      {/* Authorize banner — surfaces when the creator's collection
          predates the inprocess-admin grant we now bake into deploy.
          One click, one tx, and minting works end-to-end. Only renders
          for the creator + only when the grant is actually missing. */}
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
          moments{moments.length > 0 ? ` (${moments.length})` : ''}
        </h2>
        {moments.length === 0 ? (
          indexing ? (
            <p className="text-xs font-mono text-[#888]">
              indexing your first mint… can take a few minutes. refresh to check.
            </p>
          ) : (
            <p className="text-xs font-mono text-[#555]">no moments in this collection yet</p>
          )
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {moments.map((m) => (
              <MomentCard key={m.id || `${m.address}-${m.token_id}`} moment={m} hidePriceSupply />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
