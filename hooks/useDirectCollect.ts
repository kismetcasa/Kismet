'use client'

import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import type { Address, Hash } from 'viem'
import { useEnsureBase } from '@/lib/useEnsureBase'
import {
  ERC20_ABI,
  KISMET_REFERRAL,
  USDC_BASE,
  ZORA_1155_MINT_ABI,
  ZORA_ERC20_MINTER,
  ZORA_ERC20_MINTER_ABI,
  ZORA_FIXED_PRICE_STRATEGY,
  encodeFixedPriceMinterArgs,
} from '@/lib/zoraMint'

type CollectStatus =
  | 'idle'
  | 'preparing'
  | 'approving'
  | 'minting'
  | 'confirming'
  | 'recording'
  | 'done'
  | 'error'

export type CollectCurrency = 'eth' | 'usdc'

export interface CollectArgs {
  collectionAddress: Address
  tokenId: string
  pricePerToken: bigint
  currency: CollectCurrency
  amount?: number
  comment?: string
}

interface UseDirectCollectReturn {
  collect: (args: CollectArgs) => Promise<{ hash: Hash } | null>
  status: CollectStatus
}

const TOAST_ID = 'direct-collect'

/**
 * Submits a Zora 1155 mint directly from the user's connected wallet — no
 * inprocess sponsoring proxy. The user pays gas + price + Zora's protocol
 * mint fee, and the NFT lands in their EOA.
 *
 * Two paths:
 * - ETH (FixedPriceSaleStrategy): one tx via 1155.mint() with value =
 *   (mintFee + price) * amount.
 * - USDC (ERC20Minter): allowance check → optional approve tx → mint tx
 *   directly on the ERC20Minter strategy (note: NOT on the 1155).
 *
 * Kismet's referral address is passed on every mint so we earn the Zora
 * mint-referral split. After the mint receipt, posts to /api/collect to
 * record the collect for trending + collected-list + creator notification.
 */
export function useDirectCollect(): UseDirectCollectReturn {
  const { address } = useAccount()
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()
  const [status, setStatus] = useState<CollectStatus>('idle')

  const collect = useCallback(
    async (args: CollectArgs): Promise<{ hash: Hash } | null> => {
      const {
        collectionAddress,
        tokenId,
        pricePerToken,
        currency,
        amount = 1,
        comment = '',
      } = args

      if (!address) {
        toast.error('Connect a wallet to collect')
        return null
      }
      if (!publicClient) {
        toast.error('Network unavailable. Try again.')
        return null
      }

      setStatus('preparing')
      toast.loading('Switch to Base if prompted…', { id: TOAST_ID })

      try {
        await ensureBase()

        const tokenIdBn = BigInt(tokenId)
        const quantity = BigInt(Math.max(1, Math.floor(amount)))
        const totalPrice = pricePerToken * quantity

        let hash: Hash

        if (currency === 'eth') {
          // Read Zora's protocol fee dynamically — it changes occasionally.
          const mintFee = await publicClient.readContract({
            address: collectionAddress,
            abi: ZORA_1155_MINT_ABI,
            functionName: 'mintFee',
          })

          const value = (mintFee + pricePerToken) * quantity
          const minterArgs = encodeFixedPriceMinterArgs(address, comment)

          setStatus('minting')
          toast.loading('Confirm mint in wallet…', { id: TOAST_ID })

          hash = await writeContractAsync({
            chainId: base.id,
            address: collectionAddress,
            abi: ZORA_1155_MINT_ABI,
            functionName: 'mint',
            args: [
              ZORA_FIXED_PRICE_STRATEGY,
              tokenIdBn,
              quantity,
              [KISMET_REFERRAL],
              minterArgs,
            ],
            value,
          })
        } else {
          // ERC20 (USDC) path: check allowance, approve if short, then mint.
          const currentAllowance = await publicClient.readContract({
            address: USDC_BASE,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, ZORA_ERC20_MINTER],
          })

          if (currentAllowance < totalPrice) {
            setStatus('approving')
            toast.loading('Approve USDC in wallet… (1 of 2)', { id: TOAST_ID })

            const approveHash = await writeContractAsync({
              chainId: base.id,
              address: USDC_BASE,
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [ZORA_ERC20_MINTER, totalPrice],
            })

            toast.loading('Confirming approval…', { id: TOAST_ID })
            const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveHash })
            if (approveReceipt.status !== 'success') {
              throw new Error('USDC approval reverted')
            }
          }

          setStatus('minting')
          toast.loading('Confirm mint in wallet… (2 of 2)', { id: TOAST_ID })

          hash = await writeContractAsync({
            chainId: base.id,
            address: ZORA_ERC20_MINTER,
            abi: ZORA_ERC20_MINTER_ABI,
            functionName: 'mint',
            args: [
              address,
              quantity,
              collectionAddress,
              tokenIdBn,
              totalPrice,
              USDC_BASE,
              KISMET_REFERRAL,
              comment,
            ],
          })
        }

        setStatus('confirming')
        toast.loading('Confirming on-chain…', { id: TOAST_ID })

        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') {
          throw new Error('Mint reverted on-chain')
        }

        // Best-effort post-mint hooks: trending score, collected list, creator
        // notification. Failure here doesn't undo the mint — log and move on.
        setStatus('recording')
        try {
          await fetch('/api/collect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              moment: { collectionAddress, tokenId, chainId: base.id },
              account: address,
              amount: Number(quantity),
              comment,
              pricePerToken: pricePerToken.toString(),
              currency,
              txHash: hash,
            }),
          })
        } catch {
          // non-critical
        }

        setStatus('done')
        toast.success('Collected!', { id: TOAST_ID })
        return { hash }
      } catch (err) {
        setStatus('error')
        const message = err instanceof Error ? err.message : 'Collect failed'
        const description = /user rejected|user denied|rejected the request/i.test(message) ? 'Cancelled' : message
        toast.error('Collect failed', { id: TOAST_ID, description })
        return null
      }
    },
    [address, publicClient, writeContractAsync, ensureBase],
  )

  return { collect, status }
}
