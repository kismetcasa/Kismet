'use client'

import { useCallback } from 'react'
import { useAccount, usePublicClient } from 'wagmi'
import { base } from 'wagmi/chains'
import { parseAbi, type Address, type Hex } from 'viem'
import { COLLECTION_ABI } from '@/lib/collections'
import { canAdminMint } from '@/lib/creatorCopy'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
import { useWriteContract } from '@/hooks/useWallet'

const BALANCE_OF_1155 = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)'])

/**
 * Sends the artist's copy of a limited edition from their own wallet, which
 * In Process's relay won't do (lib/creatorCopy has why). MintForm checks
 * `canSend` before any upload and calls `send` once the relay mint returns.
 */
export function useCreatorCopy() {
  const publicClient = usePublicClient({ chainId: base.id })
  const { address } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()

  /** Whether the connected wallet may adminMint in `collection`. null when
   *  the read failed — the caller lets the mint go ahead and `send` reports. */
  const canSend = useCallback(
    async (collection: Address): Promise<boolean | null> => {
      if (!publicClient || !address) return null
      try {
        const perms = await publicClient.readContract({
          address: collection,
          abi: COLLECTION_ABI,
          functionName: 'permissions',
          args: [0n, address],
        })
        return canAdminMint(perms as bigint)
      } catch {
        return null
      }
    },
    [publicClient, address],
  )

  /**
   * 'held': the artist already holds a copy (In Process minted it), nothing
   * sent. 'sent': adminMint(artist, tokenId, 1) confirmed. Throws when the
   * wallet refuses or the transaction reverts — the artwork is minted either
   * way, so the caller reports and moves on.
   */
  const send = useCallback(
    async (p: { collection: Address; tokenId: bigint; createTx?: Hex }): Promise<'held' | 'sent'> => {
      if (!publicClient || !address) throw new Error('Wallet not connected')
      // Read the balance no earlier than the create's own block, so a copy In
      // Process did mint is seen rather than doubled.
      if (p.createTx) {
        await publicClient.waitForTransactionReceipt({ hash: p.createTx, timeout: 60_000 }).catch(() => {})
      }
      const held = await publicClient
        .readContract({ address: p.collection, abi: BALANCE_OF_1155, functionName: 'balanceOf', args: [address, p.tokenId] })
        .catch(() => 0n)
      if (held > 0n) return 'held'
      await ensureBase()
      const hash = await writeContractAsync({
        chainId: base.id,
        address: p.collection,
        abi: COLLECTION_ABI,
        functionName: 'adminMint',
        args: [address, p.tokenId, 1n, '0x'],
        dataSuffix: BUILDER_DATA_SUFFIX,
      })
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error('The copy transaction reverted')
      return 'sent'
    },
    [publicClient, address, writeContractAsync, ensureBase],
  )

  return { canSend, send }
}
