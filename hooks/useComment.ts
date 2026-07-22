'use client'

import { useCallback, useState } from 'react'
import { useConfig, usePublicClient, useWriteContract } from 'wagmi'
import { getAccount } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { type Address, type Hash } from 'viem'
import { isValidTokenId } from '@/lib/address'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { toastError, TERMINAL_TOAST_DURATION_MS } from '@/lib/toast'
import { ZORA_COMMENTS, COMMENTS_ABI, buildCommentCall } from '@/lib/zoraComments'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'

export type CommentStatus =
  | 'idle'
  | 'preparing'
  | 'commenting'
  | 'confirming'
  | 'done'
  | 'error'

const TOAST_ID = 'onchain-comment'

/**
 * Post an on-chain comment to Zora's Comments contract for a token the user
 * already holds — the "comment after you collected" path. The contract itself
 * gates on ownership, so there's no Kismet-side gate/store; the user pays one
 * spark + gas. In Process indexes the emitted `Commented` event into
 * /moment/comments, so the comment surfaces in the activity feed once indexed.
 *
 * Mirrors useDirectCollect's shape (wagmi write → receipt → toast), minus the
 * price/currency machinery — a comment has no sale, just the fixed spark value.
 */
export function useComment() {
  const config = useConfig()
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()
  const [status, setStatus] = useState<CommentStatus>('idle')

  const submitComment = useCallback(
    async (args: {
      collectionAddress: Address
      tokenId: string
      text: string
    }): Promise<{ hash: Hash } | null> => {
      const account = getAccount(config).address
      if (!account) {
        toast.error('Connect a wallet to comment')
        return null
      }
      if (!publicClient) {
        toast.error('Network unavailable')
        return null
      }
      const text = args.text.trim()
      if (!text) return null
      if (!isValidTokenId(args.tokenId)) {
        toast.error('Invalid token id')
        return null
      }

      setStatus('preparing')
      toast.loading('Preparing comment…', { id: TOAST_ID })
      try {
        await ensureBase()

        // Exactly one spark, read live — it's an on-chain immutable, so never
        // hardcode it (a value != sparkValue reverts).
        const sparkValue = await publicClient.readContract({
          address: ZORA_COMMENTS,
          abi: COMMENTS_ABI,
          functionName: 'sparkValue',
        })

        setStatus('commenting')
        toast.loading('Confirm comment in wallet…', { id: TOAST_ID })
        const hash = await writeContractAsync({
          chainId: base.id,
          address: ZORA_COMMENTS,
          ...buildCommentCall({
            commenter: account,
            collection: args.collectionAddress,
            tokenId: BigInt(args.tokenId),
            text,
          }),
          value: sparkValue,
          dataSuffix: BUILDER_DATA_SUFFIX,
        })

        setStatus('confirming')
        toast.loading('Posting onchain…', { id: TOAST_ID })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success') throw new Error('Comment reverted on-chain')

        setStatus('done')
        toast.success('Comment posted', {
          id: TOAST_ID,
          duration: TERMINAL_TOAST_DURATION_MS,
          // Surfaces the tx so the poster (and, for the initial verification,
          // we) can view it on-chain.
          action: {
            label: 'View',
            onClick: (event) => {
              event.preventDefault()
              if (typeof window !== 'undefined') {
                window.open(`https://basescan.org/tx/${hash}`, '_blank', 'noopener')
              }
            },
          },
        })
        return { hash }
      } catch (err) {
        setStatus('error')
        toastError('Comment', err, { id: TOAST_ID })
        return null
      }
    },
    [config, publicClient, writeContractAsync, ensureBase],
  )

  return { submitComment, status }
}
