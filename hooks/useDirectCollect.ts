'use client'

import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useReconnect, useWriteContract } from 'wagmi'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { getAddress, type Address, type Hash } from 'viem'
import { isValidTokenId } from '@/lib/address'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { toastError } from '@/lib/toast'
import {
  ERC20_ABI,
  USDC_BASE,
  ZORA_ERC20_MINTER,
  buildEthMintCall,
  buildUsdcMintCall,
  readMintFeeWithBound,
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
 *
 * REGRESSION WARNING — do NOT "optimize" batched single-mints by wrapping
 * multiple 1155.mint() calls in the inherited multicall(bytes[]) entry
 * point. Per Zora's canonical ABI, multicall is declared `nonpayable` so
 * any value sent reverts at dispatch — and even if it were payable, OZ's
 * delegatecall pattern replicates msg.value across sub-calls, which the
 * FixedPriceSaleStrategy strict-equality check rejects with WrongValueSent.
 * See useCollectAll for the EIP-5792-based batching pattern instead.
 */
export function useDirectCollect(): UseDirectCollectReturn {
  const { address } = useAccount()
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  // Recovery for a connected-but-unauthorized wallet (stale session): the
  // toast's Reconnect action re-runs wagmi's connector reconnect, the
  // programmatic equivalent of the page-refresh users currently rely on.
  const { reconnect } = useReconnect()
  const ensureBase = useEnsureBase()
  const [status, setStatus] = useState<CollectStatus>('idle')

  const collect = useCallback(
    async (args: CollectArgs): Promise<{ hash: Hash } | null> => {
      const {
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
        toast.error('Network unavailable')
        return null
      }
      // Trust-boundary validation: normalize + check the collection address
      // and tokenId before any encoding touches them. The interface types
      // collectionAddress as Address, but a bad `as Address` upstream would
      // otherwise slip through silently.
      let collectionAddress: Address
      try {
        collectionAddress = getAddress(args.collectionAddress)
      } catch {
        toast.error('Invalid collection address')
        return null
      }
      if (!isValidTokenId(tokenId)) {
        toast.error('Invalid token id')
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
          // readMintFeeWithBound also asserts the value is within sanity
          // limits before the caller signs anything.
          const mintFee = await readMintFeeWithBound(publicClient, collectionAddress)

          setStatus('minting')
          toast.loading('Confirm mint in wallet…', { id: TOAST_ID })

          hash = await writeContractAsync({
            chainId: base.id,
            address: collectionAddress,
            ...buildEthMintCall({
              tokenId: tokenIdBn,
              mintTo: address,
              quantity,
              mintFee,
              pricePerToken,
              comment,
            }),
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
            ...buildUsdcMintCall({
              collection: collectionAddress,
              tokenId: tokenIdBn,
              mintTo: address,
              quantity,
              pricePerToken,
              comment,
            }),
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
        // Surface both network errors (catch) and non-2xx HTTP responses so
        // support can trace dropped recordings; fetch only rejects on
        // transport errors, so 429/403/500s would otherwise be silenced.
        setStatus('recording')
        try {
          const res = await fetch('/api/collect', {
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
          if (!res.ok) {
            console.error('[direct-collect] /api/collect non-2xx', {
              tokenId,
              status: res.status,
            })
          }
        } catch (err) {
          console.error('[direct-collect] /api/collect failed', { tokenId, err })
        }

        setStatus('done')
        toast.success('Collected!', { id: TOAST_ID })
        return { hash }
      } catch (err) {
        setStatus('error')
        toastError('Collect', err, { id: TOAST_ID, onReconnect: () => reconnect() })
        return null
      }
    },
    [address, publicClient, writeContractAsync, reconnect, ensureBase],
  )

  return { collect, status }
}
