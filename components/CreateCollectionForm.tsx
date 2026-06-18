'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from 'wagmi'
import { base, mainnet } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { parseEventLogs, isAddress, parseEther, type Address } from 'viem'
import { toast } from 'sonner'
import { Upload, X, Plus, Trash2, Check } from 'lucide-react'
import { FACTORY_ADDRESS, FACTORY_ABI, encodeMinterPermission, encodeAdminPermission, buildCoverTokenSetupActions } from '@/lib/collections'
import { CREATE_REFERRAL, OPERATOR_SMART_WALLET } from '@/lib/config'
import { resolveAddressOrEns } from '@/lib/address'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { canTranscode, extractGifPoster } from '@/lib/media/transcodeGif'
import { extractVideoPoster } from '@/lib/media/extractPoster'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useFileUpload } from '@/hooks/useFileUpload'
import { fetchInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { verifyDeployPermissions } from '@/lib/permissions'
import { registerCollectionWithBackoff } from '@/lib/registerCollection'
import { toastError } from '@/lib/toast'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { shortAddress } from '@/lib/inprocess'
import { useAdmin } from '@/contexts/AdminContext'
import { usePlatformPaused } from '@/hooks/usePlatformPaused'
import { usePassGate } from '@/hooks/usePassGate'

interface CreateCollectionFormProps {
  onDeployed?: (address: string, name: string) => void
}

// One verified cover-upload session per picked file — same resume pattern
// as MintForm's UploadedMediaSession. A propagation-verification false-
// negative (or a rejected deploy signature) used to discard the finished
// upload; the retry re-uploaded the same bytes under a NEW Arweave txid
// (data-item ids hash a salted RSA-PSS signature, so identical bytes never
// reuse an id), restarting the propagation clock from zero. Banking the
// upload per source file turns a retry into a RESUME: the reused txid has
// been propagating since the first attempt.
interface CoverUploadSession {
  source: File
  imageUri: string
  thumbhash: string | null
  verifyFailures: number
}

// After this many failed verification windows against the same cached
// upload, assume it's genuinely lost — or a gateway edge has its 404
// pinned — and fall back to a fresh upload (new txid, new CDN cache keys)
// on the next attempt.
const MAX_REUSE_FAILURES = 3

export function CreateCollectionForm({ onDeployed }: CreateCollectionFormProps = {}) {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { ensureSession } = useUploadSession()
  const { isAdmin } = useAdmin()
  // Deploy is a direct on-chain factory call, so it can't be gated server-
  // side by the pause switch. Block it client-side instead. Admin is exempt
  // (consistent with isPlatformPausedFor) so they can still deploy while paused.
  const { paused: platformPaused } = usePlatformPaused()
  const pausedBlock = platformPaused && !isAdmin

  // Creator-pass gate pre-check (shared with MintForm via usePassGate). When
  // the gate is on and the wallet holds no valid Pass, the deploy button is
  // swapped for a "collect Patron Collection artwork" CTA so the user isn't sent into an
  // Arweave upload + on-chain deploy for a collection the server will refuse to
  // track. UX hint only — POST /api/collections runs the authoritative
  // hasGateAccess check.
  const { gatedOut, passCollectionHref } = usePassGate()

  const {
    file: coverFile,
    preview: coverPreview,
    inputRef: fileInputRef,
    onChange: handleFileChange,
    onDrop: handleDrop,
    clear: clearFile,
  } = useFileUpload()

  // Verified-upload session caches (see CoverUploadSession above). Refs,
  // not state: they never drive rendering and must survive across submit
  // attempts. jsonUploadRef maps serialized-JSON content → its uploaded
  // txid so an unchanged contract-metadata payload reuses the previous
  // attempt's upload instead of starting a brand-new one.
  const coverUploadRef = useRef<CoverUploadSession | null>(null)
  const jsonUploadRef = useRef(new Map<string, { uri: string; failures: number }>())

  // Drop the banked upload when the user picks a different cover (or
  // clears it) so a stale session can't be deployed by accident.
  useEffect(() => {
    if (coverUploadRef.current && coverUploadRef.current.source !== coverFile) {
      coverUploadRef.current = null
    }
  }, [coverFile])

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [royaltyBps, setRoyaltyBps] = useState('500')
  const [royaltyRecipient, setRoyaltyRecipient] = useState('')
  // Minters are stored as resolved-once entries: ENS gets resolved when
  // the user clicks +, the 0x is what we encode into setupActions, and
  // the original input (.eth or 0x) is what we display so the list
  // doesn't downgrade a vitalik.eth entry to a checksum address.
  const [minters, setMinters] = useState<Array<{ display: string; address: `0x${string}` }>>([])
  const [minterInput, setMinterInput] = useState('')
  const [resolvingMinter, setResolvingMinter] = useState(false)
  const [mintCover, setMintCover] = useState(false)
  const [coverPrice, setCoverPrice] = useState('0')
  const [coverSupply, setCoverSupply] = useState('')
  const [step, setStep] = useState<'idle' | 'preparing-image' | 'uploading-image' | 'uploading-metadata' | 'deploying' | 'done'>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [collectionAddress, setCollectionAddress] = useState<string | null>(null)
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  const [deployedImageUri, setDeployedImageUri] = useState<string | undefined>(undefined)
  // Set during the upload step so the KV write below (which races the deploy
  // tx) can include the thumbhash on the collection's first KV entry — gives
  // the collection page a blurDataURL placeholder on first paint.
  const [coverThumbhash, setCoverThumbhash] = useState<string | undefined>(undefined)

  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()
  // For the post-deploy permission verification.
  const publicClient = usePublicClient({ chainId: base.id })
  // Mainnet client for ENS resolution. wagmi already configures a
  // mainnet transport (lib/wagmi.ts) — reusing it keeps the configured
  // RPC consistent with the post-deploy authorize panel.
  const mainnetClient = usePublicClient({ chainId: mainnet.id })

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

  async function addMinter() {
    if (resolvingMinter) return
    const raw = minterInput.trim()
    if (!raw) return
    setResolvingMinter(true)
    try {
      const addr = await resolveAddressOrEns(mainnetClient, raw)
      if (!addr) {
        toast.error(
          raw.endsWith('.eth')
            ? `Could not resolve ${raw}`
            : 'Invalid address — paste a 0x… or vitalik.eth name',
        )
        return
      }
      if (minters.some((m) => m.address === addr)) return
      const display = raw.endsWith('.eth') ? raw : addr
      setMinters((prev) => [...prev, { display, address: addr }])
      setMinterInput('')
    } finally {
      setResolvingMinter(false)
    }
  }

  const { data: receipt } = useWaitForTransactionReceipt({
    hash: txHash,
    // Pin to Base — the write (writeContractAsync) and the verify client both
    // target base.id, so the receipt must be read from Base too. Without this
    // the watcher polls whatever chain the connector currently reports; if it
    // isn't Base, the receipt is never found and the deploy spins forever.
    chainId: base.id,
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

    void (async () => {
      // Guard wallet disconnect between tx submission and receipt.
      if (!publicClient || !address) {
        clearPending()
        setStep('idle')
        setTxHash(undefined)
        toast.error('Deploy incomplete', {
          id: 'create-collection',
          description: 'Wallet disconnected before the transaction was verified.',
        })
        return
      }

      // Best-effort permission check. Only runs when a smart wallet was
      // resolved at deploy time — if the lookup failed (no inprocess account
      // yet, service down) we skip and let CollectionView's authorize banner
      // handle it. A failed read never blocks the success path.
      let needsAuthorize = !resolvedSmartWallet
      let smartWallet = resolvedSmartWallet
      if (!smartWallet) {
        try {
          const r = await fetchInprocessSmartWallet(address)
          smartWallet = r && 'address' in r ? r.address : null
        } catch {
          smartWallet = null
        }
      }
      if (smartWallet && isAddress(smartWallet)) {
        try {
          const verify = await verifyDeployPermissions(
            publicClient,
            deployedAddress as Address,
            address as Address,
            smartWallet as Address,
          )
          if (!verify.ok) {
            needsAuthorize = true
            console.error('[CreateCollectionForm] post-deploy verify failed', {
              collection: deployedAddress,
              deployer: address,
              smartWallet,
              detail: verify.detail,
              deployerPerms: verify.deployerPerms.toString(),
              smartWalletPerms: verify.smartWalletPerms.toString(),
            })
          }
        } catch (err) {
          // Read failed — don't block success; authorize banner covers it.
          needsAuthorize = true
          console.error('[CreateCollectionForm] post-deploy verify threw', err)
        }
      }

      setCollectionAddress(deployedAddress)
      void registerCollectionWithBackoff({
        address: deployedAddress,
        name: name.trim(),
        description: description.trim() || undefined,
        image: deployedImageUri,
        artist: address,
        coverTokenId: mintCover ? '1' : undefined,
        kismet_thumbhash: coverThumbhash,
      })
      onDeployed?.(deployedAddress, name)

      clearPending()
      setStep('done')
      toast.success(
        mintCover ? 'Collection deployed + cover minted!' : 'Collection deployed!',
        {
          id: 'create-collection',
          ...(needsAuthorize
            ? { description: 'Complete minting setup from your collection page.' }
            : {}),
        },
      )
    })()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt, step])

  // Once everything (deploy + optional cover mint) finishes, route to the new collection.
  useEffect(() => {
    if (step !== 'done' || !collectionAddress) return
    router.push(`/collection/${collectionAddress}`)
  }, [step, collectionAddress, router])

  // uploadJson with per-content reuse: identical JSON reuses the txid from
  // a previous attempt so its propagation clock keeps running across
  // retries; any field edit changes the key and uploads fresh. Entries are
  // retired after MAX_REUSE_FAILURES failed verifications (bumpJsonFailure)
  // so a genuinely lost upload self-heals with a fresh one.
  async function uploadJsonCached(json: Record<string, unknown>, key: string): Promise<string> {
    const hit = jsonUploadRef.current.get(key)
    if (hit) return hit.uri
    const uri = await uploadJson(json)
    jsonUploadRef.current.set(key, { uri, failures: 0 })
    return uri
  }

  function bumpJsonFailure(key: string) {
    const entry = jsonUploadRef.current.get(key)
    if (!entry) return
    entry.failures += 1
    if (entry.failures >= MAX_REUSE_FAILURES) jsonUploadRef.current.delete(key)
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()

    if (!isConnected || !address) {
      openConnectModal?.()
      return
    }
    // Defense in depth: the submit button is disabled while paused, but a
    // form can still submit via Enter — bail before any upload/deploy.
    if (pausedBlock) {
      toast.error('Platform is temporarily paused')
      return
    }
    // Same defense-in-depth as pausedBlock: the button is swapped for a CTA
    // when gatedOut, but Enter-submit can still reach here. Bail before any
    // upload/deploy. The server re-checks hasGateAccess at registration.
    if (gatedOut) {
      toast.error('A Patron Collection artwork is required to create a collection')
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
    const royaltyTrimmed = royaltyRecipient.trim()
    if (royaltyTrimmed && !isAddress(royaltyTrimmed) && !royaltyTrimmed.endsWith('.eth')) {
      toast.error('Invalid royalty recipient — paste a 0x… or vitalik.eth name')
      return
    }
    if (mintCover && coverSupply.trim()) {
      const s = parseInt(coverSupply.trim(), 10)
      if (isNaN(s) || s < 1) { toast.error('Cover supply must be at least 1'); return }
    }

    // Resolve the royalty recipient up-front, before any Arweave
    // upload or session prompt. An unresolvable .eth name caught here
    // costs nothing; caught after uploads it would burn an Arweave
    // entry the user can't get back. Empty -> connected wallet.
    let resolvedRoyalty: `0x${string}` = address as `0x${string}`
    if (royaltyTrimmed) {
      const resolved = await resolveAddressOrEns(mainnetClient, royaltyTrimmed)
      if (!resolved) {
        toast.error(
          royaltyTrimmed.endsWith('.eth')
            ? `Could not resolve royalty recipient ${royaltyTrimmed}`
            : 'Invalid royalty recipient address',
        )
        return
      }
      resolvedRoyalty = resolved
    }

    setDeployedImageUri(undefined)

    try {
      // Ensure session once — httpOnly cookie set, no re-prompt for 7 days
      await ensureSession()

      // Resume path: reuse the verified cover upload from a previous
      // attempt on this same file (settling false-negative or a rejected
      // deploy signature). Skips re-deriving and re-uploading the cover;
      // the reused txid has been propagating since that attempt, so the
      // verification below typically passes immediately.
      const cachedCover =
        coverUploadRef.current &&
        coverUploadRef.current.source === coverFile &&
        coverUploadRef.current.verifyFailures < MAX_REUSE_FAILURES
          ? coverUploadRef.current
          : null

      let imageUri: string
      let thumbhash: string | null
      if (cachedCover) {
        imageUri = cachedCover.imageUri
        thumbhash = cachedCover.thumbhash
        setDeployedImageUri(imageUri)
        toast.loading('Resuming previous cover upload…', { id: 'create-collection' })
      } else {
        // Animated GIF covers → first-frame JPEG. Covers never render as
        // animation, so the GIF bytes were wasted bandwidth. Best-effort.
        //
        // Video covers (drag-and-drop bypasses the picker's image-only
        // accept) → first-frame JPEG, same idea. If extraction fails we
        // throw rather than uploading the video as the cover image — the
        // contract image would render broken everywhere downstream.
        let imageFile: File = coverFile
        if (canTranscode(coverFile)) {
          setStep('preparing-image')
          toast.loading('Optimizing cover for fast loading…', { id: 'create-collection' })
          try {
            imageFile = await extractGifPoster(coverFile)
          } catch (err) {
            console.warn('[CreateCollectionForm] GIF poster extraction failed; uploading original', err)
          }
        } else if (coverFile.type.startsWith('video/')) {
          setStep('preparing-image')
          toast.loading('Extracting poster from video…', { id: 'create-collection' })
          const poster = await extractVideoPoster(coverFile)
          if (!poster) {
            throw new Error('Could not extract a poster frame from the video — upload an image instead')
          }
          imageFile = poster
        }

        setStep('uploading-image')
        setUploadProgress(0)
        toast.loading('Uploading cover image…', { id: 'create-collection' })
        const thumbhashPromise = generateThumbhash(imageFile)
        imageUri = await uploadToArweave(imageFile, (pct) => {
          setUploadProgress(pct)
          toast.loading(`Uploading image… ${pct}%`, { id: 'create-collection' })
        })
        setDeployedImageUri(imageUri)
        thumbhash = await thumbhashPromise
        // Upload done — bank the session so a verification false-negative
        // below (or an aborted deploy after it) RESUMES this upload on the
        // next attempt instead of re-uploading under a fresh txid.
        coverUploadRef.current = {
          source: coverFile,
          imageUri,
          thumbhash,
          verifyFailures: 0,
        }
      }

      // The cover image URI gets baked into the metadata JSON which gets
      // baked into the on-chain contractURI. If Turbo's data hasn't
      // propagated to Arweave gateways by the time the moment renders,
      // the image is permanently broken — re-uploading doesn't help
      // because the URI is fixed on-chain. Block on settlement before the
      // deploy. 90s budget — covers can be large and the URI is permanent;
      // a false-negative wastes the whole upload. Runs in parallel with
      // the metadata upload below.
      const imageVerify = verifyArweaveAvailable(imageUri, 90_000)

      setStep('uploading-metadata')
      toast.loading('Uploading collection metadata…', { id: 'create-collection' })
      if (thumbhash) setCoverThumbhash(thumbhash)
      const metadata: Record<string, unknown> = {
        name: name.trim(),
        description: description.trim(),
        image: imageUri,
        ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
        createReferral: CREATE_REFERRAL,
      }
      const contractKey = JSON.stringify(metadata)
      const contractURI = await uploadJsonCached(metadata, contractKey)

      // contractURI is baked on-chain by the factory — and when mint-cover
      // is on it doubles as the cover token's tokenURI — so gate on its
      // propagation too. Previously unverified: a 404 at index time left
      // the collection (and its cover moment) with broken metadata.
      toast.loading('Verifying Arweave propagation…', { id: 'create-collection' })
      const [imageOk, contractOk] = await Promise.all([
        imageVerify,
        verifyArweaveAvailable(contractURI),
      ])
      if (!imageOk || !contractOk) {
        // Failure accounting: keep reusing these uploads on retry until
        // the strike cap decides one is genuinely lost.
        if (!imageOk && coverUploadRef.current) coverUploadRef.current.verifyFailures += 1
        if (!contractOk) bumpJsonFailure(contractKey)
        // The cover is the expensive artifact — "resumable" tracks it. A
        // failed contract-metadata JSON re-uploads in seconds either way.
        const resumable =
          imageOk ||
          (coverUploadRef.current !== null &&
            coverUploadRef.current.verifyFailures < MAX_REUSE_FAILURES)
        const failedParts = [
          ...(!imageOk ? ['cover image'] : []),
          ...(!contractOk ? ['collection metadata'] : []),
        ].join(' + ')
        toast.error('Arweave is settling slowly', {
          id: 'create-collection',
          description: resumable
            ? `Not propagated yet: ${failedParts}. Your upload is saved — hit create again in a minute to resume without re-uploading.`
            : `Not propagated yet: ${failedParts}. Give it a couple of minutes and try again. We blocked the deploy to avoid permanently broken collection metadata.`,
        })
        setStep('idle')
        setUploadProgress(0)
        return
      }

      setStep('deploying')
      toast.loading(
        mintCover ? 'Deploying collection + cover token…' : 'Deploying collection…',
        { id: 'create-collection' },
      )

      await ensureBase()

      const bps = Math.max(0, Math.min(10000, parseInt(royaltyBps, 10) || 0))
      // resolvedRoyalty was computed up-front (pre-uploads) so an
      // unresolvable .eth never gets here.
      const recipient = resolvedRoyalty

      // Collection-wide minter permissions for any addresses the user added.
      // The factory replays each setupAction on the new collection during deploy.
      // Entries are pre-resolved to 0x in addMinter, so no extra validation here.
      const minterActions = minters.map((m) => encodeMinterPermission(m.address))

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
      //
      // Best-effort: resolve the artist's inprocess smart wallet so we can
      // grant it ADMIN as a setupAction at deploy time. If the wallet has
      // no inprocess account yet (404) or the service is unreachable,
      // proceed without the grant — CollectionView's authorize banner
      // handles the retroactive case. Never block deploy on this lookup.
      let inprocessSmartWallet: string | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        }
        const result = await fetchInprocessSmartWallet(address)
        if (result && 'notFound' in result) {
          // 404 — no inprocess account yet. No point retrying.
          break
        }
        if (result && 'address' in result) {
          inprocessSmartWallet = result.address
          break
        }
        // null → transient; retry
      }
      // Lift resolved address into state (may be null) so the receipt-watcher
      // can call verifyDeployPermissions without re-fetching.
      setResolvedSmartWallet(inprocessSmartWallet)
      // Grant ADMIN at deploy time when we have the smart wallet address.
      // If unresolved, CollectionView's authorize banner covers the gap.
      const inprocessAdminAction: `0x${string}`[] = []
      if (inprocessSmartWallet && isAddress(inprocessSmartWallet)) {
        inprocessAdminAction.push(
          encodeAdminPermission(inprocessSmartWallet as `0x${string}`),
        )
      }
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
        dataSuffix: BUILDER_DATA_SUFFIX,
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
      <div className="border border-line p-8 text-center flex flex-col gap-6">
        <div className="w-12 h-12 mx-auto rounded-full bg-accent/10 border border-accent flex items-center justify-center">
          <span className="text-xl accent-grad">✓</span>
        </div>
        <div>
          <h3 className="text-ink font-mono text-sm mb-2">Collection deployed</h3>
          <p className="text-dim text-xs font-mono break-all">{collectionAddress}</p>
        </div>
        {txHash && (
          <a
            href={`https://basescan.org/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-mono text-muted hover:text-dim"
          >
            {txHash.slice(0, 10)}…{txHash.slice(-8)}
          </a>
        )}
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
          className="text-xs font-mono text-dim hover:text-ink underline"
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
          <span className="text-xs font-mono text-dim uppercase tracking-wider pt-1">
            Cover Image <span className="text-ink">*</span>
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
                  ? 'border-accent bg-accent/10 text-ink'
                  : 'border-line text-dim hover:border-muted hover:text-[#bbb]'
              }`}
            >
              <span
                className={`w-4 h-4 border flex items-center justify-center flex-shrink-0 transition-colors mt-px ${
                  mintCover ? 'border-accent bg-accent/20' : 'border-[#444]'
                }`}
              >
                {mintCover && <Check size={11} className="text-accent" />}
              </span>
              <span className="flex flex-col text-left">
                <span className="text-[10px] font-mono uppercase tracking-wider">
                  mint cover
                </span>
                {mintCover && (
                  <span className="text-[9px] font-mono text-dim mt-0.5 normal-case tracking-normal">
                    first mint in collection
                  </span>
                )}
              </span>
            </button>
            {mintCover && (
              <div className="flex items-center gap-3 pl-2 border-l border-line">
                <label className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-muted uppercase tracking-wider">price</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={coverPrice}
                    onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setCoverPrice(v) }}
                    placeholder="0"
                    className="w-16 bg-surface border border-line px-2 py-0.5 text-[11px] text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
                  />
                  <span className="text-[10px] font-mono text-muted">eth</span>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-[10px] font-mono text-muted uppercase tracking-wider">supply</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={coverSupply}
                    onChange={(e) => { const v = e.target.value; if (v === '' || /^[1-9]\d*$/.test(v)) setCoverSupply(v) }}
                    placeholder="∞"
                    className="w-16 bg-surface border border-line px-2 py-0.5 text-[11px] text-ink font-mono placeholder-faint placeholder:text-[16px] placeholder:leading-none focus:outline-none focus:border-muted"
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
          <div className="relative bg-surface border border-line overflow-hidden">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={coverPreview} alt="cover preview" className="block w-full h-auto" />
            <button
              type="button"
              onClick={clearFile}
              className="absolute top-2 right-2 w-7 h-7 bg-[#0d0d0d]/80 border border-line flex items-center justify-center hover:border-dim"
            >
              <X size={14} className="text-dim" />
            </button>
          </div>
        ) : (
          <div
            onClick={() => fileInputRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
            // Empty drop zone keeps a default aspect for visual structure;
            // the box will reshape to the dropped file once a preview exists.
            className="aspect-square border border-dashed border-line flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-dim transition-colors bg-surface"
          >
            <Upload size={24} className="text-muted" />
            <div className="text-center">
              <p className="text-xs font-mono text-muted">drop image or click to upload</p>
              <p className="text-xs font-mono text-faint mt-1">image, gif</p>
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
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          Collection Name <span className="text-ink">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my collection"
          required
          className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          Description
        </label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="describe your collection…"
          rows={3}
          className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted resize-y min-h-[4.5rem] overflow-auto"
        />
      </div>

      {/* Royalty */}
      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
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
            className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted pr-8"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-mono text-muted">%</span>
        </div>
        <p className="text-xs text-muted font-mono mt-1">paid to your wallet on secondary sales</p>
      </div>

      {/* Royalty recipient */}
      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          Royalty Recipient
        </label>
        <input
          type="text"
          value={royaltyRecipient}
          onChange={(e) => setRoyaltyRecipient(e.target.value)}
          placeholder={address ? `${shortAddress(address)} (or vitalik.eth)` : '0x… or vitalik.eth (defaults to your wallet)'}
          className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
        />
      </div>

      {/* Authorized minters */}
      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
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
              void addMinter()
            }}
            placeholder="0x… or vitalik.eth"
            className="flex-1 bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
          />
          <button
            type="button"
            onClick={() => void addMinter()}
            disabled={resolvingMinter || !minterInput.trim()}
            className="px-3 border border-line text-dim hover:border-muted hover:text-ink transition-colors disabled:opacity-50"
          >
            <Plus size={14} />
          </button>
        </div>
        {minters.length > 0 && (
          <ul className="flex flex-col gap-1">
            {minters.map((m) => (
              <li key={m.address} className="flex items-center justify-between bg-surface border border-line px-3 py-2">
                <span className="text-xs font-mono text-dim truncate" title={m.address}>
                  {m.display === m.address ? shortAddress(m.address) : m.display}
                </span>
                <button
                  type="button"
                  onClick={() => setMinters((prev) => prev.filter((x) => x.address !== m.address))}
                  className="ml-2 text-muted hover:text-dim flex-shrink-0"
                >
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Submit — swaps to a "collect Patron Collection artwork" CTA when the gate is
          enabled and the wallet holds no valid Pass (mirrors MintForm), but
          NOT while a deploy is in flight (isBusy): a resumed/mid-flight deploy
          must keep showing progress, not flip to the CTA if the pass probe
          resolves gatedOut late. Otherwise the normal create button, wrapped
          in a titled span so the hover tooltip still shows while disabled by
          pause (disabled buttons don't fire hover). */}
      {gatedOut && !isBusy ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => router.push(passCollectionHref)}
            className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent"
          >
            collect Patron Collection artwork
          </button>
          <p className="text-[10px] font-mono text-muted text-center">
            creating a collection requires a Patron Collection artwork
          </p>
        </div>
      ) : (
        <span
          className="block w-full"
          title={pausedBlock ? 'Platform temporarily paused' : undefined}
        >
          <button
            type="submit"
            disabled={isBusy || pausedBlock}
            title={pausedBlock ? 'Platform temporarily paused' : undefined}
            className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {!isConnected
              ? 'connect wallet to deploy'
              : pausedBlock
              ? 'platform temporarily paused'
              : isBusy
              ? stepLabel(step, uploadProgress)
              : 'create'}
          </button>
        </span>
      )}
    </form>
  )
}

function stepLabel(step: string, progress: number): string {
  switch (step) {
    case 'preparing-image': return 'optimizing cover…'
    case 'uploading-image': return progress > 0 ? `uploading image… ${progress}%` : 'uploading image…'
    case 'uploading-metadata': return 'uploading metadata…'
    case 'deploying': return 'deploying…'
    default: return 'working…'
  }
}
