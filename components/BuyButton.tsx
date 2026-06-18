'use client'

import { useState } from 'react'
import { useAccount, useConfig, usePublicClient, useSendCalls, useWriteContract } from 'wagmi'
import { waitForCallsStatus } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { encodeFunctionData, type Hex } from 'viem'
import { SEAPORT_ADDRESS, SEAPORT_ABI, deserializeOrder } from '@/lib/seaport'
import { ERC20_ABI, USDC_BASE } from '@/lib/zoraMint'
import { formatPrice } from '@/lib/inprocess'
import type { Listing } from '@/lib/listings'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { toastError, isUserRejection, isUnsupportedMethodError } from '@/lib/toast'
import { BUILDER_DATA_SUFFIX, builderCodeCapabilities } from '@/lib/builderCode'
import { PurchaseModal } from './PurchaseModal'

interface BuyButtonProps {
  listing: Listing
  onBought?: () => void
  className?: string
  /**
   * Compact sizing for the grid view — shrinks text, padding, and label
   * so the button fits a ~180px wide compact MarketCard alongside the
   * price chip and creator chip.
   */
  compact?: boolean
}

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex

export function BuyButton({ listing, onBought, className = '', compact = false }: BuyButtonProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { writeContractAsync } = useWriteContract()
  const { sendCallsAsync } = useSendCalls()
  const config = useConfig()
  const publicClient = usePublicClient()
  const ensureBase = useEnsureBase()
  const [showModal, setShowModal] = useState(false)
  const [loading, setLoading] = useState(false)
  const [bought, setBought] = useState(false)

  const priceTotal = BigInt(listing.price)
  const currency = listing.currency ?? 'eth'
  const priceLabel = formatPrice(listing.price, currency)

  async function handleBuy() {
    if (!isConnected || !address) {
      openConnectModal?.()
      return
    }
    if (address.toLowerCase() === listing.seller.toLowerCase()) {
      toast.error("You can't buy your own listing")
      return
    }
    if (!publicClient) throw new Error('No RPC client available')

    setLoading(true)
    try {
      await ensureBase()
      const order = deserializeOrder(listing.orderComponents)

      // Shared fulfillOrder parameters — reused by the single writeContract path
      // and the EIP-5792 batch. (Seaport's OrderParameters carries the
      // consideration count, not the signing `counter`.)
      const fulfillParams = {
        parameters: {
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
          totalOriginalConsiderationItems: BigInt(order.consideration.length),
        },
        signature: listing.signature as Hex,
      }

      // Single fulfillOrder via writeContract — ETH, USDC when allowance already
      // covers, and the sequential-fallback fulfill leg. Returns the confirmed
      // tx hash (the backend decodes its OrderFulfilled event).
      const fulfillSingle = async (): Promise<Hex> => {
        const h = await writeContractAsync({
          chainId: base.id,
          address: SEAPORT_ADDRESS,
          abi: SEAPORT_ABI,
          functionName: 'fulfillOrder',
          // ETH sends native value; USDC sends zero (Seaport pulls via allowance).
          ...(currency === 'eth' ? { value: priceTotal } : {}),
          args: [fulfillParams, ZERO_BYTES32],
          dataSuffix: BUILDER_DATA_SUFFIX,
        })
        const r = await publicClient!.waitForTransactionReceipt({ hash: h })
        if (r.status !== 'success') throw new Error('Transaction reverted on-chain')
        return h
      }

      let hash: Hex

      if (currency === 'usdc') {
        toast.loading('Checking USDC allowance…', { id: 'buy' })
        const allowance = (await publicClient.readContract({
          address: USDC_BASE,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, SEAPORT_ADDRESS],
        })) as bigint

        if (allowance >= priceTotal) {
          // Allowance already covers — single fulfill (one tap).
          toast.loading('Confirm purchase in wallet…', { id: 'buy' })
          hash = await fulfillSingle()
        } else {
          // First-time USDC buy: batch approve + fulfill into ONE approval on
          // EIP-5792 wallets (best practice; matches collect-all). Approve is the
          // exact price (bounded — never MaxUint256). Falls back to the
          // sequential approve+fulfill on wallets without wallet_sendCalls.
          const approveData = encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [SEAPORT_ADDRESS, priceTotal],
          })
          const fulfillData = encodeFunctionData({
            abi: SEAPORT_ABI,
            functionName: 'fulfillOrder',
            args: [fulfillParams, ZERO_BYTES32],
          })
          try {
            toast.loading('Confirm purchase in wallet…', { id: 'buy' })
            const { id } = await sendCallsAsync({
              calls: [
                { to: USDC_BASE, data: approveData },
                { to: SEAPORT_ADDRESS, data: fulfillData },
              ],
              chainId: base.id,
              experimental_fallback: true,
              capabilities: builderCodeCapabilities,
            })
            toast.loading('Confirming purchase…', { id: 'buy' })
            const result = await waitForCallsStatus(config, { id, throwOnFailure: false, timeout: 300_000 })
            if (result.status !== 'success') throw new Error('Purchase did not complete on-chain')
            // fulfillOrder is the last call, so the last receipt carries the
            // OrderFulfilled event (atomic batch → one receipt; sequential
            // fallback → the fulfill receipt is last).
            const last = (result.receipts ?? []).at(-1)
            if (!last?.transactionHash) throw new Error('No purchase receipt')
            hash = last.transactionHash
          } catch (err) {
            // Fall back ONLY on a pre-submission "method not supported" — never
            // on other errors, since the batch may already have landed and
            // re-running would double-buy. Mirrors useCollectAll.
            if (isUserRejection(err) || !isUnsupportedMethodError(err)) throw err
            toast.loading('Approve USDC in wallet… (1 of 2)', { id: 'buy' })
            const approveHash = await writeContractAsync({
              chainId: base.id,
              address: USDC_BASE,
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [SEAPORT_ADDRESS, priceTotal],
              dataSuffix: BUILDER_DATA_SUFFIX,
            })
            const ar = await publicClient.waitForTransactionReceipt({ hash: approveHash })
            if (ar.status !== 'success') throw new Error('USDC approval reverted')
            toast.loading('Confirm purchase in wallet… (2 of 2)', { id: 'buy' })
            hash = await fulfillSingle()
          }
        }
      } else {
        // ETH — single fulfill with native value (one tap).
        toast.loading('Confirm purchase in wallet…', { id: 'buy' })
        hash = await fulfillSingle()
      }

      // Mark the order-book listing filled. No buyer signature needed: the
      // backend decodes the Seaport OrderFulfilled event from this txHash
      // (matched to the listing's orderHash) and derives the buyer from it, so a
      // bogus PATCH can't fake a sale.
      await fetch(`/api/listings/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'filled', txHash: hash }),
      })

      setBought(true)
      toast.success('Purchased!', { id: 'buy' })
      onBought?.()
    } catch (err) {
      toastError('Purchase', err, { id: 'buy' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {showModal && (
        <PurchaseModal
          listing={listing}
          onConfirm={() => { setShowModal(false); handleBuy() }}
          onClose={() => setShowModal(false)}
        />
      )}
      <button
        onClick={() => { if (!loading && !bought) setShowModal(true) }}
        disabled={loading || bought}
        className={`${compact ? 'text-[10px] px-2 py-1.5' : 'text-xs px-4 py-2.5'} font-mono tracking-wider uppercase border transition-colors disabled:opacity-50 ${loading ? 'cursor-not-allowed' : ''} ${
          bought
            ? 'border-accent text-accent bg-accent/10'
            : 'border-line text-dim hover:border-accent hover:text-accent'
        } ${className}`}
      >
        {bought ? 'bought' : loading ? 'buying…' : `buy ${priceLabel}`}
      </button>
    </>
  )
}
