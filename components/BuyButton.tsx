'use client'

import { useState } from 'react'
import { useAccount, useWriteContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { formatEther } from 'viem'
import type { Hex } from 'viem'
import { SEAPORT_ADDRESS, SEAPORT_ABI, deserializeOrder } from '@/lib/seaport'
import type { Listing } from '@/lib/listings'

interface BuyButtonProps {
  listing: Listing
  onBought?: () => void
  className?: string
}

export function BuyButton({ listing, onBought, className = '' }: BuyButtonProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { writeContractAsync } = useWriteContract()
  const [loading, setLoading] = useState(false)
  const [bought, setBought] = useState(false)

  const priceWei = BigInt(listing.price)
  const eth = formatEther(priceWei).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')

  async function handleBuy() {
    if (!isConnected || !address) {
      openConnectModal?.()
      return
    }
    if (address.toLowerCase() === listing.seller.toLowerCase()) {
      toast.error("You can't buy your own listing")
      return
    }

    setLoading(true)
    toast.loading('Confirm purchase in wallet…', { id: 'buy' })

    try {
      const order = deserializeOrder(listing.orderComponents)

      await writeContractAsync({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'fulfillOrder',
        value: priceWei,
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
          '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex,
        ],
      })

      // Mark filled in our order book
      await fetch(`/api/listings/${listing.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'filled', buyer: address }),
      })

      setBought(true)
      toast.success('Purchased!', { id: 'buy' })
      onBought?.()
    } catch (err) {
      toast.error('Purchase failed', {
        id: 'buy',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <button
      onClick={handleBuy}
      disabled={loading || bought}
      className={`text-xs font-mono tracking-wider uppercase px-4 py-2.5 border transition-colors disabled:opacity-50 ${loading ? 'cursor-not-allowed' : ''} ${
        bought
          ? 'border-[#8B5CF6] text-[#8B5CF6] bg-[#8B5CF6]/10'
          : 'border-[#2a2a2a] text-[#888] hover:border-[#8B5CF6] hover:text-[#8B5CF6]'
      } ${className}`}
    >
      {bought ? 'bought' : loading ? 'buying…' : `buy ${eth} ETH`}
    </button>
  )
}
