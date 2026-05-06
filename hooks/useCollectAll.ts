'use client'

import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useWriteContract } from 'wagmi'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { encodeFunctionData, type Address, type Hash } from 'viem'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { toastError } from '@/lib/toast'
import { fetchEthEligibleTokens } from '@/lib/saleConfig'
import {
  KISMET_REFERRAL,
  MAX_COLLECT_ALL_BATCH,
  ZORA_1155_MINT_ABI,
  ZORA_FIXED_PRICE_STRATEGY,
  ZORA_MULTICALL_ABI,
  encodeFixedPriceMinterArgs,
} from '@/lib/zoraMint'

type Status =
  | 'idle'
  | 'preparing'
  | 'minting'
  | 'confirming'
  | 'recording'
  | 'done'
  | 'error'

const TOAST_ID = 'collect-all'

export interface CollectAllArgs {
  collectionAddress: Address
  // Server-pre-filtered ETH-eligible token IDs from /api/featured/collections-hydrated.
  // We re-check eligibility client-side (sale state may have shifted, and we
  // can now skip tokens this account already owns where maxPerAddress === 1).
  candidateTokenIds: string[]
}

interface UseCollectAllReturn {
  collectAll: (args: CollectAllArgs) => Promise<{ hash: Hash; minted: number } | null>
  status: Status
}

/**
 * "Collect all" — bundles up to MAX_COLLECT_ALL_BATCH per-token mint() calls
 * into a single Zora 1155 multicall(bytes[]). ETH-only: USDC mints route
 * through ERC20Minter (a separate contract) and require a per-token approve,
 * so they fall back to the per-token collect on the moment detail view.
 */
export function useCollectAll(): UseCollectAllReturn {
  const { address } = useAccount()
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()
  const [status, setStatus] = useState<Status>('idle')

  const collectAll = useCallback(
    async (args: CollectAllArgs) => {
      const { collectionAddress, candidateTokenIds } = args

      if (!address) {
        toast.error('Connect a wallet to collect')
        return null
      }
      if (!publicClient) {
        toast.error('Network unavailable')
        return null
      }
      if (candidateTokenIds.length === 0) {
        toast.info('Nothing to collect in this collection')
        return null
      }

      setStatus('preparing')
      toast.loading('Switch to Base if prompted…', { id: TOAST_ID })

      try {
        await ensureBase()

        // Fresh eligibility check with the user's account so we can skip
        // tokens they already own (single-edition mints would otherwise revert
        // the whole multicall).
        const ids = candidateTokenIds.map((s) => BigInt(s))
        const eligible = await fetchEthEligibleTokens(
          publicClient,
          collectionAddress,
          ids,
          address as Address,
        )

        if (eligible.length === 0) {
          setStatus('idle')
          toast.error(
            'Nothing to collect right now — sales may have ended, sold out, or you already own them',
            { id: TOAST_ID },
          )
          return null
        }

        const batch = eligible.slice(0, MAX_COLLECT_ALL_BATCH)

        // Mint fee changes occasionally; read once per submit.
        const mintFee = await publicClient.readContract({
          address: collectionAddress,
          abi: ZORA_1155_MINT_ABI,
          functionName: 'mintFee',
        })

        const minterArgs = encodeFixedPriceMinterArgs(address as Address, '')

        const calls = batch.map(
          (e) =>
            encodeFunctionData({
              abi: ZORA_1155_MINT_ABI,
              functionName: 'mint',
              args: [
                ZORA_FIXED_PRICE_STRATEGY,
                e.tokenId,
                1n,
                [KISMET_REFERRAL],
                minterArgs,
              ],
            }) as `0x${string}`,
        )

        const totalValue = batch.reduce(
          (sum, e) => sum + mintFee + e.pricePerToken,
          0n,
        )

        setStatus('minting')
        toast.loading(`Confirm in wallet — collecting ${batch.length}…`, {
          id: TOAST_ID,
        })

        const hash = await writeContractAsync({
          chainId: base.id,
          address: collectionAddress,
          abi: ZORA_MULTICALL_ABI,
          functionName: 'multicall',
          args: [calls],
          value: totalValue,
        })

        setStatus('confirming')
        toast.loading('Confirming on-chain…', { id: TOAST_ID })

        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') {
          throw new Error('Multicall reverted on-chain')
        }

        // Best-effort post-mint hooks: trending score, collected list,
        // creator notification — one POST per token. Failure is non-critical.
        setStatus('recording')
        await Promise.all(
          batch.map((e) =>
            fetch('/api/collect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                moment: {
                  collectionAddress,
                  tokenId: e.tokenId.toString(),
                  chainId: base.id,
                },
                account: address,
                amount: 1,
                comment: '',
                pricePerToken: e.pricePerToken.toString(),
                currency: 'eth',
                txHash: hash,
              }),
            }).catch(() => {}),
          ),
        )

        setStatus('done')
        toast.success(
          `Collected ${batch.length} moment${batch.length === 1 ? '' : 's'}!`,
          { id: TOAST_ID },
        )
        return { hash, minted: batch.length }
      } catch (err) {
        setStatus('error')
        toastError('Collect all', err, { id: TOAST_ID })
        return null
      }
    },
    [address, publicClient, writeContractAsync, ensureBase],
  )

  return { collectAll, status }
}
