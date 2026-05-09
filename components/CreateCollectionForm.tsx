'use client'

import { useState, useRef, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { parseEventLogs, isAddress, parseEther, type Address } from 'viem'
import { toast } from 'sonner'
import { Upload, X, Plus, Trash2, Check } from 'lucide-react'
import { FACTORY_ADDRESS, FACTORY_ABI, encodeMinterPermission, encodeAdminPermission, buildCoverTokenSetupActions } from '@/lib/collections'
import { CREATE_REFERRAL, OPERATOR_SMART_WALLET } from '@/lib/config'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import { useUploadSession } from '@/hooks/useUploadSession'
import { fetchInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { verifyDeployPermissions } from '@/lib/permissions'
import { registerCollectionWithBackoff } from '@/lib/registerCollection'
import { toastError } from '@/lib/toast'
import { useEnsureBase } from '@/lib/useEnsureBase'

interface CreateCollectionFormProps {
  onDeployed?: (address: string, name: string) => void
}

export function CreateCollectionForm({ onDeployed }: CreateCollectionFormProps = {}) {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { ensureSession } = useUploadSession()

  const [coverFile, setCoverFile] = useState<File | null>(null)
  const [coverPreview, setCoverPreview] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [royaltyBps, setRoyaltyBps] = useState('500')
  const [royaltyRecipient, setRoyaltyRecipient] = useState('')
  const [minters, setMinters] = useState<string[]>([])
  const [minterInput, setMinterInput] = useState('')
  const [mintCover, setMintCover] = useState(false)
  const [coverPrice, setCoverPrice] = useState('0')
  const [coverSupply, setCoverSupply] = useState('')
  const [step, setStep] = useState<'idle' | 'uploading-image' | 'uploading-metadata' | 'deploying' | 'done'>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [collectionAddress, setCollectionAddress] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  const [deployedImageUri, setDeployedImageUri] = useState<string | undefined>(undefined)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()
  // For the post-deploy permission verification.
  const publicClient = usePublicClient({ chainId: base.id })

  // Resolved inprocess smart wallet for the connected EOA. Set in
  // handleCreate so the receipt-watcher useEffect can read it back when
  // verifyDeployPermissions runs after the tx confirms. Persisted in
  // localStorage alongside the pending-deploy entry so a refresh/resume
  // doesn't lose it (otherwise we'd re-resolve, which is also fine but
  // adds an extra inprocess round-trip).
  const [resolvedSmartWallet, setResolvedSmartWallet] = useState<string | null>(null)

  // Recovery + timeout for in-flight deploys (industry-standard pattern).
  // Persisted to localStorage so a refresh, tab close, or wallet disconnect
  // mid-deploy doesn't lose the tx — we resume the receipt watch on next
  // mount, register KV when it confirms, and redirect to the collection.
  const PENDING_KEY = address ? `kismetart:pending-deploy:${address.toLowerCase()}` : ''
  const PENDING_MAX_AGE_MS = 30 * 60 * 1000 // 30 min — older entries are abandoned
  const TX_TIMEOUT_MS = 90 * 1000 // 90s before we surface a "still pending" message

  function addMinter() {
    const addr = minterInput.trim()
    if (!isAddress(addr)) { toast.error('Invalid address'); return }
    if (minters.includes(addr)) return
    setMinters((prev) => [...prev, addr])
    setMinterInput('')
  }

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    query: { enabled: !!txHash && step === 'deploying' },
  })

  // 1. Recovery on mount: if a deploy was in flight when the user left the
  //    page, restore the txHash + form state and resume the receipt watch.
  useEffect(() => {
    if (!address || !PENDING_KEY) return
    try {
      const raw = localStorage.getItem(PENDING_KEY)
      if (!raw) return
      const pending = JSON.parse(raw) as {
        txHash: `0x${string}`
        name: string
        description: string
        deployedImageUri: string
        mintCover: boolean
        startedAt: number
        resolvedSmartWallet?: string
      }
      if (Date.now() - pending.startedAt > PENDING_MAX_AGE_MS) {
        localStorage.removeItem(PENDING_KEY)
        return
      }
      setName(pending.name)
      setDescription(pending.description)
      setDeployedImageUri(pending.deployedImageUri || undefined)
      setMintCover(pending.mintCover)
      setTxHash(pending.txHash)
      // Older localStorage entries won't have this field; the receipt
      // handler re-resolves in that case.
      if (pending.resolvedSmartWallet) setResolvedSmartWallet(pending.resolvedSmartWallet)
      setStep('deploying')
      toast.loading('Resuming deploy…', { id: 'create-collection' })
    } catch {}
    // We only want this on initial mount per address; intentionally narrow deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address])

  // 2. Persist the in-flight tx so a refresh can resume it. Triggered as soon
  //    as we have a txHash and we're in the deploying state.
  useEffect(() => {
    if (!PENDING_KEY || step !== 'deploying' || !txHash) return
    try {
      localStorage.setItem(
        PENDING_KEY,
        JSON.stringify({
          txHash,
          name: name.trim(),
          description: description.trim(),
          deployedImageUri: deployedImageUri ?? '',
          mintCover,
          startedAt: Date.now(),
          // Persist so the receipt handler can verify on resume without
          // a re-fetch round-trip (and so the verification still runs
          // even when /smartwallet is briefly unreachable).
          resolvedSmartWallet: resolvedSmartWallet ?? undefined,
        }),
      )
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txHash, step])

  // 3. Stuck-tx warning: if we're still waiting for the receipt after 90s,
  //    surface a clearer message with a link to basescan so the user has
  //    options instead of staring at "Deploying…" indefinitely.
  useEffect(() => {
    if (step !== 'deploying' || !txHash) return
    const timer = setTimeout(() => {
      toast.loading(
        'Tx still pending — refresh later to resume, or check status on basescan',
        {
          id: 'create-collection',
          description: `https://basescan.org/tx/${txHash}`,
        },
      )
    }, TX_TIMEOUT_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, txHash])

  useEffect(() => {
    if (!receipt || step !== 'deploying') return

    const clearPending = () => {
      if (PENDING_KEY) {
        try { localStorage.removeItem(PENDING_KEY) } catch {}
      }
    }

    if (receipt.status === 'reverted') {
      clearPending()
      setStep('idle')
      setTxHash(undefined)
      setUploadProgress(0)
      toast.error('Transaction reverted', { id: 'create-collection', description: 'The deploy transaction failed on-chain.' })
      return
    }
    const logs = parseEventLogs({
      abi: FACTORY_ABI,
      eventName: 'SetupNewContract',
      logs: receipt.logs,
    })
    // Only trust the parsed factory event. Falling back to logs[0]?.address
    // would resolve to any unrelated contract that happened to emit a log.
    const deployedAddress = (logs[0]?.args?.newContract as string | undefined) ?? null

    if (!deployedAddress) {
      // Tx confirmed but no SetupNewContract event — wrong chain / contract.
      clearPending()
      setStep('idle')
      setTxHash(undefined)
      toast.error('Deploy incomplete', {
        id: 'create-collection',
        description: 'Tx confirmed but no collection address was emitted — likely wrong chain or contract.',
      })
      return
    }

    // Verify both ADMIN grants on-chain before declaring success. If
    // the inprocessAdminAction setupAction silently no-ops (wrong
    // factory bytecode, ABI drift, etc.) the collection deploys
    // without smart-wallet ADMIN and every subsequent mint reverts
    // upstream — fail-closed here so the user sees a clear error
    // instead of a silent regression.
    void (async () => {
      // Re-resolve smart wallet on resume from localStorage where the
      // field wasn't persisted in older entries.
      let smartWallet = resolvedSmartWallet
      if (!smartWallet && address) {
        try {
          smartWallet = await fetchInprocessSmartWallet(address)
        } catch {
          smartWallet = null
        }
      }

      if (!smartWallet || !isAddress(smartWallet) || !publicClient || !address) {
        // Including !address here defends against the user disconnecting
        // their wallet between tx submission and receipt. Without it
        // we'd cast `undefined as Address` to verifyDeployPermissions.
        clearPending()
        setStep('idle')
        setTxHash(undefined)
        toast.error('Deploy verification skipped', {
          id: 'create-collection',
          description:
            'Could not resolve your smart wallet or RPC client. Collection deployed but its permissions are unverified — re-deploy or grant ADMIN manually before minting.',
        })
        return
      }

      try {
        const verify = await verifyDeployPermissions(
          publicClient,
          deployedAddress as Address,
          address as Address,
          smartWallet as Address,
        )
        if (!verify.ok) {
          clearPending()
          setStep('idle')
          setTxHash(undefined)
          console.error('[CreateCollectionForm] post-deploy verify failed', {
            collection: deployedAddress,
            deployer: address,
            smartWallet,
            detail: verify.detail,
            deployerPerms: verify.deployerPerms.toString(),
            smartWalletPerms: verify.smartWalletPerms.toString(),
          })
          toast.error('Deploy verification failed', {
            id: 'create-collection',
            description: verify.detail,
          })
          return
        }
      } catch (err) {
        // Read failed across all retries — distinct from "we read and
        // saw missing bits". Don't proceed silently; the deploy may
        // be fine but we can't prove it.
        clearPending()
        setStep('idle')
        setTxHash(undefined)
        console.error('[CreateCollectionForm] post-deploy verify threw', err)
        toast.error('Deploy verification failed', {
          id: 'create-collection',
          description:
            err instanceof Error
              ? `On-chain read failed: ${err.message}`
              : 'On-chain read failed',
        })
        return
      }

      setCollectionAddress(deployedAddress)

      // Cookie auth: the session was already established before the deploy
      // (ensureSession ran on Arweave upload), so this call rides on the same
      // session and the server can verify the caller matches `artist` and is
      // the on-chain admin of `address`. Fire-and-forget but with logging +
      // retry — silently swallowing this means the collection never lands in
      // KV and the user sees a misleading "deployed!" while the collection
      // never appears in feeds.
      void registerCollectionWithBackoff({
        address: deployedAddress,
        name: name.trim(),
        description: description.trim() || undefined,
        image: deployedImageUri,
        artist: address,
      })
      onDeployed?.(deployedAddress, name)

      clearPending()
      setStep('done')
      toast.success(
        mintCover ? 'Collection deployed + cover minted!' : 'Collection deployed!',
        { id: 'create-collection' },
      )
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, step])

  // Once everything (deploy + optional cover mint) finishes, route to the new collection.
  useEffect(() => {
    if (step !== 'done' || !collectionAddress) return
    router.push(`/collection/${collectionAddress}`)
  }, [step, collectionAddress, router])

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (coverPreview) URL.revokeObjectURL(coverPreview)
    setCoverFile(f)
    setCoverPreview(URL.createObjectURL(f))
  }

  function clearFile() {
    setCoverFile(null)
    if (coverPreview) URL.revokeObjectURL(coverPreview)
    setCoverPreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()

    if (!isConnected || !address) {
      openConnectModal?.()
      return
    }
    if (!coverFile) {
      toast.error('Please add a cover image')
      return
    }
    if (!name.trim()) {
      toast.error('Please enter a collection name')
      return
    }
    if (royaltyRecipient.trim() && !isAddress(royaltyRecipient.trim())) {
      toast.error('Invalid royalty recipient address')
      return
    }
    if (mintCover && coverSupply.trim()) {
      const s = parseInt(coverSupply.trim(), 10)
      if (isNaN(s) || s < 1) { toast.error('Cover supply must be at least 1'); return }
    }

    setDeployedImageUri(undefined)

    try {
      // Ensure session once — httpOnly cookie set, no re-prompt for 7 days
      await ensureSession()

      setStep('uploading-image')
      setUploadProgress(0)
      toast.loading('Uploading cover image…', { id: 'create-collection' })
      const imageUri = await uploadToArweave(coverFile, (pct) => {
        setUploadProgress(pct)
        toast.loading(`Uploading image… ${pct}%`, { id: 'create-collection' })
      })
      setDeployedImageUri(imageUri)

      // The cover image URI gets baked into the metadata JSON which gets
      // baked into the on-chain contractURI. If Turbo's data hasn't
      // propagated to Arweave gateways by the time the moment renders,
      // the image is permanently broken — re-uploading doesn't help
      // because the URI is fixed on-chain. Block on settlement first.
      toast.loading('Verifying Arweave propagation…', { id: 'create-collection' })
      const imageOk = await verifyArweaveAvailable(imageUri)
      if (!imageOk) {
        toast.error('Arweave is settling slowly', {
          id: 'create-collection',
          description:
            'Your upload isn’t lost — give it a couple of minutes and try again. We blocked the deploy to avoid a permanently broken cover image.',
        })
        setStep('idle')
        setUploadProgress(0)
        return
      }

      setStep('uploading-metadata')
      toast.loading('Uploading collection metadata…', { id: 'create-collection' })
      const metadata: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim(),
        image: imageUri,
        createReferral: CREATE_REFERRAL,
      }
      const contractURI = await uploadJson(metadata)

      setStep('deploying')
      toast.loading(
        mintCover ? 'Deploying collection + cover token…' : 'Deploying collection…',
        { id: 'create-collection' },
      )

      await ensureBase()

      const bps = Math.max(0, Math.min(10000, parseInt(royaltyBps, 10) || 0))
      const recipient = (royaltyRecipient.trim() || address) as `0x${string}`

      // Collection-wide minter permissions for any addresses the user added.
      // The factory replays each setupAction on the new collection during deploy.
      const minterActions = minters
        .filter((m) => isAddress(m))
        .map((m) => encodeMinterPermission(m as `0x${string}`))

      // Authorize the inprocess platform smart wallet as ADMIN so subsequent
      // /api/mint calls into this collection can succeed. Without this grant,
      // the userOp inprocess submits reverts at gas estimation
      // ("useroperation reverted: execution reverted") because Zora 1155's
      // setupNewToken is gated on the ADMIN bit. ADMIN — not MINTER —
      // because setupNewToken specifically requires admin per
      // Zora's PermissionsConstants. The smart wallet is per-EOA on
      // inprocess; we look up the smart wallet bound to *this user's*
      // wallet (the deployer) so the user can mint into their own
      // collection.
      //
      // Strict failure: if the lookup fails or returns garbage, fail the
      // deploy here rather than silently skipping the grant. A missing
      // grant turns into a non-actionable "Authorization required" toast
      // on every subsequent mint/airdrop, with no way for the user to
      // recover from a banner since they're already defaultAdmin and
      // there's nothing for them to fix. Better to fail fast at deploy
      // than ship a half-authorized collection.
      const inprocessSmartWallet = await fetchInprocessSmartWallet(address)
      if (!inprocessSmartWallet || !isAddress(inprocessSmartWallet)) {
        throw new Error(
          'Could not resolve your inprocess smart wallet — try again in a moment',
        )
      }
      // Lift the resolved address into state so the receipt-watcher
      // useEffect can call verifyDeployPermissions against it once the
      // factory tx confirms. Without this, the verify step would have
      // to re-fetch from /smartwallet — extra round-trip, and worse,
      // would silently skip verification if /smartwallet is briefly
      // unreachable.
      setResolvedSmartWallet(inprocessSmartWallet)
      // Grant ADMIN to TWO inprocess wallets at deploy time:
      //   1. The artist's own smart wallet — what /api/moment/create
      //      routes through when the user mints into this collection
      //      (the `account` override on mint-proxy makes inprocess
      //      derive this wallet from the caller's EOA).
      //   2. The platform operator smart wallet — what inprocess
      //      routes through for relayed admin-mint flows like airdrop
      //      under our shared INPROCESS_API_KEY. Without this grant,
      //      airdrops on user collections revert at gas estimation
      //      with "admin permission" because the operator wallet
      //      carries the API key's identity but holds no on-chain
      //      authority on the collection.
      // Skip the operator grant when NEXT_PUBLIC_OPERATOR_SMART_WALLET
      // is unset (dev / fork) so the deploy still goes through; the
      // user just won't be able to airdrop until they backfill via
      // CollectionView's authorize-for-airdrops banner.
      const inprocessAdminAction: `0x${string}`[] = [
        encodeAdminPermission(inprocessSmartWallet as `0x${string}`),
      ]
      if (OPERATOR_SMART_WALLET && isAddress(OPERATOR_SMART_WALLET)) {
        inprocessAdminAction.push(
          encodeAdminPermission(OPERATOR_SMART_WALLET as `0x${string}`),
        )
      }

      // If cover mint is enabled, append the cover-token setupActions so the
      // token is created in the same transaction. Mirrors how inprocess.world's
      // own frontend does it (see lib/protocolSdk/create/token-setup.ts in
      // their public repo). The factory acts as transient admin to run these.
      let coverActions: `0x${string}`[] = []
      if (mintCover) {
        const rawCoverPrice = coverPrice.trim()
        const normalizedCoverPrice = !rawCoverPrice || rawCoverPrice === '.'
          ? '0'
          : rawCoverPrice.startsWith('.')
            ? `0${rawCoverPrice}`
            : rawCoverPrice
        const priceWei = parseEther(normalizedCoverPrice)
        const maxSupplyVal = coverSupply.trim() ? BigInt(parseInt(coverSupply, 10)) : undefined
        const now = BigInt(Math.floor(Date.now() / 1000))
        const farFuture = 18446744073709551615n // max uint64
        coverActions = buildCoverTokenSetupActions({
          tokenURI: contractURI,
          maxSupply: maxSupplyVal,
          createReferral: CREATE_REFERRAL as `0x${string}`,
          pricePerTokenWei: priceWei,
          saleStart: now,
          saleEnd: farFuture,
          fundsRecipient: address,
          creator: address,
          mintToCreatorCount: 1,
        })
      }

      // Order matters when cover-mint is on: the inprocess admin grant
      // runs *before* the cover-token actions, so by the time the cover
      // token is set up, inprocess already holds ADMIN — staying
      // consistent with what the deploy will look like for every
      // subsequent token created via /api/mint.
      const setupActions = [...minterActions, ...inprocessAdminAction, ...coverActions]

      // Telemetry: log the cover-mint state and the count of cover actions
      // baked into the deploy tx, so if a user reports "I had cover mint on
      // but no cover token was minted" we can confirm whether the toggle was
      // actually true at click time. mintCover=false here ⇒ user toggled off
      // (or never on); coverActions.length=0 with mintCover=true ⇒ a build bug.
      console.log('[CreateCollectionForm] deploy submitted', {
        mintCover,
        coverActionsCount: coverActions.length,
        coverPrice: mintCover ? coverPrice : undefined,
        coverSupply: mintCover ? coverSupply : undefined,
        mintersCount: minterActions.length,
        inprocessAdminGranted: inprocessAdminAction.length > 0,
      })

      const hash = await writeContractAsync({
        chainId: base.id,
        address: FACTORY_ADDRESS,
        abi: FACTORY_ABI,
        functionName: 'createContract',
        args: [
          contractURI,
          name.trim(),
          {
            royaltyMintSchedule: 0,
            royaltyBPS: bps,
            royaltyRecipient: recipient,
          },
          address,
          setupActions,
        ],
      })

      setTxHash(hash)
    } catch (err) {
      // Clear any half-written pending state so a refresh doesn't try to
      // resume a deploy that never broadcast.
      if (PENDING_KEY) {
        try { localStorage.removeItem(PENDING_KEY) } catch {}
      }
      setStep('idle')
      setUploadProgress(0)
      toastError('Deploy', err, { id: 'create-collection' })
    }
  }

  const isBusy = step !== 'idle' && step !== 'done'

  if (step === 'done' && collectionAddress) {
    return (
      <div className="border border-[#2a2a2a] p-8 text-center flex flex-col gap-6">
        <div className="w-12 h-12 mx-auto rounded-full bg-[#8B5CF6]/10 border border-[#8B5CF6] flex items-center justify-center">
          <span className="text-xl accent-grad">✓</span>
        </div>
        <div>
          <h3 className="text-[#efefef] font-mono text-sm mb-2">Collection deployed</h3>
          <p className="text-[#888] text-xs font-mono break-all">{collectionAddress}</p>
        </div>
        <div className="flex flex-col gap-2">
          <a
            href={`https://inprocess.world/collect/base:${collectionAddress}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono accent-grad hover:underline"
          >
            View on in•process →
          </a>
          {txHash && (
            <a
              href={`https://basescan.org/tx/${txHash}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-[#555] hover:text-[#888]"
            >
              {txHash.slice(0, 10)}…{txHash.slice(-8)}
            </a>
          )}
        </div>
        <button
          onClick={() => {
            setStep('idle')
            setCollectionAddress(null)
            setTxHash(undefined)
            clearFile()
            setName('')
            setDescription('')
            setRoyaltyBps('500')
            setRoyaltyRecipient('')
            setMinters([])
            setMinterInput('')
            setMintCover(false)
            setCoverPrice('0')
            setCoverSupply('')
            setDeployedImageUri(undefined)
          }}
          className="text-xs font-mono text-[#888] hover:text-[#efefef] underline"
        >
          Create another
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleCreate} className="flex flex-col gap-6">
      {/* Cover image */}
      <div>
        <div className="flex items-start justify-between gap-3 mb-2">
          <span className="text-xs font-mono text-[#888] uppercase tracking-wider pt-1">
            Cover Image <span className="text-[#efefef]">*</span>
          </span>
          {/* Toggle + cover-mint config stacked on the right so price/supply
              live directly underneath the toggle when it's on, instead of
              spanning the full row width. */}
          <div className="flex flex-col items-end gap-2">
            <button
              type="button"
              role="switch"
              aria-checked={mintCover}
              onClick={() => setMintCover((v) => !v)}
              className={`flex items-start gap-2 px-2 py-1 border transition-colors cursor-pointer ${
                mintCover
                  ? 'border-[#8B5CF6] bg-[#8B5CF6]/10 text-[#efefef]'
                  : 'border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#bbb]'
              }`}
            >
              <span
                className={`w-4 h-4 border flex items-center justify-center flex-shrink-0 transition-colors mt-px ${
                  mintCover ? 'border-[#8B5CF6] bg-[#8B5CF6]/20' : 'border-[#444]'
                }`}
              >
                {mintCover && <Check size={11} className="text-[#8B5CF6]" />}
              </span>
              <span className="flex flex-col text-left">
                <span className="text-[10px] font-mono uppercase tracking-wider">
                  mint cover
                </span>
                {mintCover && (
                  <span className="text-[9px] font-mono text-[#888] mt-0.5 normal-case tracking-normal">
                    first mint in collection
                  </span>
                )}
              </span>
            </button>
            {mintCover && (
              <div className="flex items-center gap-3 pl-2 border-l border-[#2a2a2a]">
                <label className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-[#555] uppercase tracking-wider">price</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={coverPrice}
                    onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setCoverPrice(v) }}
                    placeholder="0"
                    className="w-16 bg-[#111] border border-[#2a2a2a] px-2 py-0.5 text-[11px] text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
                  />
                  <span className="text-[10px] font-mono text-[#555]">eth</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-[#555] uppercase tracking-wider">supply</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={coverSupply}
                    onChange={(e) => { const v = e.target.value; if (v === '' || /^[1-9]\d*$/.test(v)) setCoverSupply(v) }}
                    placeholder="∞"
                    className="w-16 bg-[#111] border border-[#2a2a2a] px-2 py-0.5 text-[11px] text-[#efefef] font-mono placeholder-[#333] placeholder:text-[16px] placeholder:leading-none focus:outline-none focus:border-[#555]"
                  />
                </label>
              </div>
            )}
          </div>
        </div>
        {coverPreview ? (
          // No aspect constraint on the wrapper — the dropped image renders
          // at full width with auto height so the box conforms to its native
          // aspect. 1:1 stays 1:1, 16:9 stays 16:9, 9:16 stays 9:16. The
          // artist sees exactly what they dropped, no letterbox or crop.
          <div className="relative bg-[#111] border border-[#2a2a2a] overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverPreview} alt="cover preview" className="block w-full h-auto" />
            <button
              type="button"
              onClick={clearFile}
              className="absolute top-2 right-2 w-7 h-7 bg-[#0d0d0d]/80 border border-[#2a2a2a] flex items-center justify-center hover:border-[#888]"
            >
              <X size={14} className="text-[#888]" />
            </button>
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files[0]
              if (!f) return
              if (coverPreview) URL.revokeObjectURL(coverPreview)
              setCoverFile(f)
              setCoverPreview(URL.createObjectURL(f))
            }}
            onDragOver={(e) => e.preventDefault()}
            // Empty drop zone keeps a default aspect for visual structure;
            // the box will reshape to the dropped file once a preview exists.
            className="aspect-square border border-dashed border-[#2a2a2a] flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-[#888] transition-colors bg-[#111]"
          >
            <Upload size={24} className="text-[#555]" />
            <div className="text-center">
              <p className="text-xs font-mono text-[#555]">drop image or click to upload</p>
              <p className="text-xs font-mono text-[#333] mt-1">image, gif</p>
            </div>
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.gif"
          onChange={handleFileChange}
          className="hidden"
        />
      </div>

      {/* Collection name */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Collection Name <span className="text-[#efefef]">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my collection"
          required
          className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="describe your collection…"
          rows={3}
          className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] resize-none"
        />
      </div>

      {/* Royalty */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Royalty (%)
        </label>
        <div className="relative">
          <input
            type="number"
            value={royaltyBps === '0' ? '' : String(parseInt(royaltyBps, 10) / 100)}
            onChange={(e) => {
              const pct = parseFloat(e.target.value) || 0
              setRoyaltyBps(String(Math.round(pct * 100)))
            }}
            min="0"
            max="100"
            step="0.5"
            placeholder="5"
            className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] pr-8"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-[#555]">%</span>
        </div>
        <p className="text-xs text-[#555] font-mono mt-1">paid to your wallet on secondary sales</p>
      </div>

      {/* Royalty recipient */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Royalty Recipient
        </label>
        <input
          type="text"
          value={royaltyRecipient}
          onChange={(e) => setRoyaltyRecipient(e.target.value)}
          placeholder={address ?? '0x… (defaults to your wallet)'}
          className="w-full bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
        />
      </div>

      {/* Authorized minters */}
      <div>
        <label className="block text-xs font-mono text-[#888] uppercase tracking-wider mb-2">
          Authorized Minters
        </label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={minterInput}
            onChange={(e) => setMinterInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              e.preventDefault()
              addMinter()
            }}
            placeholder="0x… wallet address"
            className="flex-1 bg-[#111] border border-[#2a2a2a] px-3 py-2.5 text-sm text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555]"
          />
          <button
            type="button"
            onClick={addMinter}
            className="px-3 border border-[#2a2a2a] text-[#888] hover:border-[#555] hover:text-[#efefef] transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        {minters.length > 0 && (
          <ul className="flex flex-col gap-1">
            {minters.map((m) => (
              <li key={m} className="flex items-center justify-between bg-[#111] border border-[#2a2a2a] px-3 py-2">
                <span className="text-xs font-mono text-[#888] truncate">{m}</span>
                <button
                  type="button"
                  onClick={() => setMinters((prev) => prev.filter((x) => x !== m))}
                  className="ml-2 text-[#555] hover:text-[#888] flex-shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isBusy}
        className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent"
      >
        {!isConnected
          ? 'connect wallet to deploy'
          : isBusy
          ? stepLabel(step, uploadProgress)
          : 'create'}
      </button>
    </form>
  )
}

function stepLabel(step: string, progress: number): string {
  switch (step) {
    case 'uploading-image': return progress > 0 ? `uploading image… ${progress}%` : 'uploading image…'
    case 'uploading-metadata': return 'uploading metadata…'
    case 'deploying': return 'deploying…'
    default: return 'working…'
  }
}
