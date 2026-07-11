'use client'

import { useEffect, useState } from 'react'
import { useAccount, useReadContract, useWriteContract, usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSignTypedData } from 'wagmi'
import { parseEther, parseUnits } from 'viem'
import type { Address } from 'viem'
import { toast } from 'sonner'
import {
  SEAPORT_ADDRESS,
  SEAPORT_ABI,
  ERC1155_ABI,
  EIP2981_ABI,
  SEAPORT_DOMAIN,
  SEAPORT_ORDER_TYPES,
  buildSellOrder,
  serializeOrder,
} from '@/lib/seaport'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { toastError } from '@/lib/toast'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
import { computePlatformFee, isBelowListingFloor, MIN_LISTING_PRICE_BASE_UNITS, PLATFORM_FEE_RECIPIENT } from '@/lib/platformFee'
import { formatPrice } from '@/lib/inprocess'

type ListCurrency = 'eth' | 'usdc'

interface ListButtonProps {
  collectionAddress: string
  tokenId: string
  name?: string
  image?: string
  creatorAddress?: string
  // Writing-moment support: persisted on the listing so MarketCard can
  // render a snippet preview instead of "no preview".
  contentUri?: string
  contentMime?: string
  buttonClassName?: string
  // Two-row layout for the narrow grid/profile cards: price input on its own
  // full-width row, confirm + cancel below. Off (single row) everywhere else
  // so the wider full card / detail view keep their inline layout.
  stacked?: boolean
}

