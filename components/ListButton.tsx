'use client'

import { useState } from 'react'
import { useAccount, useReadContract, useWriteContract, usePublicClient } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSignTypedData } from 'wagmi'
import { parseEther } from 'viem'
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

interface ListButtonProps {
  collectionAddress: string
  tokenId: string
  name?: string
  image?: string
  creatorAddress?: string
  onListed?: () => void
  buttonClassName?: string
}

export function ListButton({
  collectionAddress,
  tokenId,
  name,
  image,
  creatorAddress,
  onListed,
  buttonClassName,
}: ListButtonProps) {
  const { address, isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { signTypedDataAsync } = useSignTypedData()
  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()

  const [showForm, setShowForm] = useState(false)
  const [priceEth, setPriceEth] = useState('')
  const [step, setStep] = useState<'idle' | 'approving' | 'signing' | 'submitting'>('idle')

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
    if (!publicClient) return

    const parsedPrice = parseFloat(priceEth)
    if (!priceEth || isNaN(parsedPrice) || parsedPrice <= 0) {
      toast.error('Enter a valid price greater than 0')
      return
    }

    const priceWei = parseEther(priceEth)

    try {
      // 1. Approve Seaport to transfer tokens if needed
      if (!isApproved) {
        setStep('approving')
        toast.loading('Approving Seaport…', { id: 'list' })
        await writeContractAsync({
          address: collectionAddress as Address,
          abi: ERC1155_ABI,
          functionName: 'setApprovalForAll',
          args: [SEAPORT_ADDRESS, true],
        })
        await refetchApproval()
      }

      // 2. Fetch royalty info via EIP-2981
      let royaltyReceiver = address as Address
      let royaltyAmount = 0n
      try {
        const royalty = await publicClient.readContract({
          address: collectionAddress as Address,
          abi: EIP2981_ABI,
          functionName: 'royaltyInfo',
          args: [BigInt(tokenId), priceWei],
        }) as [Address, bigint]
        royaltyReceiver = royalty[0]
        royaltyAmount = royalty[1]
      } catch {
        // Collection doesn't implement EIP-2981 — no royalty
      }

      const sellerProceeds = priceWei - royaltyAmount

      // 3. Fetch current Seaport counter for the offerer
      const counter = await publicClient.readContract({
        address: SEAPORT_ADDRESS,
        abi: SEAPORT_ABI,
        functionName: 'getCounter',
        args: [address as Address],
      }) as bigint

      // 4. Build the order
      const order = buildSellOrder({
        offerer: address as Address,
        collectionAddress: collectionAddress as Address,
        tokenId,
        sellerProceeds,
        royaltyReceiver,
        royaltyAmount,
        counter,
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
          price: priceWei.toString(),
          sellerProceeds: sellerProceeds.toString(),
          royaltyReceiver,
          royaltyAmount: royaltyAmount.toString(),
          orderComponents: serializeOrder(order),
          signature,
          expiresAt: Number(order.endTime) * 1000,
          name,
          image,
          creatorAddress,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to save listing')
      }

      toast.success('Listed for sale!', { id: 'list' })
      setShowForm(false)
      setPriceEth('')
      onListed?.()
    } catch (err) {
      toast.error('Listing failed', {
        id: 'list',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
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
        className={`w-full text-xs font-mono tracking-wider uppercase px-3 py-2.5 border border-[#2a2a2a] text-[#555] hover:border-[#8B5CF6] hover:text-[#8B5CF6] transition-colors ${buttonClassName ?? ''}`}
      >
        list
      </button>
    )
  }

  return (
    <div className="flex gap-1.5 items-center w-full">
      <input
        type="number"
        value={priceEth}
        onChange={(e) => setPriceEth(e.target.value)}
        placeholder="price in ETH"
        min="0"
        step="0.001"
        disabled={isBusy}
        className="flex-1 min-w-0 bg-[#111] border border-[#2a2a2a] px-2 py-2.5 text-xs text-[#efefef] font-mono placeholder-[#333] focus:outline-none focus:border-[#555] disabled:opacity-50"
      />
      <button
        onClick={handleList}
        disabled={isBusy}
        className="flex-shrink-0 text-xs font-mono tracking-wider uppercase px-3 py-2.5 btn-accent"
      >
        {step === 'approving' ? 'approving…'
          : step === 'signing' ? 'signing…'
          : step === 'submitting' ? 'saving…'
          : 'list'}
      </button>
      <button
        type="button"
        onClick={() => { setShowForm(false); setPriceEth('') }}
        disabled={isBusy}
        className="flex-shrink-0 text-xs font-mono text-[#555] hover:text-[#888] disabled:opacity-40"
      >
        ✕
      </button>
    </div>
  )
}
