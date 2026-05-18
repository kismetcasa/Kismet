'use client'

import { useState, useRef, useEffect } from 'react'
import { MomentImage } from './MomentImage'
import { useRouter } from 'next/navigation'
import { useAccount, usePublicClient, useReadContract } from 'wagmi'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Upload, X, Plus, Trash2, ShieldCheck, ShieldAlert } from 'lucide-react'
import { parseEther, parseUnits, isAddress, type Address } from 'viem'
import { shortAddress, type CreateMomentPayload, type Split } from '@/lib/inprocess'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { canTranscode, transcodeGifToMp4 } from '@/lib/media/transcodeGif'
import { extractVideoPoster } from '@/lib/media/extractPoster'
import { remuxToFaststartMp4 } from '@/lib/media/remuxFaststart'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { useCollectionsPermissions } from '@/hooks/useCollectionsPermissions'
import { PLATFORM_COLLECTION, CREATE_REFERRAL, RESIDENCIES_ADDRESS } from '@/lib/config'
import { COLLECTION_ABI } from '@/lib/collections'
import { generateTextCollectionCoverDataUri } from '@/lib/generateTextCover'
import { hasAdminBit, readPermissions } from '@/lib/permissions'
import { registerCollectionWithBackoff } from '@/lib/registerCollection'
import { USDC_BASE } from '@/lib/zoraMint'
import { toastError } from '@/lib/toast'

type PriceCurrency = 'eth' | 'usdc'

type MintMode = 'media' | 'text'

// 0xSplits' SplitMain requires `accounts` sorted ascending by address.
// Lowercase-compare on the hex string gives the same ordering as numeric
// ascending for properly-formed addresses.
function sortSplits(s: Split[]): Split[] {
  return [...s].sort((a, b) => {
    const al = a.address.toLowerCase()
    const bl = b.address.toLowerCase()
    return al < bl ? -1 : al > bl ? 1 : 0
  })
}

// Inprocess docs (moment/create/splits): every example uses integer
// `percentAllocation` and "must sum to exactly 100%" — no decimal tolerance.
// Decimal values (like the 47.5 we used to emit when scaling 50/50 to make
// room for residencies) get mis-parsed downstream and revert the on-chain
// splits-contract setup.
//
// Round each value to the nearest integer (≥1 floor so we never silently
// drop a recipient), then absorb rounding drift round-robin until the sum
// matches `target` exactly.
function roundToIntegerAllocations(values: number[], target: number): number[] {
  const rounded = values.map((v) => Math.max(1, Math.round(v)))
  const sum = rounded.reduce((a, b) => a + b, 0)
  let drift = target - sum
  let idx = 0
  // Bound the loop generously; drift is bounded by recipient count in practice.
  const max = rounded.length * 4 + 8
  while (drift !== 0 && idx < max) {
    const i = idx % rounded.length
    if (drift > 0) {
      rounded[i] += 1
      drift -= 1
    } else if (drift < 0 && rounded[i] > 1) {
      rounded[i] -= 1
      drift += 1
    }
    idx += 1
  }
  return rounded
}

interface MintFormProps {
  collectionAddress?: string
  collectionName?: string
  onSwitchToCreate?: () => void
}

interface CollectionOption {
  address: string
  name: string
  image?: string
}

// PLATFORM_COLLECTION is filtered out of the picker (defense in depth in
// case it leaks into the user-collection list from the indexer) but is
// no longer the implicit destination for end-user mints — when nothing
// is selected, submit auto-creates a fresh collection via inprocess's
// /api/moment/create with contract.name+uri.