export function ListButton({
  collectionAddress,
  tokenId,
  name,
  image,
  creatorAddress,
  contentUri,
  contentMime,
  buttonClassName,
  stacked = false,
}: ListButtonProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()
  const publicClient = usePublicClient()

  const [showForm, setShowForm] = useState(false)
  const [priceInput, setPriceInput] = useState('')
  const [inputFocused, setInputFocused] = useState(false)
  const [currency, setCurrency] = useState<ListCurrency>('eth')
  const [step, setStep] = useState<'idle' | 'approving' | 'signing' | 'submitting'>('idle')
  // Live net-proceeds preview for the typed price: price − royalty − 1% fee.
  // The seller signs an order netting exactly this; without the preview they
  // never see the number until the funds arrive. `belowFloor` short-circuits
  // to the minimum-price notice. null = no valid price typed yet.
  const [breakdown, setBreakdown] = useState<
    { proceeds: bigint; royalty: bigint; fee: bigint; belowFloor: boolean } | null
  >(null)

  useEffect(() => {
    const parsed = parseFloat(priceInput)
    if (!priceInput || isNaN(parsed) || parsed <= 0) {
      setBreakdown(null)
      return
    }
    let priceTotal: bigint
    try {
      priceTotal = currency === 'usdc' ? parseUnits(priceInput, 6) : parseEther(priceInput)
    } catch {
      setBreakdown(null)
      return
    }
    if (isBelowListingFloor(priceTotal)) {
      setBreakdown({ proceeds: 0n, royalty: 0n, fee: 0n, belowFloor: true })
      return
    }
    // Debounce the royalty read so we don't fire a view call per keystroke.
    let cancelled = false
    const handle = setTimeout(async () => {
      const fee = computePlatformFee(priceTotal)
      let royalty = 0n
      try {
        if (publicClient) {
          const r = (await publicClient.readContract({
            address: collectionAddress as Address,
            abi: EIP2981_ABI,
            functionName: 'royaltyInfo',
            args: [BigInt(tokenId), priceTotal],
          })) as [Address, bigint]
          royalty = r[1]
        }
      } catch {
        // No EIP-2981 — preview as fee-only; handleList applies the same rule.
      }
      if (!cancelled) {
        setBreakdown({ proceeds: priceTotal - royalty - fee, royalty, fee, belowFloor: false })
      }
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [priceInput, currency, publicClient, collectionAddress, tokenId])

  const { data: balance } = useReadContract({
    address: collectionAddress as Address,
    abi: ERC1155_ABI,
    functionName: 'balanceOf',
    args: address ? [address, BigInt(tokenId)] : undefined,
    query: { enabled: !!address },
  })

  const holdsToken = balance !== undefined && (balance as bigint) > 0n

  const { data: isApproved, refetch: refetchApproval } = useReadContract({
    address: collectionAddress as Address,
    abi: ERC1155_ABI,
    functionName: 'isApprovedForAll',
    args: address ? [address, SEAPORT_ADDRESS] : undefined,
    query: { enabled: !!address && holdsToken },
  })

  if (!holdsToken) return null

  const isBusy = step !== 'idle'

  async function handleList() {
    if (!isConnected || !address) {
      openConnectModal?.()
      return
    }
    if (!publicClient) { toast.error('Network unavailable'); return }

    const parsedPrice = parseFloat(priceInput)
    if (!priceInput || isNaN(parsedPrice) || parsedPrice <= 0) {
      toast.error('Enter a valid price greater than 0')
      return
    }

    // priceTotal is in the listing currency's base units: wei (18dp) for ETH,
    // USDC base units (6dp) for USDC. The Listing.price field carries this
    // directly, and Seaport's consideration items expect the same base units.
    const priceTotal = currency === 'usdc' ? parseUnits(priceInput, 6) : parseEther(priceInput)

    // Shared listing-price floor (lib/platformFee, same rule /api/listings POST
    // enforces): below it the 1% fee floors to zero and POST rejects the order.
    // Check BEFORE the marketplace approval + signature so a dust price fails
    // here instead of after the user has paid gas and signed.
    if (isBelowListingFloor(priceTotal)) {
      toast.error(
        `Minimum listing price is ${formatPrice(MIN_LISTING_PRICE_BASE_UNITS.toString(), currency)} — below it the 1% fee rounds to zero`,
      )
      return
    }

    try {
      await ensureBase()

      // 1. Approve Seaport to transfer tokens if needed
      if (!isApproved) {
        setStep('approving')
        toast.loading('Approving Seaport…', { id: 'list' })
        const hash = await writeContractAsync({
          chainId: base.id,
          address: collectionAddress as Address,
          abi: ERC1155_ABI,
          functionName: 'setApprovalForAll',
          args: [SEAPORT_ADDRESS, true],
          dataSuffix: BUILDER_DATA_SUFFIX,
        })
        // Wait for the approval to actually land before signing the order —
        // otherwise refetchApproval() can race and the listing would be unfillable.
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') {
          throw new Error('Approval transaction reverted on-chain')
        }
        await refetchApproval()
      }

      // 2. Fetch royalty info via EIP-2981. royaltyInfo returns absolute
      // amounts in the same units as `salePrice` — pass USDC base units in,
      // get USDC base units out. So this is currency-agnostic.
      let royaltyReceiver = address as Address
      let royaltyAmount = 0n
      try {
        const royalty = await publicClient.readContract({
          address: collectionAddress as Address,
          abi: EIP2981_ABI,
          functionName: 'royaltyInfo',
          args: [BigInt(tokenId), priceTotal],
        }) as [Address, bigint]
        royaltyReceiver = royalty[0]
        royaltyAmount = royalty[1]
      } catch {
        // Collection doesn't implement EIP-2981 — no royalty
      }

      const platformFee = computePlatformFee(priceTotal)
      const sellerProceeds = priceTotal - royaltyAmount - platformFee

      // 3. Fetch current Seaport counter for the offerer
      const counter = await publicClient.readContract({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'getCounter',
        args: [address as Address],
      }) as bigint

      // 4. Build the order. `currency` flips consideration items between
      // NATIVE (ETH) and ERC20 (USDC) — the signed message hash differs, so
      // an ETH order can never be filled with USDC and vice versa.
      const order = buildSellOrder({
        offerer: address as Address,
        collectionAddress: collectionAddress as Address,
        tokenId,
        sellerProceeds,
        royaltyReceiver,
        royaltyAmount,
        platformFee,
        platformFeeRecipient: PLATFORM_FEE_RECIPIENT,
        counter,
        currency,
      })

      // 5. Sign with EIP-712
      setStep('signing')
      toast.loading('Sign listing in wallet…', { id: 'list' })
      const signature = await signTypedDataAsync({
        domain: SEAPORT_DOMAIN,
        types: SEAPORT_ORDER_TYPES,
        primaryType: 'OrderComponents',
        message: {
          offerer: order.offerer,
          zone: order.zone,
          offer: order.offer,
          consideration: order.consideration,
          orderType: order.orderType,
          startTime: order.startTime,
          endTime: order.endTime,
          zoneHash: order.zoneHash,
          salt: order.salt,
          conduitKey: order.conduitKey,
          counter: order.counter,
        },
      })

      // 6. Store listing in our order book
      setStep('submitting')
      toast.loading('Saving listing…', { id: 'list' })
      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          collectionAddress,
          tokenId,
          seller: address,
          price: priceTotal.toString(),
          sellerProceeds: sellerProceeds.toString(),
          royaltyReceiver,
          royaltyAmount: royaltyAmount.toString(),
          currency,
          orderComponents: serializeOrder(order),
          signature,
          expiresAt: Number(order.endTime) * 1000,
          name,
          image,
          creatorAddress,
          contentUri,
          contentMime,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to save listing')
      }

      toast.success('Listed for sale!', { id: 'list' })
      setShowForm(false)
      setPriceInput('')
    } catch (err) {
      toastError('Listing', err, { id: 'list' })
    } finally {
      setStep('idle')
    }
  }

  if (!showForm) {
    return (
      <button
        onClick={() => {
          if (!isConnected) { openConnectModal?.(); return }
          setShowForm(true)
        }}
        className={`w-full text-xs font-mono tracking-wider uppercase px-3 py-2.5 border border-line text-muted hover:border-accent hover:text-accent transition-colors ${buttonClassName ?? ''}`}
      >
        list
      </button>
    )
  }

  // Same control in both layouts, different slot: left of the input inline,
  // right of it (with a divider) when stacked.
  const currencyToggle = (
    <button
      type="button"
      onClick={() => setCurrency((c) => (c === 'eth' ? 'usdc' : 'eth'))}
      disabled={isBusy}
      title="tap to switch currency"
      className={`flex items-center text-[10px] font-mono text-dim hover:text-ink transition-colors disabled:opacity-40 flex-shrink-0 ${stacked ? 'px-2.5 border-l border-line' : 'pl-2 pr-1'}`}
    >
      {currency === 'eth' ? 'ETH' : 'USDC'}
    </button>
  )

  // `stacked` (narrow grid/profile cards) puts the price input on its own
  // full-width row with the actions below — those cards stack vertically, so
  // the taller form just grows down and no sibling gets stretched. Unset
  // (wider full card / detail) keeps the original single row. The toggle hides
  // inline once a price is typed; stacked has room to keep it visible.
  const showToggle = !stacked && priceInput === '' && !inputFocused

  return (
    <div className="w-full">
    <div className={stacked ? 'flex flex-col gap-1.5 w-full' : 'flex gap-1.5 items-center w-full'}>
      <div className={`flex bg-surface border border-line focus-within:border-muted ${stacked ? '' : 'flex-1 min-w-0'}`}>
        {showToggle && currencyToggle}
        <input
          type="text"
          inputMode="decimal"
          value={priceInput}
          onChange={(e) => { const v = e.target.value; if (v === '' || /^\d*\.?\d*$/.test(v)) setPriceInput(v) }}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          placeholder={stacked ? '0.00' : (showToggle ? '' : (currency === 'usdc' ? 'USDC' : 'ETH'))}
          disabled={isBusy}
          className="flex-1 min-w-0 bg-transparent px-2 py-2.5 text-xs text-ink font-mono placeholder-subtle focus:outline-none disabled:opacity-50"
        />
        {stacked && currencyToggle}
      </div>
      <div className={stacked ? 'flex gap-1.5' : 'flex gap-1 flex-shrink-0 ml-auto'}>
        <button
          onClick={handleList}
          disabled={isBusy}
          className={`${stacked ? 'flex-1 ' : ''}text-xs font-mono tracking-wider uppercase px-3 py-2.5 btn-accent`}
        >
          {step === 'approving' ? 'approving…'
            : step === 'signing' ? 'signing…'
            : step === 'submitting' ? 'saving…'
            : 'list'}
        </button>
        <button
          type="button"
          onClick={() => { setShowForm(false); setPriceInput('') }}
          disabled={isBusy}
          aria-label="cancel"
          className="px-2 text-xs font-mono text-muted hover:text-dim disabled:opacity-40"
        >
          ✕
        </button>
      </div>
    </div>
    {breakdown && (
      <p className={`mt-1 text-[10px] font-mono ${breakdown.belowFloor ? 'text-red-400' : 'text-muted'}`}>
        {breakdown.belowFloor
          ? `minimum ${formatPrice(MIN_LISTING_PRICE_BASE_UNITS.toString(), currency)} — below it the 1% fee rounds to zero`
          : breakdown.royalty > 0n
            ? `you'll receive ≈ ${formatPrice(breakdown.proceeds.toString(), currency)} — after ${formatPrice(breakdown.royalty.toString(), currency)} royalty + ${formatPrice(breakdown.fee.toString(), currency)} platform fee (1%)`
            : `you'll receive ≈ ${formatPrice(breakdown.proceeds.toString(), currency)} — after the 1% platform fee`}
      </p>
    )}
    </div>
  )
}
