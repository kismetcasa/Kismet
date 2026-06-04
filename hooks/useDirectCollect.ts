'use client'

import { useCallback, useRef, useState } from 'react'
import { useAccount, useConfig, useWriteContract } from 'wagmi'
import { getPublicClient } from '@wagmi/core'
import { toast } from 'sonner'
import { getAddress, type Address, type Hash } from 'viem'
import { isValidTokenId } from '@/lib/address'
import { useEnsureChain } from '@/lib/useEnsureBase'
import { BASE_CHAIN_ID } from '@/lib/chains'
import { useWalletRecovery } from '@/hooks/useWalletRecovery'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
import {
  ERC20_ABI,
  buildEthMintCall,
  buildUsdcMintCall,
  erc20Minter,
  readMintFeeWithBound,
  usdcAddress,
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
  /** Chain the moment lives on. Defaults to Base. */
  chainId?: number
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
  const config = useConfig()
  const { writeContractAsync } = useWriteContract()
  const ensureChain = useEnsureChain()
  const { consumeRetryFlag, showError, ackSuccess } = useWalletRecovery(TOAST_ID, 'Collect')
  const [status, setStatus] = useState<CollectStatus>('idle')
  // Lets the recovery flow's post-reconnect retry re-invoke the latest
  // `collect` closure. A ref breaks the cycle that would otherwise
  // require collect's own useCallback to depend on itself.
  const collectRef = useRef<(args: CollectArgs) => Promise<{ hash: Hash } | null>>(
    () => Promise.resolve(null),
  )
  // Synchronous re-entrance latch. The button stays clickable through
  // status === 'error' (see consumers), so during the 2-8s reconnect
  // window between layer-2's Reconnect tap and the auto-retry firing,
  // a manual tap could otherwise dispatch a parallel collect — leading
  // to a double-charge if both succeed.
  const inFlightRef = useRef(false)

  const collect = useCallback(
    async (args: CollectArgs): Promise<{ hash: Hash } | null> => {
      const isRetryAfterRecovery = consumeRetryFlag()
      const {
        tokenId,
        pricePerToken,
        currency,
        amount = 1,
        comment = '',
        chainId = BASE_CHAIN_ID,
      } = args

      if (!address) {
        toast.error('Connect a wallet to collect')
        return null
      }
      // Public client for the moment's chain (wagmi configures both Base +
      // mainnet — see lib/wagmi.ts). Resolved per-call so a mixed feed collects
      // each card on its own chain.
      const publicClient = getPublicClient(config, { chainId })
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
      if (inFlightRef.current) return null
      inFlightRef.current = true

      setStatus('preparing')
      toast.loading('Switch network if prompted…', { id: TOAST_ID })

      try {
        await ensureChain(chainId)

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
            chainId,
            address: collectionAddress,
            ...buildEthMintCall({
              tokenId: tokenIdBn,
              mintTo: address,
              quantity,
              mintFee,
              pricePerToken,
              comment,
              chainId,
            }),
            dataSuffix: BUILDER_DATA_SUFFIX,
          })
        } else {
          // ERC20 (USDC) path: check allowance, approve if short, then mint —
          // all on the moment's chain (USDC token + ERC20Minter differ per chain).
          const usdc = usdcAddress(chainId)
          const minter = erc20Minter(chainId)
          const currentAllowance = await publicClient.readContract({
            address: usdc,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address, minter],
          })

          if (currentAllowance < totalPrice) {
            setStatus('approving')
            toast.loading('Approve USDC in wallet… (1 of 2)', { id: TOAST_ID })

            const approveHash = await writeContractAsync({
              chainId,
              address: usdc,
              abi: ERC20_ABI,
              functionName: 'approve',
              args: [minter, totalPrice],
              dataSuffix: BUILDER_DATA_SUFFIX,
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
            chainId,
            address: minter,
            ...buildUsdcMintCall({
              collection: collectionAddress,
              tokenId: tokenIdBn,
              mintTo: address,
              quantity,
              pricePerToken,
              comment,
              chainId,
            }),
            dataSuffix: BUILDER_DATA_SUFFIX,
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
              moment: { collectionAddress, tokenId, chainId },
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
        ackSuccess()
        return { hash }
      } catch (err) {
        setStatus('error')
        showError(err, isRetryAfterRecovery, () => {
          void collectRef.current(args)
        })
        return null
      } finally {
        inFlightRef.current = false
      }
    },
    [address, config, writeContractAsync, ensureChain, consumeRetryFlag, showError, ackSuccess],
  )

  collectRef.current = collect

  return { collect, status }
}