export function MintForm({ collectionAddress, collectionName, onSwitchToCreate }: MintFormProps = {}) {
  const router = useRouter()
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { ensureSession } = useUploadSession()
  // For post-auto-deploy permission verification — reads
  // permissions(0, smartWallet) on the freshly-deployed contract so we
  // can surface a one-shot Authorize CTA if the smart wallet didn't
  // end up with ADMIN.
  const publicClient = usePublicClient({ chainId: base.id })

  // null = auto-deploy a fresh collection on submit. Initialized from the
  // URL/prop hint when present; cleared back to null via the × button.
  const [selectedCollection, setSelectedCollection] = useState<CollectionOption | null>(() => {
    if (collectionAddress) {
      return {
        address: collectionAddress,
        name: collectionName ?? shortAddress(collectionAddress),
      }
    }
    return null
  })
  const [userCollections, setUserCollections] = useState<CollectionOption[]>([])
  const [loadingCollections, setLoadingCollections] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const targetCollection = selectedCollection?.address

  // Sync the picker when MintTabs hands us a freshly-deployed collection or
  // the URL params change. User-driven picker selections still override on
  // subsequent state updates.
  useEffect(() => {
    if (collectionAddress) {
      setSelectedCollection({
        address: collectionAddress,
        name: collectionName ?? shortAddress(collectionAddress),
      })
    }
  }, [collectionAddress, collectionName])

  // Fetch the connected user's deployed collections so the picker can list
  // them as overrides to the auto-deploy default. /api/collections?artist=…
  // is creator-aware: the user always sees their own (including hidden ones).
  useEffect(() => {
    if (!address) {
      setUserCollections([])
      return
    }
    let cancelled = false
    setLoadingCollections(true)
    fetch(`/api/collections?artist=${address}`)
      .then((r) => (r.ok ? r.json() : { collections: [] }))
      .then((d) => {
        if (cancelled) return
        type ApiCollection = {
          contractAddress?: string
          name?: string
          metadata?: { name?: string; image?: string }
        }
        const items: CollectionOption[] = (Array.isArray(d.collections) ? d.collections : [])
          .map((c: ApiCollection) => {
            if (!c.contractAddress) return null
            return {
              address: c.contractAddress,
              name: c.metadata?.name ?? c.name ?? shortAddress(c.contractAddress),
              image: c.metadata?.image,
            }
          })
          .filter((c: CollectionOption | null): c is CollectionOption => c !== null)
        setUserCollections(items)
      })
      .catch(() => {
        if (!cancelled) setUserCollections([])
      })
      .finally(() => {
        if (!cancelled) setLoadingCollections(false)
      })
    return () => {
      cancelled = true
    }
  }, [address])

  // Picker dropdown lists the user's deployed collections. The platform
  // collection is filtered out as defense in depth — even if it leaked
  // into the user's collection list from the indexer, we never want
  // end-user mints routing into it (curated content only).
  const collectionOptions: CollectionOption[] = userCollections.filter(
    (c) => c.address.toLowerCase() !== PLATFORM_COLLECTION.toLowerCase(),
  )
  // No collection selected → auto-create one on submit via
  // /api/moment/create with contract.name+uri.
  const isAutoDeploy = !selectedCollection

  // Batch-read permissions for the user's existing collections so the
  // picker can show ⚠️ badges on rows where the smart wallet is
  // missing ADMIN. Selecting a flagged row still works — the inline
  // banner below the picker routes the user to the collection page
  // to authorize.
  const {
    byAddress: collectionsPerms,
    missingCount: collectionsMissingAdmin,
  } = useCollectionsPermissions(collectionOptions.map((c) => c.address))

  // Client-side preflight on the SELECTED collection. Saves an Arweave
  // round-trip when the smart wallet isn't ADMIN — the form blocks
  // submit and surfaces an Authorize CTA before any upload work.
  // Skipped in auto-deploy mode (no collection to read yet); auto-
  // deploy uses post-mint verification in trackAndVerifyAutoDeploy
  // below.
  //
  // We check the ADMIN bit specifically because inprocess's relay
  // requires it for setupNewToken — MINTER alone won't work through
  // the relay even though Zora's contract would accept it.
  const { address: smartWalletForCaller } = useInprocessSmartWallet(address)
  const { data: smartWalletPerms } = useReadContract({
    address: targetCollection ? (targetCollection as `0x${string}`) : undefined,
    abi: COLLECTION_ABI,
    functionName: 'permissions',
    args:
      smartWalletForCaller && isAddress(smartWalletForCaller)
        ? [0n, smartWalletForCaller as `0x${string}`]
        : undefined,
    query: {
      enabled:
        !!smartWalletForCaller &&
        !!targetCollection &&
        isAddress(targetCollection) &&
        !isAutoDeploy,
    },
  })
  // True only when the read has resolved AND it shows missing ADMIN.
  // Distinguishing from "still loading" matters: we don't want the banner
  // flickering in for a frame between mount and the first read.
  const preflightUnauthorized =
    !isAutoDeploy &&
    !!smartWalletForCaller &&
    smartWalletPerms !== undefined &&
    !hasAdminBit(smartWalletPerms as bigint)

  const [mintMode, setMintMode] = useState<MintMode>('media')
  const {
    file,
    preview,
    inputRef: fileInputRef,
    onChange: handleFileChange,
    onDrop: handleDrop,
    clear: clearFile,
  } = useFileUpload({
    maxBytes: 420 * 1024 * 1024,
    onTooLarge: () => toast.error('File too large', { description: 'Maximum file size is 420 MB' }),
  })
  const [textContent, setTextContent] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [price, setPrice] = useState('0')
  const [priceCurrency, setPriceCurrency] = useState<PriceCurrency>('eth')
  const [maxSupply, setMaxSupply] = useState('')
  const [splits, setSplits] = useState<Split[]>([])
  const [splitInput, setSplitInput] = useState({ address: '', pct: '' })
  const [residenciesEnabled, setResidenciesEnabled] = useState(true)
  const [step, setStep] = useState<'idle' | 'preparing-media' | 'uploading-media' | 'uploading-metadata' | 'verifying-upload' | 'minting' | 'done'>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [result, setResult] = useState<{ hash: string; contractAddress: string; tokenId: string } | null>(null)
  // Address of an auto-deployed collection where the smart wallet did
  // NOT end up with ADMIN. Surfaces as a persistent warning in the
  // success card; cleared by the "Mint another" handler.
  const [autoDeployNeedsAuth, setAutoDeployNeedsAuth] = useState<string | null>(null)
  // Race guard for the fire-and-forget post-mint verify: if the user
  // clicks "Mint another" before the verify settles, this ref gets
  // nulled and the helper bails before writing stale state.
  const verifyTargetRef = useRef<string | null>(null)

  const splitsTotal = splits.reduce((s, r) => s + r.percentAllocation, 0)
  // 1/1 has no public sale (the creator's auto-mint exhausts supply), so
  // the price input is hidden and the salesConfig price is forced to 0.
  // Media-only — text mode hides Supply, so a stale `1` from a prior
  // media session can't sneak through.
  const is11 = mintMode === 'media' && maxSupply.trim() === '1'

  function switchMode(mode: MintMode) {
    setMintMode(mode)
    if (mode === 'text') clearFile()
    else setTextContent('')
  }

  // Detects the auth-failure paths that come back when minting into a
  // collection where inprocess's smart account isn't yet ADMIN:
  //   - structured 403 with code 'AUTHORIZE_REQUIRED' (mint-proxy's
  //     server-side preflight catches it before the userOp ever runs)
  //   - the userOp-revert phrasing (fallback when the preflight returns
  //     'unknown' due to RPC flake and inprocess is the source of truth)
  // Shows an actionable toast (button → the collection's authorize
  // banner) and resets form state; caller bails out without throwing
  // so the generic toastError path doesn't fire.
  //
  // Gated on having a selected collection. In auto-deploy mode there's
  // no pre-existing collection to authorize against — the contract
  // doesn't exist yet, so the AUTHORIZE_REQUIRED code can't fire. Any
  // failure in auto-deploy mode is a deploy-time error, surfaced
  // through the generic toast path with the upstream message intact.
  function maybeHandleAuthError(raw: string, data?: { code?: unknown }): boolean {
    const isAuthCode = data?.code === 'AUTHORIZE_REQUIRED'
    const isAuthRevert = /useroperation reverted|user operation reverted|execution reverted/i.test(raw)
    if (isAutoDeploy || !targetCollection || (!isAuthCode && !isAuthRevert)) {
      return false
    }
    toast.error('Authorization required', {
      id: 'mint',
      description:
        "This collection hasn't authorized Kismet for minting. One-time onchain grant from your wallet.",
      action: {
        label: 'Authorize',
        onClick: () => router.push(`/collection/${targetCollection}`),
      },
    })
    setStep('idle')
    setUploadProgress(0)
    return true
  }

  function addSplit() {
    const addr = splitInput.address.trim()
    const pct = parseFloat(splitInput.pct)
    if (!isAddress(addr)) { toast.error('Invalid address'); return }
    if (isNaN(pct) || pct <= 0 || pct > 100) { toast.error('Allocation must be 1–100'); return }
    if (splitsTotal + pct > 100) { toast.error('Total allocation exceeds 100%'); return }
    // EVM addresses are case-insensitive but 0xSplits' SplitMain rejects
    // byte-level duplicates, so "0xABC" + "0xabc" would revert the deploy.
    const lowerAddr = addr.toLowerCase()
    if (splits.some((s) => s.address.toLowerCase() === lowerAddr)) {
      toast.error('Address already added')
      return
    }
    // When residencies is ON, buildFinalSplits auto-appends RESIDENCIES_ADDRESS
    // at 5%. Letting the user add it manually creates a duplicate that
    // SplitMain rejects.
    if (residenciesEnabled && lowerAddr === RESIDENCIES_ADDRESS.toLowerCase()) {
      toast.error('Residencies is already on below — disable the toggle first to set its allocation manually')
      return
    }
    setSplits((prev) => [...prev, { address: addr, percentAllocation: pct }])
    setSplitInput({ address: '', pct: '' })
  }

  const TEXT_MAX = 5000

  // Builds the final splits array to send to the API. Inprocess docs require
  // integer `percentAllocation` summing to exactly 100% — every code path
  // here emits integers via roundToIntegerAllocations + appends residencies
  // (5%) when the toggle is on.
  //
  //   residencies OFF + 0/1 splits  → undefined (caller uses payoutRecipient)
  //   residencies OFF + 2+ splits   → sorted user splits (rounded to integers)
  //   residencies ON  + 0/1 splits  → [creator 95, residencies 5] (sorted)
  //   residencies ON  + 2+ splits   → user splits scaled ×0.95 to integers
  //                                   summing to 95, plus residencies 5
  //
  // 0xSplits' SplitMain requires `accounts` sorted ascending — sort
  // defensively in case inprocess forwards our array as-is.
  function buildFinalSplits(): Split[] | undefined {
    if (!residenciesEnabled) {
      if (splits.length < 2) return undefined
      const rounded = roundToIntegerAllocations(
        splits.map((s) => s.percentAllocation),
        100,
      )
      return sortSplits(
        splits.map((s, i) => ({ address: s.address, percentAllocation: rounded[i] })),
      )
    }
    if (splits.length < 2) {
      return sortSplits([
        { address: address!, percentAllocation: 95 },
        { address: RESIDENCIES_ADDRESS, percentAllocation: 5 },
      ])
    }
    const rounded = roundToIntegerAllocations(
      splits.map((s) => s.percentAllocation * 0.95),
      95,
    )
    return sortSplits([
      ...splits.map((s, i) => ({ address: s.address, percentAllocation: rounded[i] })),
      { address: RESIDENCIES_ADDRESS, percentAllocation: 5 },
    ])
  }

  async function handleMint(e: React.FormEvent) {
    e.preventDefault()

    if (!isConnected || !address) { openConnectModal?.(); return }
    // Bail before any Arweave upload if the smart wallet isn't ADMIN.
    // The banner above the form still renders the Authorize CTA.
    if (preflightUnauthorized) {
      toast.error('Authorization required', {
        id: 'mint',
        description:
          "This collection hasn't authorized Kismet for minting. Tap Authorize on the banner above to grant ADMIN.",
      })
      return
    }
    if (!name.trim()) { toast.error('Please enter a title'); return }
    // Auto-deploy uses the moment title as the collection name. Users
    // who want more control over the collection (separate name, royalty,
    // etc.) flow through the dedicated Create Collection tab via the
    // dropdown's "+ create new collection" entry.
    const resolvedCollectionName = isAutoDeploy
      ? name.trim()
      : (selectedCollection?.name ?? '')
    if (mintMode === 'media' && !file) { toast.error('Please select a file to mint'); return }
    if (mintMode === 'text' && !textContent.trim()) { toast.error('Please enter text content'); return }
    if (mintMode === 'text' && textContent.length > TEXT_MAX) {
      toast.error(`Text exceeds ${TEXT_MAX.toLocaleString()} character limit`)
      return
    }
    if (splits.length === 1) { toast.error('Splits require at least 2 recipients'); return }
    if (splits.length > 1 && Math.round(splitsTotal * 100) !== 10000) {
      toast.error(`Split allocations must sum to 100% (currently ${splitsTotal}%)`)
      return
    }
    // Defense in depth: catches any state drift where residencies got into
    // custom splits while the toggle is also on (e.g. via stale tab state).
    if (residenciesEnabled && splits.some((s) => s.address.toLowerCase() === RESIDENCIES_ADDRESS.toLowerCase())) {
      toast.error('Residencies is in your custom splits — remove it or disable the toggle')
      return
    }

    const rawPrice = is11 ? '0' : price.trim()
    const normalizedPrice = !rawPrice || rawPrice === '.' ? '0' : rawPrice.startsWith('.') ? `0${rawPrice}` : rawPrice
    // ETH: 18 decimals (parseEther). USDC: 6 decimals (parseUnits with 6).
    // erc20Mint type also requires the currency address per inprocess docs
    // (moment/create/salesConfig.mdx). Native ETH uses fixedPrice with no
    // currency field.
    const priceInBaseUnits = priceCurrency === 'usdc'
      ? parseUnits(normalizedPrice, 6).toString()
      : parseEther(normalizedPrice).toString()
    const now = Math.floor(Date.now() / 1000)
    const salesConfig = priceCurrency === 'usdc'
      ? {
          type: 'erc20Mint' as const,
          pricePerToken: priceInBaseUnits,
          saleStart: String(now),
          saleEnd: '18446744073709551615',
          currency: USDC_BASE,
        }
      : {
          type: 'fixedPrice' as const,
          pricePerToken: priceInBaseUnits,
          saleStart: String(now),
          saleEnd: '18446744073709551615',
        }
    const supplyTrimmed = maxSupply.trim()
    if (supplyTrimmed) {
      const supplyNum = parseInt(supplyTrimmed, 10)
      if (isNaN(supplyNum) || supplyNum < 1) { toast.error('Supply must be at least 1'); return }
    }
    const maxSupplyVal = supplyTrimmed ? parseInt(supplyTrimmed, 10) : undefined

    const finalSplits = buildFinalSplits()

    // After a successful auto-deploy mint: register the new collection
    // in KV and verify the smart wallet ended up with ADMIN. The mint
    // itself is real on chain regardless of how this goes — both calls
    // fire-and-forget; failures log to console.
    async function trackAndVerifyAutoDeploy(
      contractAddress: string,
      imageUri: string | undefined,
      thumbhash?: string,
    ): Promise<void> {
      verifyTargetRef.current = contractAddress

      // Mark this contract as an auto-deployed wrapper (the protocol
      // creates one per first-mint when no collection is picked). The
      // server records it in the tracked set for moment fan-out but
      // keeps it out of the Collections feed and the artist's "Collections"
      // section — auto-deploy wrappers belong with mints, not collections.
      await registerCollectionWithBackoff({
        address: contractAddress,
        name: resolvedCollectionName,
        description: description.trim() || undefined,
        image: imageUri,
        artist: address,
        source: 'auto-deploy',
        kismet_thumbhash: thumbhash,
      })

      if (publicClient && smartWalletForCaller && isAddress(smartWalletForCaller)) {
        try {
          const perms = await readPermissions(
            publicClient,
            contractAddress as Address,
            0n,
            smartWalletForCaller as Address,
          )
          if (!hasAdminBit(perms)) {
            console.warn(
              '[MintForm] auto-deploy: smart wallet missing ADMIN on new collection',
              {
                collection: contractAddress,
                smartWallet: smartWalletForCaller,
                perms: perms.toString(),
              },
            )
            // Bail if "Mint another" already cleared the target.
            if (verifyTargetRef.current !== contractAddress) return
            setAutoDeployNeedsAuth(contractAddress)
            toast.info('Authorize for next mint', {
              description:
                "Moment minted. For follow-up mints into this collection, grant Kismet ADMIN.",
              action: {
                label: 'Authorize',
                onClick: () => router.push(`/collection/${contractAddress}`),
              },
            })
          }
        } catch (err) {
          // RPC failure ≠ permission failure. Log only — the moment
          // succeeded; we'd rather not show an alarming toast based on
          // a transient read error.
          console.warn(
            '[MintForm] post-auto-deploy permission read threw',
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }

    try {
      if (mintMode === 'text') {
        // Text moments have no media file to reuse as a cover, so
        // auto-deploy uploads a small collection-metadata JSON whose
        // `image` field is an inline SVG (see lib/generateTextCover.ts).
        // Without a cover, marketplace cards fall back to broken-image
        // icons.
        let contractField:
          | { address: string }
          | { name: string; uri: string }
        if (isAutoDeploy) {
          await ensureSession()
          setStep('uploading-metadata')
          toast.loading('Uploading collection metadata…', { id: 'mint' })
          const collectionMetadata: Record<string, unknown> = {
            name: resolvedCollectionName,
            description: description.trim() || undefined,
            image: generateTextCollectionCoverDataUri(resolvedCollectionName),
            createReferral: CREATE_REFERRAL,
          }
          const collectionUri = await uploadJson(collectionMetadata)
          setStep('verifying-upload')
          toast.loading('Verifying Arweave propagation…', { id: 'mint' })
          const ok = await verifyArweaveAvailable(collectionUri)
          if (!ok) {
            throw new Error(
              'Arweave still settling (collection metadata not yet propagated) — try again in a minute',
            )
          }
          contractField = { name: resolvedCollectionName, uri: collectionUri }
        } else {
          contractField = { address: targetCollection! }
        }

        setStep('minting')
        toast.loading('Minting moment…', { id: 'mint' })

        // Writing-moment payload per inprocess docs (moment/create/writing.mdx):
        // - `title` lives at the top level (not inside token, and not aliased as "name")
        // - the writing body lives at `token.tokenContent` (not "content")
        // - no `maxSupply` — the writing endpoint doesn't accept it
        // The top-level `name` is our private hint that mint-proxy strips before
        // forwarding upstream — used to populate the moment-meta KV entry.
        const payload = {
          title: name.trim(),
          contract: contractField,
          token: {
            tokenContent: textContent.trim(),
            createReferral: CREATE_REFERRAL,
            salesConfig,
            mintToCreatorCount: 1,
            ...(finalSplits ? {} : { payoutRecipient: address }),
          },
          name: name.trim(),
          account: address,
          ...(finalSplits ? { splits: finalSplits } : {}),
        }

        const res = await fetch('/api/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const errors = Array.isArray(data.errors)
            ? ': ' + data.errors.map((e: { field?: string; message?: string }) => `${e.field ?? ''} ${e.message ?? ''}`.trim()).join(', ')
            : ''
          const raw = (data.detail ?? data.error ?? data.message ?? 'Mint failed') + errors
          if (maybeHandleAuthError(raw, data)) return
          throw new Error(raw)
        }
        if (!data.tokenId) throw new Error('Mint succeeded but no tokenId returned')
        setResult(data)
        if (isAutoDeploy && data.contractAddress) {
          // Text moments don't have a media file, so the new
          // collection's cover stays unset (image: undefined). User
          // can update it later via collection-management UI.
          void trackAndVerifyAutoDeploy(data.contractAddress, undefined)
        }
        setStep('done')
        toast.success('Minted!', { id: 'mint', description: `Token #${data.tokenId}` })

      } else {
        // media mode — ensure session once (cookie cached, no re-prompt)
        await ensureSession()

        // GIFs get transcoded to MP4 + JPEG poster (10-50× smaller; plays
        // through the existing <video> branch). Best-effort: any failure
        // falls back to uploading the original GIF unchanged.
        //
        // Artist-uploaded videos (mp4/webm/mov/etc) skip the transcode but
        // still need a poster — without one, `meta.image` would either be
        // undefined (no preview anywhere) or, with the legacy fallback,
        // the video URL itself (renders broken as an <img> src). Extract
        // the first frame natively so every video moment has a real
        // still-frame for cards, modals, og:image, and the detail page.
        let mediaFile: File = file!
        let posterFile: File | null = null
        if (canTranscode(file!)) {
          setStep('preparing-media')
          setUploadProgress(0)
          toast.loading('Optimizing animation for fast playback…', { id: 'mint' })
          try {
            const { mp4, poster } = await transcodeGifToMp4(file!, (pct) => {
              setUploadProgress(pct)
              toast.loading(`Optimizing animation… ${pct}%`, { id: 'mint' })
            })
            mediaFile = mp4
            posterFile = poster
          } catch (err) {
            console.warn('[MintForm] GIF transcode failed; uploading original', err)
          }
        } else if (file!.type.startsWith('video/')) {
          setStep('preparing-media')
          toast.loading('Optimizing video for fast playback…', { id: 'mint' })
          // Best-effort lossless remux to faststart MP4. Null falls
          // through to the source unchanged.
          try {
            const remuxed = await remuxToFaststartMp4(file!)
            if (remuxed) mediaFile = remuxed
          } catch (err) {
            console.warn('[MintForm] faststart remux failed; uploading original', err)
          }
          toast.loading('Extracting poster from video…', { id: 'mint' })
          try {
            posterFile = await extractVideoPoster(file!)
          } catch (err) {
            console.warn('[MintForm] video poster extraction failed', err)
          }
        }

        setStep('uploading-media')
        setUploadProgress(0)
        toast.loading('Uploading media to Arweave…', { id: 'mint' })
        // Hash the poster when transcoded so the placeholder matches the
        // static frame feeds render; otherwise the source media itself.
        const thumbhashPromise = generateThumbhash(posterFile ?? mediaFile)
        const mediaUri = await uploadToArweave(mediaFile, (pct) => {
          setUploadProgress(pct)
          toast.loading(`Uploading media… ${pct}%`, { id: 'mint' })
        })
        const posterUriPromise: Promise<string | null> = posterFile
          ? uploadToArweave(posterFile).catch((err) => {
              console.warn('[MintForm] poster upload failed', err)
              return null
            })
          : Promise.resolve(null)
        // Start propagation polling the moment each upload returns, so
        // it runs in parallel with subsequent uploads instead of
        // staircasing after them. By the time we block below, media
        // has had the metadata- (and collection-metadata-) upload
        // duration as free propagation buffer.
        // Media bundles up to 420 MB can take longer than the 45s default
        // to surface across the gateway pool, so widen the budget here —
        // a false-negative wastes the user's entire upload.
        const mediaVerify = verifyArweaveAvailable(mediaUri, 90_000)

        setStep('uploading-metadata')
        setUploadProgress(0)
        toast.loading('Uploading metadata…', { id: 'mint' })
        const [thumbhash, posterUri] = await Promise.all([thumbhashPromise, posterUriPromise])
        const posterVerify = posterUri ? verifyArweaveAvailable(posterUri) : Promise.resolve(true)
        // Poster (when extracted) wins as `image` so feeds render the
        // static frame; the moving asset goes to animation_url. For video
        // media, never fall back to the MP4 URL as the image — the
        // renderer would try to load it as an <img> src and fail, leaving
        // a black card. Better to leave image undefined and let the
        // thumbhash + icon placeholder cover the slot.
        const isVideoMedia = mediaFile.type.startsWith('video/')
        const imageUri = isVideoMedia ? posterUri : (posterUri ?? mediaUri)
        const metadata = {
          name: name.trim(),
          description: description.trim(),
          ...(imageUri ? { image: imageUri } : {}),
          ...(isVideoMedia ? { animation_url: mediaUri } : {}),
          ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
        }
        const metadataUri = await uploadJson(metadata)
        const metadataVerify = verifyArweaveAvailable(metadataUri)

        // Auto-deploy: the moment's media doubles as the collection cover.
        // Covers don't surface animation_url, so the poster (when present)
        // is what feed cards actually render. Same constraint as `image`
        // above — for video media, never fall back to the MP4 URL.
        let collectionUri: string | null = null
        let collectionVerify: Promise<boolean> = Promise.resolve(true)
        const coverImageUri = isVideoMedia ? posterUri : (posterUri ?? mediaUri)
        if (isAutoDeploy) {
          toast.loading('Uploading collection metadata…', { id: 'mint' })
          const collectionMetadata = {
            name: resolvedCollectionName,
            description: description.trim(),
            ...(coverImageUri ? { image: coverImageUri } : {}),
            ...(thumbhash ? { kismet_thumbhash: thumbhash } : {}),
            createReferral: CREATE_REFERRAL,
          }
          collectionUri = await uploadJson(collectionMetadata)
          collectionVerify = verifyArweaveAvailable(collectionUri)
        }

        // Block on all three settling before kicking off the on-chain
        // mint. Turbo confirms ingestion before the gateway has
        // propagated, so jumping straight to /api/mint can produce a
        // moment whose metadata fetches 404 at indexing time. 45s
        // budget per URI covers the typical propagation window; on
        // timeout we surface a retry message rather than commit a
        // broken moment.
        setStep('verifying-upload')
        toast.loading('Verifying Arweave propagation…', { id: 'mint' })
        const [mediaOk, metadataOk, collectionOk, posterOk] = await Promise.all([
          mediaVerify,
          metadataVerify,
          collectionVerify,
          posterVerify,
        ])
        if (!mediaOk || !metadataOk || !collectionOk || !posterOk) {
          const failed: string[] = []
          if (!mediaOk) failed.push('media')
          if (!metadataOk) failed.push('metadata')
          if (!collectionOk) failed.push('collection metadata')
          if (!posterOk) failed.push('poster frame')
          throw new Error(
            `Arweave still settling (${failed.join(' + ')} not yet propagated) — try again in a minute`,
          )
        }

        setStep('minting')
        toast.loading('Minting moment…', { id: 'mint' })

        const payload: CreateMomentPayload & { name: string } = {
          contract: isAutoDeploy
            ? { name: resolvedCollectionName, uri: collectionUri! }
            : { address: targetCollection! },
          token: {
            tokenMetadataURI: metadataUri,
            createReferral: CREATE_REFERRAL,
            salesConfig,
            mintToCreatorCount: 1,
            ...(maxSupplyVal !== undefined ? { maxSupply: maxSupplyVal } : {}),
            ...(finalSplits ? {} : { payoutRecipient: address }),
          },
          name: name.trim(),
          account: address!,
          ...(finalSplits ? { splits: finalSplits } : {}),
        }

        const res = await fetch('/api/mint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          const errors = Array.isArray(data.errors)
            ? ': ' + data.errors.map((e: { field?: string; message?: string }) => `${e.field ?? ''} ${e.message ?? ''}`.trim()).join(', ')
            : ''
          const raw = (data.detail ?? data.error ?? data.message ?? 'Mint failed') + errors
          if (maybeHandleAuthError(raw, data)) return
          throw new Error(raw)
        }
        if (!data.tokenId) throw new Error('Mint succeeded but no tokenId returned')
        setResult(data)
        if (isAutoDeploy && data.contractAddress) {
          // The moment's media doubles as the collection cover for
          // first-mint UX; pass the cover URI (poster when transcoded,
          // mediaUri otherwise) so the KV registration can store it and
          // the collection card has a non-blank image immediately.
          // thumbhash piggybacks for the cover placeholder.
          void trackAndVerifyAutoDeploy(data.contractAddress, coverImageUri ?? undefined, thumbhash ?? undefined)
        }
        setStep('done')
        toast.success('Minted!', { id: 'mint', description: `Token #${data.tokenId}` })
      }
    } catch (err) {
      setStep('idle')
      setUploadProgress(0)
      toastError('Mint', err, { id: 'mint' })
    }
  }

  const isBusy = step !== 'idle' && step !== 'done'

  if (step === 'done' && result) {
    return (
      <div className="border border-line p-8 text-center flex flex-col gap-6">
        <div className="w-12 h-12 mx-auto rounded-full bg-accent/10 border border-accent flex items-center justify-center">
          <span className="text-xl accent-grad">✓</span>
        </div>
        <div>
          <h3 className="text-ink font-mono text-sm mb-2">Moment minted</h3>
          <p className="text-dim text-xs font-mono">Token #{result.tokenId}</p>
        </div>
        <button
          type="button"
          onClick={() => router.push(`/moment/${result.contractAddress}/${result.tokenId}`)}
          className="text-xs font-mono uppercase tracking-wider px-4 py-2 btn-accent self-center"
        >
          Moment details →
        </button>
        <a
          href={`https://basescan.org/tx/${result.hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-muted hover:text-dim"
        >
          {result.hash.slice(0, 10)}…{result.hash.slice(-8)}
        </a>
        {/* Persistent warning when an auto-deploy left the smart
            wallet without ADMIN on the new contract — without it the
            user would only see the transient post-mint toast. Routes
            to the collection page's existing Authorize banner. */}
        {autoDeployNeedsAuth && (
          <div className="text-left p-3 sm:p-4 border border-accent/40 bg-accent/5 flex items-start gap-2.5">
            <ShieldAlert size={14} className="text-accent flex-shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-mono text-ink">
                Authorize for follow-up mints
              </p>
              <p className="text-[11px] font-mono text-dim mt-1">
                Your moment is on chain. To mint more into this collection, grant Kismet ADMIN — one onchain tx from your wallet.
              </p>
              <button
                type="button"
                onClick={() => router.push(`/collection/${autoDeployNeedsAuth}`)}
                className="mt-2.5 text-[10px] font-mono uppercase tracking-wider px-4 py-2 btn-accent"
              >
                authorize →
              </button>
            </div>
          </div>
        )}
        <button
          onClick={() => {
            setStep('idle')
            setResult(null)
            setAutoDeployNeedsAuth(null)
            // Signal any in-flight verify to bail before writing stale
            // state against this freshly-reset form.
            verifyTargetRef.current = null
            clearFile()
            setTextContent('')
            setName('')
            setDescription('')
            setPrice('0')
            setMaxSupply('')
            setSplits([])
            setSplitInput({ address: '', pct: '' })
          }}
          className="text-xs font-mono text-dim hover:text-ink underline"
        >
          Mint another
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={handleMint} className="flex flex-col gap-6">
      {/* Inline preflight banner — same on-chain check the mint-proxy
          runs, surfaced earlier in the lifecycle so we don't burn an
          Arweave upload before discovering missing ADMIN. */}
      {preflightUnauthorized && (
        <div className="p-3 sm:p-4 border border-accent/40 bg-accent/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <ShieldCheck size={16} className="text-accent flex-shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-mono text-ink">
                Authorize Kismet to mint into {selectedCollection.name}
              </p>
              <p className="text-[11px] font-mono text-dim mt-0.5">
                One-time onchain grant from the collection&apos;s admin. Required before this collection can mint moments via Kismet.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => router.push(`/collection/${targetCollection}`)}
            className="flex-shrink-0 text-xs font-mono tracking-wider uppercase px-4 py-2 btn-accent"
          >
            authorize
          </button>
        </div>
      )}

      {/* Media / Text toggle */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-xs font-mono text-dim uppercase tracking-wider">
            {mintMode === 'media' ? 'Media' : 'Content'} <span className="text-ink">*</span>
          </label>
          <button
            type="button"
            onClick={() => switchMode(mintMode === 'text' ? 'media' : 'text')}
            className={`px-2.5 py-1 text-[10px] font-mono uppercase tracking-wider border transition-colors ${
              mintMode === 'text' ? 'border-muted text-ink' : 'border-line text-muted hover:text-dim'
            }`}
          >
            text
          </button>
        </div>

        {mintMode === 'media' ? (
          <>
            {preview ? (
              // No aspect constraint on the wrapper — image/video render at
              // full width with auto height, so the box conforms to whatever
              // the artist dropped. 16:9 stays 16:9, 9:16 stays 9:16, 1:1
              // stays 1:1. No letterbox, no crop, no surprise.
              <div className="relative bg-surface border border-line overflow-hidden">
                {file?.type.startsWith('video/') ? (
                  <video src={preview} className="block w-full h-auto" muted autoPlay loop playsInline />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="preview" className="block w-full h-auto" />
                )}
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
                // Compact square placeholder. The preview state below is
                // dynamic (block w-full h-auto), so the drop zone aspect
                // doesn't need to match anything specific — square keeps the
                // empty target obvious without dominating the form. Same
                // aspect as the cover-image drop zone for visual consistency.
                className="aspect-square border border-dashed border-line flex flex-col items-center justify-center gap-3 cursor-pointer hover:border-dim transition-colors bg-surface"
              >
                <Upload size={24} className="text-muted" />
                <div className="text-center">
                  <p className="text-xs font-mono text-muted">drop file or click to upload</p>
                  <p className="text-xs font-mono text-faint mt-1">
                    image, video, gif,{' '}
                    {/* "text" is a shortcut into the writing-moment mode.
                        stopPropagation so we don't also trigger the parent
                        drop zone's file-picker click handler. */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        switchMode('text')
                      }}
                      className="hover:underline cursor-pointer"
                    >
                      text
                    </button>
                  </p>
                </div>
              </div>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*,.gif"
              onChange={handleFileChange}
              className="hidden"
            />
          </>
        ) : (
          <>
            <textarea
              value={textContent}
              onChange={(e) => setTextContent(e.target.value)}
              placeholder="write your moment…"
              rows={12}
              className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted resize-none"
            />
            <div
              className={`mt-1.5 text-right text-[10px] font-mono ${
                textContent.length > TEXT_MAX ? 'accent-grad' : 'text-muted'
              }`}
            >
              {textContent.length.toLocaleString()} / {TEXT_MAX.toLocaleString()}
            </div>
          </>
        )}
      </div>

      {/* Title */}
      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          Title <span className="text-ink">*</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="untitled"
          required
          className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
        />
      </div>

      {/* Description — only meaningful for media moments (goes into Arweave
          metadata). The inprocess writing endpoint has no description field. */}
      {mintMode === 'media' && (
        <div>
          <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
            Description
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="describe your work…"
            rows={3}
            className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted resize-y min-h-[4.5rem] overflow-auto"
          />
        </div>
      )}

      {/* Price + Supply — placed before the Collection picker so the
          submission-shape fields cluster together; the picker (which can
          be left at "auto-deploy") sits below as a step-down decision. */}
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
            Price
          </label>
          <div className="relative">
            <input
              type="text"
              inputMode="decimal"
              value={is11 ? '0' : price}
              disabled={is11}
              onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setPrice(v) }}
              className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted pr-14 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <button
              type="button"
              onClick={() => setPriceCurrency((c) => c === 'eth' ? 'usdc' : 'eth')}
              disabled={is11}
              title="toggle currency"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-mono text-dim hover:text-ink transition-colors px-1.5 py-0.5 rounded disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:text-dim"
            >
              {priceCurrency === 'eth' ? 'ETH' : 'USDC'}
            </button>
          </div>
          {price === '0' && !is11 && (
            <p className="text-xs text-muted font-mono mt-1">free mint</p>
          )}
        </div>

        {mintMode === 'media' && (
          <div className="flex-1">
            <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
              Supply
            </label>
            <input
              type="text"
              inputMode="numeric"
              value={maxSupply}
              onChange={(e) => { const v = e.target.value; if (v === '' || /^[1-9]\d*$/.test(v)) setMaxSupply(v) }}
              placeholder="unlimited"
              className="w-full bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
            />
            {!maxSupply.trim() ? (
              <p className="text-xs text-muted font-mono mt-1">open edition</p>
            ) : is11 ? (
              <p className="text-xs text-muted font-mono mt-1">1/1 minted to your wallet</p>
            ) : null}
          </div>
        )}
      </div>

      {/* Collections picker — optional; if the user doesn't pick one, the
          auto-deploy is the default when nothing's selected. */}
      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          Collection
        </label>
        <div className="flex items-stretch gap-1.5">
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            className="flex-1 min-w-0 flex items-center gap-3 bg-surface border border-line px-3 py-2.5 hover:border-muted transition-colors text-left"
          >
            {selectedCollection?.image ? (
              <div className="w-8 h-8 relative flex-shrink-0 bg-raised overflow-hidden">
                <MomentImage
                  src={selectedCollection.image}
                  alt=""
                  fill
                  className="object-cover"
                  sizes="32px"
                />
              </div>
            ) : selectedCollection ? (
              <div className="w-8 h-8 bg-raised flex-shrink-0" />
            ) : null}
            <span className={`text-sm font-mono truncate flex-1 ${selectedCollection ? 'text-ink' : 'text-muted'}`}>
              {selectedCollection
                ? selectedCollection.name
                : loadingCollections
                  ? 'loading collections…'
                  : '+ create new collection'}
            </span>
            {/* Subtle amber dot when at least one collection in the
                picker needs authorize. Per-row badges in the dropdown
                identify the specific ones. */}
            {collectionsMissingAdmin > 0 && (
              <span
                className="w-2 h-2 bg-accent rounded-full flex-shrink-0"
                title={
                  collectionsMissingAdmin === 1
                    ? '1 of your collections needs authorize before minting'
                    : `${collectionsMissingAdmin} of your collections need authorize before minting`
                }
              />
            )}
            <span className="text-muted text-xs font-mono flex-shrink-0">
              {pickerOpen ? '▲' : '▼'}
            </span>
          </button>
          {selectedCollection && (
            <button
              type="button"
              onClick={() => setSelectedCollection(null)}
              className="px-3 border border-line text-muted hover:border-muted hover:text-dim transition-colors"
              title="Clear selection (auto-deploy a new collection on submit)"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {pickerOpen && (
          <div className="border border-t-0 border-line bg-[#0d0d0d] max-h-64 overflow-y-auto">
            {/* Explains the ⚠️ badges below. Picking a flagged row
                still works — the banner above the form will then
                surface the Authorize CTA. */}
            {collectionsMissingAdmin > 0 && (
              <div className="px-3 py-2 border-b border-line bg-accent/5 flex items-start gap-2">
                <ShieldAlert size={12} className="text-accent flex-shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-[11px] font-mono text-ink">
                    {collectionsMissingAdmin === 1
                      ? '1 collection needs authorize'
                      : `${collectionsMissingAdmin} collections need authorize`}
                  </p>
                  <p className="text-[10px] font-mono text-dim mt-0.5">
                    Pick one to see the authorize CTA. One-time onchain grant from your wallet.
                  </p>
                </div>
              </div>
            )}
            {/* "Create new collection" entry — routes the user to the
                dedicated Create Collection tab where they can configure
                cover image, royalty, minters, etc. The Mint tab still
                falls back to auto-deploying a collection named after
                the moment title when the user submits without a
                selection (handled by resolvedCollectionName above). */}
            <button
              type="button"
              onClick={() => {
                setPickerOpen(false)
                onSwitchToCreate?.()
              }}
              className="w-full text-left px-3 py-3 border-b border-line bg-accent/10 hover:bg-accent/20 transition-colors"
            >
              <span className="text-xs font-mono accent-grad">
                + create new collection
              </span>
              <p className="text-[10px] font-mono text-muted mt-0.5">
                opens the create collection form
              </p>
            </button>
            {collectionOptions.length === 0 ? (
              // No empty-state copy when we have no collections — the
              // "+ create new collection" button above already covers
              // the only meaningful action. Loading/disconnected states
              // are still surfaced inline so the dropdown communicates
              // what's happening when it isn't user-actionable.
              loadingCollections ? (
                <p className="text-xs font-mono text-muted px-3 py-4">
                  loading existing collections…
                </p>
              ) : !isConnected ? (
                <p className="text-xs font-mono text-muted px-3 py-4">
                  connect a wallet to see your collections
                </p>
              ) : null
            ) : (
              <div className="grid grid-cols-3 gap-px bg-line">
                {collectionOptions.map((c, idx) => {
                  const isSelected =
                    selectedCollection !== null &&
                    c.address.toLowerCase() === selectedCollection.address.toLowerCase()
                  // hasAdmin === null = loading or RPC error; render
                  // no badge in those cases.
                  const permStatus = collectionsPerms[c.address.toLowerCase()]
                  const needsAuth = permStatus?.hasAdmin === false
                  return (
                    <button
                      key={c.address}
                      type="button"
                      onClick={() => {
                        setSelectedCollection(c)
                        setPickerOpen(false)
                      }}
                      className={`relative aspect-square bg-surface overflow-hidden group ${
                        isSelected ? 'ring-2 ring-inset ring-accent' : ''
                      }`}
                      title={
                        needsAuth
                          ? `${c.name} — needs authorize before minting`
                          : c.name
                      }
                    >
                      {c.image ? (
                        <MomentImage
                          src={c.image}
                          alt={c.name}
                          fill
                          className="object-cover"
                          sizes="120px"
                          priority={idx < 6}
                        />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <span className="text-faint font-mono text-[10px]">
                            {shortAddress(c.address)}
                          </span>
                        </div>
                      )}
                      {needsAuth && (
                        <div
                          className="absolute top-1 right-1 w-5 h-5 bg-accent/95 border border-accent/50 flex items-center justify-center"
                          aria-label="Needs authorize"
                        >
                          <ShieldAlert size={11} className="text-ink" />
                        </div>
                      )}
                      <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1.5 py-1 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                        <p className="text-[9px] font-mono text-ink truncate">{c.name}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

      </div>

      {/* Revenue splits */}
      <div>
        <label className="block text-xs font-mono text-dim uppercase tracking-wider mb-2">
          Revenue Splits
        </label>
        <div className="flex gap-2 mb-2">
          <input
            type="text"
            value={splitInput.address}
            onChange={(e) => setSplitInput((s) => ({ ...s, address: e.target.value }))}
            placeholder="0x… address"
            className="flex-1 bg-surface border border-line px-3 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
          />
          <input
            type="number"
            value={splitInput.pct}
            onChange={(e) => setSplitInput((s) => ({ ...s, pct: e.target.value }))}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addSplit() } }}
            placeholder="%"
            min="1"
            max="100"
            className="w-16 bg-surface border border-line px-2 py-2.5 text-sm text-ink font-mono placeholder-faint focus:outline-none focus:border-muted"
          />
          <button
            type="button"
            onClick={addSplit}
            className="px-3 border border-line text-dim hover:border-muted hover:text-ink transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>
        {splits.length > 0 && (
          <ul className="flex flex-col gap-1 mb-2">
            {splits.map((s) => (
              <li key={s.address} className="flex items-center justify-between bg-surface border border-line px-3 py-2">
                <span className="text-xs font-mono text-dim truncate">{s.address}</span>
                <div className="flex items-center gap-3 ml-2 flex-shrink-0">
                  <span className="text-xs font-mono text-ink">{s.percentAllocation}%</span>
                  <button
                    type="button"
                    onClick={() => setSplits((prev) => prev.filter((r) => r.address !== s.address))}
                    className="text-muted hover:text-dim"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {splits.length > 0 && (
          <p className={`text-xs font-mono ${splitsTotal === 100 ? 'text-muted' : 'accent-grad'}`}>
            {splitsTotal}% allocated{splitsTotal < 100 ? ` — ${100 - splitsTotal}% remaining` : ' ✓'}
          </p>
        )}
      </div>

      {/* Submit */}
      <button
        type="submit"
        disabled={isBusy}
        className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent"
      >
        {!isConnected
          ? 'connect wallet to mint'
          : isBusy
          ? stepLabel(step, uploadProgress)
          : 'mint'}
      </button>

      {/* Residencies toggle */}
      <div className="flex items-center gap-2.5 w-fit mx-auto -mt-2">
        <button
          type="button"
          onClick={() => {
            setResidenciesEnabled((v) => {
              if (v) return false
              // Turning ON — block if residencies is already in custom splits
              // (would otherwise duplicate when buildFinalSplits auto-appends).
              const dup = splits.some(
                (s) => s.address.toLowerCase() === RESIDENCIES_ADDRESS.toLowerCase(),
              )
              if (dup) {
                toast.error('Remove residencies from your custom splits before enabling the toggle')
                return false
              }
              return true
            })
          }}
          aria-pressed={residenciesEnabled}
          className="flex-shrink-0"
        >
          <div className={`relative w-8 h-4 rounded-full transition-colors ${residenciesEnabled ? 'bg-accent' : 'bg-line border border-[#3a3a3a]'}`}>
            <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${residenciesEnabled ? 'translate-x-4' : 'translate-x-0'}`} />
          </div>
        </button>
        <span className={`text-[10px] font-mono ${residenciesEnabled ? 'text-dim' : 'text-[#444]'}`}>
          {residenciesEnabled ? '5%' : '0%'} to{' '}
          <a
            href="https://kismetcasa.xyz"
            target="_blank"
            rel="noopener noreferrer"
            title="kismetcasa.xyz (opens in new tab)"
            className="underline hover:text-ink transition-colors"
          >
            kismet casa residencies
          </a>
        </span>
      </div>
    </form>
  )
}

function stepLabel(step: string, progress: number): string {
  switch (step) {
    case 'preparing-media': return progress > 0 ? `optimizing animation… ${progress}%` : 'optimizing animation…'
    case 'uploading-media': return progress > 0 ? `uploading media… ${progress}%` : 'uploading media…'
    case 'uploading-metadata': return 'uploading metadata…'
    case 'verifying-upload': return 'verifying Arweave propagation…'
    case 'minting': return 'minting…'
    default: return 'working…'
  }
}
