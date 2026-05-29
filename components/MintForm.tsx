'use client'

import { useState, useEffect } from 'react'
import { MomentImage } from './MomentImage'
import { useRouter } from 'next/navigation'
import { useAccount, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { Upload, X, Plus, Trash2, ShieldCheck, ShieldAlert } from 'lucide-react'
import { parseEther, parseUnits, isAddress } from 'viem'
import { shortAddress, type CreateMomentPayload, type Split } from '@/lib/inprocess'
import uploadToArweave from '@/lib/arweave/uploadToArweave'
import { generateThumbhash } from '@/lib/media/thumbhash'
import { canTranscode, transcodeGifToMp4 } from '@/lib/media/transcodeGif'
import { serverTranscodeGif } from '@/lib/media/serverTranscodeGif'
import { extractVideoPoster } from '@/lib/media/extractPoster'
import { remuxToFaststartMp4 } from '@/lib/media/remuxFaststart'
import { probeDurationSeconds } from '@/lib/media/probeDuration'
import { uploadJson } from '@/lib/arweave/uploadJson'
import { verifyArweaveAvailable } from '@/lib/arweave/verifyAvailable'
import { useUploadSession } from '@/hooks/useUploadSession'
import { useFileUpload } from '@/hooks/useFileUpload'
import { useInprocessSmartWallet } from '@/hooks/useInprocessSmartWallet'
import { useCollectionsPermissions } from '@/hooks/useCollectionsPermissions'
import { useIntentAuth } from '@/hooks/useIntentAuth'
import { PLATFORM_COLLECTION, CREATE_REFERRAL, RESIDENCIES_ADDRESS, DEFAULT_RESIDENCIES_PERCENT } from '@/lib/config'
import { COLLECTION_ABI } from '@/lib/collections'
import { MAX_SPLITS } from '@/lib/splits'
import { generateTextCollectionCoverDataUri } from '@/lib/generateTextCover'
import { hasAdminBit } from '@/lib/permissions'
import { registerCollectionWithBackoff } from '@/lib/registerCollection'
import { USDC_BASE } from '@/lib/zoraMint'
import { toastError } from '@/lib/toast'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { useAdmin } from '@/contexts/AdminContext'
import { hapticNotifySuccess } from '@/lib/farcasterHaptics'
import { SITE_URL } from '@/lib/siteUrl'

const KISMET_CHANNEL_KEY = 'kismet'

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
// Convert fractional `values` (which by construction sum to ~`target`) into
// integers that sum to EXACTLY `target`, with every entry ≥ 1. Largest-
// remainder method: floor (min 1), then hand out / claw back the leftover by
// fractional remainder. Exact and order-stable — unlike a bounded ±1 drift
// loop, it can't leave the sum off-target for skewed allocations (e.g. many
// tiny recipients plus one large one). Precondition: target ≥ values.length,
// which callers guarantee via the recipient cap + residenciesOverCap, so a
// min-1 solution always exists; the guards below just prevent a spin if it
// is ever violated (handleMint's sum check is the final backstop).
function roundToIntegerAllocations(values: number[], target: number): number[] {
  const n = values.length
  if (n === 0) return []
  const ints = values.map((v) => Math.max(1, Math.floor(v)))
  let sum = ints.reduce((a, b) => a + b, 0)
  if (sum === target) return ints
  // Indices ordered by fractional remainder: add to the largest first,
  // remove from the smallest first, so the integer split best tracks intent.
  const byRemainder = values
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => a.frac - b.frac)
  if (sum < target) {
    let k = n - 1
    while (sum < target) {
      ints[byRemainder[((k % n) + n) % n].i] += 1
      sum += 1
      k -= 1
    }
  } else {
    let k = 0
    let guard = 0
    const maxGuard = sum * n + n
    while (sum > target && guard++ < maxGuard) {
      const { i } = byRemainder[k % n]
      if (ints[i] > 1) {
        ints[i] -= 1
        sum -= 1
      }
      k += 1
    }
  }
  return ints
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
  // Base64 thumbhash for the cover. Passed to MomentImage so the
  // selected-collection chip renders a blur placeholder during the
  // optimizer fetch + any fallback walk — matches what AirdropForm's
  // moment chip already does. Optional because legacy KV records
  // pre-date the thumbhash field and inprocess may not surface it
  // for collections deployed outside the Kismet flow.
  thumbhash?: string
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
  const { signMintIntent } = useIntentAuth()
  const { isInMiniApp, maybePromptCollectNotifs } = useFarcaster()
  // Admin is gate-exempt server-side; skip the pass CTA for them.
  const { isAdmin } = useAdmin()
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
          metadata?: { name?: string; image?: string; kismet_thumbhash?: string }
        }
        const items: CollectionOption[] = (Array.isArray(d.collections) ? d.collections : [])
          .map((c: ApiCollection) => {
            if (!c.contractAddress) return null
            return {
              address: c.contractAddress,
              name: c.metadata?.name ?? c.name ?? shortAddress(c.contractAddress),
              image: c.metadata?.image,
              thumbhash: c.metadata?.kismet_thumbhash,
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
  // Skipped in auto-deploy mode (no collection to read yet).
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

  // Token-gate pre-check. When the gate is enabled and the connected
  // wallet holds no valid Pass, we swap the mint button for a "collect
  // creator pass" CTA that links to the Pass collection — so a gated-out
  // user is told up front instead of burning an Arweave upload + intent
  // signature only to hit the server's 403. This is a UX hint, not the
  // enforcement boundary; lib/mint-proxy still runs the authoritative
  // hasGateAccess check on every request.
  const [passGate, setPassGate] = useState<{
    enabled: boolean
    passCollection: string | null
    validBalance: number
  } | null>(null)
  useEffect(() => {
    if (!address) { setPassGate(null); return }
    let cancelled = false
    fetch(`/api/pass-validity?address=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d) setPassGate(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [address])
  const gatedOut =
    !!passGate?.enabled &&
    !!passGate.passCollection &&
    passGate.validBalance < 1 &&
    !isAdmin
  const passCollectionHref = passGate?.passCollection
    ? `/collection/${passGate.passCollection}`
    : '/'

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
  // Creator-chosen residencies cut (whole percent). Editable inline when the
  // toggle is on; `residenciesInput` is the transient edit buffer so typing
  // doesn't fight the committed integer.
  const [residenciesPercent, setResidenciesPercent] = useState(DEFAULT_RESIDENCIES_PERCENT)
  const [editingResidencies, setEditingResidencies] = useState(false)
  const [residenciesInput, setResidenciesInput] = useState(String(DEFAULT_RESIDENCIES_PERCENT))
  const [step, setStep] = useState<'idle' | 'preparing-media' | 'uploading-media' | 'uploading-metadata' | 'verifying-upload' | 'minting' | 'done'>('idle')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [result, setResult] = useState<{ hash: string; contractAddress: string; tokenId: string } | null>(null)

  const splitsTotal = splits.reduce((s, r) => s + r.percentAllocation, 0)
  // Upper bound on the residencies cut. With 2+ custom splits, buildFinalSplits
  // scales them to sum to (100 − p), and roundToIntegerAllocations floors each
  // recipient at 1% — so the cut can't exceed 100 − recipientCount or a
  // recipient would be squeezed below 1% and the array couldn't sum to 100.
  // With 0/1 splits only the creator shares the remainder, so the cap is 99.
  // The recipient cap keeps splits.length ≤ MAX_SPLITS−1 while residencies is
  // on, so this never drops below 51 — there's always room for a 1% cut.
  const residenciesMax = splits.length >= 2 ? 100 - splits.length : 99
  // Defense in depth: if the creator raised the % and then added recipients,
  // the committed value can exceed the live cap. Surface it inline and block
  // the mint until resolved (we don't silently mutate their chosen number).
  const residenciesOverCap = residenciesEnabled && residenciesPercent > residenciesMax
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

  // Platform-pause kill switch — the mint proxy returns 503 with a
  // "paused" message when an admin has paused minting. Surface a single
  // clean toast instead of the generic "Mint failed" + description (or a
  // misleading payload-level error like "duplicate splits address"), so a
  // paused platform reads as an intentional state. Matches the message too,
  // not just the status, so a pass-through 503 from an inprocess outage
  // still falls through to the generic error path. Checked before
  // maybeHandleAuthError/throw so it always wins.
  function maybeHandlePauseError(status: number, data?: { error?: unknown }): boolean {
    if (status !== 503 || typeof data?.error !== 'string' || !/paused/i.test(data.error)) {
      return false
    }
    toast.error('Platform is temporarily paused', { id: 'mint' })
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
    // Cap recipient count to the server's MAX_SPLITS. When residencies is on
    // it occupies one of those slots (buildFinalSplits appends it), so the
    // custom-recipient limit drops by one — otherwise the final array would
    // be MAX_SPLITS+1 and validateSplitsArray would reject the mint.
    const recipientCap = residenciesEnabled ? MAX_SPLITS - 1 : MAX_SPLITS
    if (splits.length >= recipientCap) {
      toast.error(
        residenciesEnabled
          ? `Up to ${recipientCap} recipients with residencies on (${MAX_SPLITS} total)`
          : `Up to ${recipientCap} split recipients`,
      )
      return
    }
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

  // Parse + commit the inline residencies edit. Integers only — the valid
  // range is [1, residenciesMax] where residenciesMax ≤ 99 (someone must keep
  // ≥1%). Behavior by input:
  //   empty / whitespace / non-numeric / ±Infinity → revert to last committed
  //   decimals (e.g. 5.9)                           → floored to int, no toast
  //   < 1 (0, negatives, 0.x)                       → clamp to 1 + toast
  //   > residenciesMax (incl. 100)                  → clamp to cap + toast
  //   1..residenciesMax                             → committed as-is
  function commitResidencies() {
    setEditingResidencies(false)
    const raw = residenciesInput.trim()
    const num = Number(raw)
    if (raw === '' || !Number.isFinite(num)) {
      setResidenciesInput(String(residenciesPercent))
      return
    }
    const upper = residenciesMax
    const intval = Math.floor(num)
    const clamped = Math.min(upper, Math.max(1, intval))
    // Toast only when we clamped a genuinely out-of-range value, not for a
    // silent decimal truncation (5.9 → 5 stays quiet).
    if (clamped !== intval) {
      if (intval > upper) {
        toast.error(
          splits.length >= 2
            ? `Residencies capped at ${upper}% so each recipient keeps at least 1%`
            : `Residencies capped at ${upper}% so you keep at least 1%`,
        )
      } else {
        toast.error('Residencies minimum is 1% — turn the toggle off to remove it')
      }
    }
    setResidenciesPercent(clamped)
    setResidenciesInput(String(clamped))
  }

  // Builds the final splits array to send to the API. Inprocess docs require
  // integer `percentAllocation` summing to exactly 100% — every code path
  // here emits integers via roundToIntegerAllocations + appends the
  // residencies cut when the toggle is on.
  //
  // `p` = residenciesPercent (creator-chosen whole percent, 1..residenciesMax).
  //
  //   residencies OFF + 0/1 splits  → undefined (caller uses payoutRecipient)
  //   residencies OFF + 2+ splits   → sorted user splits (rounded to integers)
  //   residencies ON  + 0/1 splits  → [creator 100−p, residencies p] (sorted)
  //   residencies ON  + 2+ splits   → user splits scaled ×(100−p)/100 to
  //                                   integers summing to 100−p, plus residencies p
  //
  // residenciesMax guarantees 100−p ≥ recipientCount, so roundToIntegerAllocations
  // (which floors each recipient at 1%) can always hit its target and the final
  // array sums to exactly 100 — re-checked by validateSplitsArray server-side.
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
    const p = residenciesPercent
    if (splits.length < 2) {
      return sortSplits([
        { address: address!, percentAllocation: 100 - p },
        { address: RESIDENCIES_ADDRESS, percentAllocation: p },
      ])
    }
    const rounded = roundToIntegerAllocations(
      splits.map((s) => (s.percentAllocation * (100 - p)) / 100),
      100 - p,
    )
    return sortSplits([
      ...splits.map((s, i) => ({ address: s.address, percentAllocation: rounded[i] })),
      { address: RESIDENCIES_ADDRESS, percentAllocation: p },
    ])
  }

  async function handleMint(e: React.FormEvent) {
    e.preventDefault()

    if (!isConnected || !address) { openConnectModal?.(); return }
    // Gated out (no valid Pass) — route to the Pass collection instead of
    // attempting a mint that the server would 403. Guards the Enter-key
    // submit path; the button itself is already swapped to the CTA below.
    if (gatedOut) { router.push(passCollectionHref); return }
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
    if (residenciesOverCap) {
      toast.error(`Lower residencies to ${residenciesMax}% or remove a recipient — each split needs at least 1%`)
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

    // After a successful auto-deploy mint, register the new collection
    // in KV so the server can fan it out under moments. Fire-and-forget;
    // failures log inside the helper. The mint itself is real on chain
    // regardless of how this goes.
    async function trackAutoDeploy(
      contractAddress: string,
      imageUri: string | undefined,
      thumbhash?: string,
    ): Promise<void> {
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

        // Per-action intent signature — server verifies the wallet at
        // `payload.account` actually authorized this exact payload
        // (collection, content hash, sale params, splits hash). Prompts
        // wallet once before submission; the on-chain mint via inprocess
        // remains transparent to the user as before.
        toast.loading('Confirm in wallet…', { id: 'mint' })
        const { intent } = await signMintIntent(payload, 'write')
        toast.loading('Minting moment…', { id: 'mint' })

        const res = await fetch('/api/write', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, intent }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (maybeHandlePauseError(res.status, data)) return
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
          void trackAutoDeploy(data.contractAddress, undefined)
        }
        setStep('done')
        toast.success('Minted!', { id: 'mint', description: `Token #${data.tokenId}` })
        if (isInMiniApp) {
          hapticNotifySuccess()
          maybePromptCollectNotifs()
        }

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
        // Set when the in-browser transcode can't handle this GIF (over the
        // 100MB ffmpeg.wasm cap, or it threw). The raw GIF is uploaded as-is
        // below, then handed to the server transcoder. Fail-safe: if the
        // server step also fails, the mint still ships today's raw-GIF
        // bindings rather than blocking.
        let needsServerTranscode = false
        const isGifFile = file!.type === 'image/gif' || file!.name.toLowerCase().endsWith('.gif')
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
            console.warn('[MintForm] GIF transcode failed; will retry server-side', err)
            needsServerTranscode = true
          }
        } else if (isGifFile) {
          // Over the ffmpeg.wasm cap — can't transcode in the browser.
          // Upload the raw GIF below, then transcode it on the server.
          needsServerTranscode = true
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
        // Probe video duration in parallel with the upload — server
        // persists via setMomentMeta so feeds can pick long-form
        // preload at element-create time. Returns null for non-video or
        // probe failure; payload omits durationSec in those cases.
        const durationPromise = probeDurationSeconds(mediaFile).catch(() => null)
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
        const [thumbhash, posterUri, durationSec] = await Promise.all([
          thumbhashPromise,
          posterUriPromise,
          durationPromise,
        ])
        const posterVerify = posterUri ? verifyArweaveAvailable(posterUri) : Promise.resolve(true)
        // Poster (when extracted) wins as `image` so feeds render the
        // static frame; the moving asset goes to animation_url. For video
        // media, never fall back to the MP4 URL as the image — the
        // renderer would try to load it as an <img> src and fail, leaving
        // a black card. Better to leave image undefined and let the
        // thumbhash + icon placeholder cover the slot.
        // Default (client-transcoded or non-GIF) media bindings: a video
        // moment points animation_url at the uploaded MP4 and image at the
        // poster; everything else uses the media itself as the image.
        let animationUri: string | undefined = mediaFile.type.startsWith('video/') ? mediaUri : undefined
        let finalImageUri = animationUri ? posterUri : (posterUri ?? mediaUri)
        let finalThumbhash = thumbhash
        // Oversized / wasm-failed GIF: `mediaUri` is the raw GIF we just
        // uploaded. Transcode it server-side and swap in the MP4 + poster so
        // it renders as a video (iOS can't decode large animated GIFs).
        // Fail-safe: any error keeps the raw-GIF bindings above so the mint
        // still completes — never worse than today's behavior.
        if (needsServerTranscode) {
          try {
            toast.loading('Optimizing animation on server…', { id: 'mint' })
            // The server fetches the raw GIF from a gateway, so block on its
            // propagation first or the hand-off 404s.
            const rawOk = await mediaVerify
            if (!rawOk) throw new Error('source GIF not yet propagated')
            const r = await serverTranscodeGif(mediaUri)
            animationUri = r.animationUri
            finalImageUri = r.posterUri
            finalThumbhash = r.thumbhash ?? finalThumbhash
          } catch (err) {
            console.warn('[MintForm] server GIF transcode failed; shipping original', err)
          }
        }
        const imageUri = finalImageUri
        const metadata = {
          name: name.trim(),
          description: description.trim(),
          ...(imageUri ? { image: imageUri } : {}),
          ...(animationUri ? { animation_url: animationUri } : {}),
          ...(finalThumbhash ? { kismet_thumbhash: finalThumbhash } : {}),
        }
        const metadataUri = await uploadJson(metadata)
        const metadataVerify = verifyArweaveAvailable(metadataUri)

        // Auto-deploy: the moment's media doubles as the collection cover.
        // Covers don't surface animation_url, so the poster (when present)
        // is what feed cards actually render. Same constraint as `image`
        // above — for video media, never fall back to the MP4 URL.
        let collectionUri: string | null = null
        let collectionVerify: Promise<boolean> = Promise.resolve(true)
        const coverImageUri = imageUri
        if (isAutoDeploy) {
          toast.loading('Uploading collection metadata…', { id: 'mint' })
          const collectionMetadata = {
            name: resolvedCollectionName,
            description: description.trim(),
            ...(coverImageUri ? { image: coverImageUri } : {}),
            ...(finalThumbhash ? { kismet_thumbhash: finalThumbhash } : {}),
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

        const payload: CreateMomentPayload & { name: string; durationSec?: number } = {
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
          // Passed through to mint-proxy's setMomentMeta call so feed
          // surfaces can seed lib/media/durationCache and skip the
          // metadata→auto preload upgrade for long-form videos.
          ...(typeof durationSec === 'number' && durationSec > 0
            ? { durationSec }
            : {}),
        }

        // Per-action intent signature — server verifies the wallet at
        // `payload.account` actually authorized this exact payload
        // (collection, tokenURI, sale params, splits hash). Prompts
        // wallet once before submission.
        toast.loading('Confirm in wallet…', { id: 'mint' })
        const { intent } = await signMintIntent(payload, 'mint')
        toast.loading('Minting moment…', { id: 'mint' })

        const res = await fetch('/api/mint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, intent }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) {
          if (maybeHandlePauseError(res.status, data)) return
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
          void trackAutoDeploy(data.contractAddress, coverImageUri ?? undefined, finalThumbhash ?? undefined)
        }
        setStep('done')
        toast.success('Minted!', { id: 'mint', description: `Token #${data.tokenId}` })
        if (isInMiniApp) {
          hapticNotifySuccess()
          maybePromptCollectNotifs()
        }
      }
    } catch (err) {
      setStep('idle')
      setUploadProgress(0)
      toastError('Mint', err, { id: 'mint' })
    }
  }

  const isBusy = step !== 'idle' && step !== 'done'

  // Share the just-minted moment as a cast in /kismet. Mini App only —
  // composeCast is a host action with no web equivalent. The embed
  // gives the cast a preview card; the @kismet mention is rendered as
  // a clickable user mention by the host.
  async function handleShareToKismet() {
    if (!result) return
    try {
      const { sdk } = await import('@farcaster/miniapp-sdk')
      const trimmed = name.trim()
      const text = trimmed
        ? `I just minted "${trimmed}" on @kismet`
        : 'I just minted a new moment on @kismet'
      const momentUrl = `${SITE_URL}/moment/${result.contractAddress}/${result.tokenId}`
      const composed = await sdk.actions.composeCast({
        text,
        embeds: [momentUrl],
        channelKey: KISMET_CHANNEL_KEY,
      })
      // composeCast resolves with { cast: null } when the user dismisses
      // the compose sheet — that's an explicit "no", so no success toast.
      if (composed?.cast) {
        toast.success('Cast shared to /kismet!', { id: 'share' })
        // Inside handleShareToKismet we already know we're in a Mini App
        // (the button gating render-time on isInMiniApp), so no gate here.
        hapticNotifySuccess()
      }
    } catch (err) {
      toastError('Share', err, { id: 'share' })
    }
  }

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
        <div className="flex flex-col items-center gap-2.5">
          {isInMiniApp && (
            <button
              type="button"
              onClick={handleShareToKismet}
              className="text-xs font-mono uppercase tracking-wider px-4 py-2 btn-accent"
            >
              Share to /kismet →
            </button>
          )}
          <button
            type="button"
            onClick={() => router.push(`/moment/${result.contractAddress}/${result.tokenId}`)}
            className="text-xs font-mono uppercase tracking-wider px-4 py-2 btn-accent"
          >
            Moment details →
          </button>
        </div>
        <a
          href={`https://basescan.org/tx/${result.hash}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-mono text-muted hover:text-dim"
        >
          {result.hash.slice(0, 10)}…{result.hash.slice(-8)}
        </a>
        <button
          onClick={() => {
            setStep('idle')
            setResult(null)
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
                  thumbhash={selectedCollection.thumbhash}
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

      {/* Submit — swaps to a "collect creator pass" CTA when the gate is
          enabled and the connected wallet holds no valid Pass. */}
      {gatedOut ? (
        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            onClick={() => router.push(passCollectionHref)}
            className="w-full py-3 text-xs font-mono tracking-widest uppercase btn-accent"
          >
            collect creator pass
          </button>
          <p className="text-[10px] font-mono text-muted text-center">
            minting requires a Kismet Creator Pass
          </p>
        </div>
      ) : (
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
      )}

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
              // Residencies takes a recipient slot; if the custom list already
              // fills MAX_SPLITS, enabling would make MAX_SPLITS+1 and the mint
              // would be rejected server-side. Make the creator free a slot.
              if (splits.length >= MAX_SPLITS) {
                toast.error(`Remove a recipient first — ${MAX_SPLITS} is the max including residencies`)
                return false
              }
              // Sync the edit buffer so clicking the % shows the live value.
              setResidenciesInput(String(residenciesPercent))
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
          {residenciesEnabled ? (
            editingResidencies ? (
              <input
                type="number"
                autoFocus
                value={residenciesInput}
                min={1}
                max={residenciesMax}
                step={1}
                onChange={(e) => setResidenciesInput(e.target.value)}
                onBlur={commitResidencies}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); commitResidencies() }
                  else if (e.key === 'Escape') {
                    e.preventDefault()
                    setResidenciesInput(String(residenciesPercent))
                    setEditingResidencies(false)
                  }
                }}
                aria-label="Residencies percent"
                className="w-9 bg-surface border border-line px-1 py-0.5 text-[10px] text-ink font-mono text-center focus:outline-none focus:border-muted [appearance:textfield]"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setResidenciesInput(String(residenciesPercent))
                  setEditingResidencies(true)
                }}
                title="Click to set the residencies %"
                className={`underline decoration-dotted underline-offset-2 hover:text-ink transition-colors ${residenciesOverCap ? 'text-red-500' : ''}`}
              >
                {residenciesPercent}%
              </button>
            )
          ) : '0%'}{' '}to{' '}
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
      {residenciesOverCap && (
        <p className="text-[10px] font-mono text-red-500 w-fit mx-auto -mt-1 text-center">
          {residenciesMax}% max with {splits.length} recipients — lower the % or remove one
        </p>
      )}
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
