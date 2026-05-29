'use client'

import { useState } from 'react'
import { useAccount, useSignMessage, useWriteContract, usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import type { Hex } from 'viem'
import { SEAPORT_ADDRESS, SEAPORT_ABI, deserializeOrder } from '@/lib/seaport'
import { ERC20_ABI, USDC_BASE } from '@/lib/zoraMint'
import { formatPrice } from '@/lib/inprocess'
import type { Listing } from '@/lib/listings'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { toastError } from '@/lib/toast'

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
  const { signMessageAsync } = useSignMessage()
  const publicClient = usePublicClient()
  const ensureBase = useEnsureBase()
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

      // USDC path — buyer must approve Seaport to pull USDC before fulfillOrder.
      // Per-buy approve (not max) so the spending allowance is bounded; the
      // trade-off is one extra tx per purchase, which the user agreed to.
      if (currency === 'usdc') {
        toast.loading('Checking USDC allowance…', { id: 'buy' })
        const allowance = (await publicClient.readContract({
          address: USDC_BASE,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [address, SEAPORT_ADDRESS],
        })) as bigint

        if (allowance < priceTotal) {
          toast.loading('Approve USDC in wallet… (1 of 2)', { id: 'buy' })
          const approveHash = await writeContractAsync({
            chainId: base.id,
            address: USDC_BASE,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [SEAPORT_ADDRESS, priceTotal],
          })
          toast.loading('Confirming approval…', { id: 'buy' })
          const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
          if (approveReceipt.status !== 'success') {
            throw new Error('USDC approval reverted')
          }
        }

        toast.loading('Confirm purchase in wallet… (2 of 2)', { id: 'buy' })
      } else {
        toast.loading('Confirm purchase in wallet…', { id: 'buy' })
      }

      const hash = await writeContractAsync({
        chainId: base.id,
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'fulfillOrder',
        // ETH listings send native value with the call; USDC listings send
        // zero (Seaport pulls USDC via the approval set above).
        ...(currency === 'eth' ? { value: priceTotal } : {}),
        args: [
          {
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
          },
          ZERO_BYTES32,
        ],
      })

      // Don't mark filled until the tx actually confirms — a reverted fulfillOrder
      // would leave the order open on-chain but our backend would say "sold".
      toast.loading('Confirming purchase…', { id: 'buy' })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') {
        throw new Error('Transaction reverted on-chain')
      }

      // Mark filled — backend requires a signed message from the buyer so a
      // third party can't flip arbitrary listings or fake "sale" notifications.
      const nonceRes = await fetch(`/api/profile/${address}/nonce`)
      if (!nonceRes.ok) throw new Error('Could not fetch nonce')
      const { nonce } = (await nonceRes.json().catch(() => ({}))) as { nonce?: string }
      if (!nonce) throw new Error('Could not fetch nonce')
      const message = `Mark Kismet listing filled\nListing: ${listing.id}\nBuyer: ${address.toLowerCase()}\nNonce: ${nonce}`
      const signature = await signMessageAsync({ message })

      await fetch(`/api/listings/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // txHash is required server-side now — the backend decodes the
        // Seaport OrderFulfilled event from this receipt to confirm the
        // sale before flipping status. Without it the PATCH returns 400.
        body: JSON.stringify({ status: 'filled', signature, nonce, signer: address, txHash: hash }),
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
    <button
      onClick={handleBuy}
      disabled={loading || bought}
      className={`${compact ? 'text-[10px] px-2 py-1.5' : 'text-xs px-4 py-2.5'} font-mono tracking-wider uppercase border transition-colors disabled:opacity-50 ${loading ? 'cursor-not-allowed' : ''} ${
        bought
          ? 'border-accent text-accent bg-accent/10'
          : 'border-line text-dim hover:border-accent hover:text-accent'
      } ${className}`}
    >
      {bought ? 'bought' : loading ? 'buying…' : `buy ${priceLabel}`}
    </button>
  )
}
