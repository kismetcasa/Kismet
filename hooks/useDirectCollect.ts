'use client'

import { useCallback, useRef, useState } from 'react'
import { useAccount, useConfig, usePublicClient, useReconnect, useWriteContract } from 'wagmi'
import { getAccount } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { toast } from 'sonner'
import { getAddress, type Address, type Hash } from 'viem'
import { isValidTokenId } from '@/lib/address'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { isAuthError, toastError, toastReloadRecovery } from '@/lib/toast'
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
  const config = useConfig()
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  // Recovery for a connected-but-unauthorized wallet (stale session).
  // reconnectAsync silently re-authorizes on Farcaster / injected; for
  // WalletConnect it either re-pairs or actively disconnects (its
  // isAuthorized() tears down stale sessions). When that drops us to
  // disconnected, we fall back to the wallet picker so the user always
  // lands somewhere actionable. See the recovery handler below.
  const { reconnectAsync } = useReconnect()
  const { openConnectModal } = useConnectModal()
  const ensureBase = useEnsureBase()
  const [status, setStatus] = useState<CollectStatus>('idle')
  // Lets the failure toast's Retry action re-invoke the latest `collect`
  // closure with the same args. A ref breaks the circular dep that would
  // otherwise require putting `collect` in its own useCallback's deps.
  const collectRef = useRef<(args: CollectArgs) => Promise<{ hash: Hash } | null>>(
    () => Promise.resolve(null),
  )
  // Dedupes rapid double-taps of the Retry button. Sonner's toast action
  // stays clickable until the next toast replaces it, so without this a
  // panicked retap can fire two concurrent collect attempts.
  const isRecoveringRef = useRef(false)
  // Set to true by the recovery handler immediately before it kicks off
  // the post-reconnect retry; consumed at the next collect entry. When
  // the retry ALSO hits an auth-class error, this flag tells us not to
  // show another Reconnect button (reconnect already failed to fix it)
  // and to fall through to the "Try reloading" terminal recovery instead.
  // Single-shot: cleared synchronously on the next collect call so a
  // non-retry collect never inherits the flag.
  const isRetryAfterRecoveryRef = useRef(false)

  const collect = useCallback(
    async (args: CollectArgs): Promise<{ hash: Hash } | null> => {
      const isRetryAfterRecovery = isRetryAfterRecoveryRef.current
      isRetryAfterRecoveryRef.current = false
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
        // Layer-3 terminal recovery: reconnect already ran once for this
        // failure chain and the wallet is STILL returning an auth error.
        // wagmi reconnect can't fix this (most commonly a Farcaster Mini
        // App with a dead host bridge, where isAuthorized() returns true
        // but the host won't sign). A full page reload re-bootstraps the
        // SDK and is the universal recovery across every connector type.
        if (isRetryAfterRecovery && isAuthError(err)) {
          toastReloadRecovery({ id: TOAST_ID })
          return null
        }
        // Layer-2 first-failure recovery: try reconnect + retry.
        toastError('Collect', err, {
          id: TOAST_ID,
          onReconnect: () => {
            // Dedupe rapid retaps: the toast remains clickable until our
            // new toast replaces it, so a double-tap would otherwise fire
            // two concurrent collect attempts.
            if (isRecoveringRef.current) return
            isRecoveringRef.current = true
            // Fire-and-forget: the toast action is sync. We re-attempt
            // the same collect on success, or hand off to the wallet
            // picker if reconnect couldn't restore signing. (toast.ts has
            // already replaced the toast with "Reconnecting…" so the
            // user has visible progress during the await below.)
            void (async () => {
              try {
                try {
                  await reconnectAsync()
                } catch {
                  // reconnect itself can throw on dead connectors — fall
                  // through to the post-reconnect status check below.
                }
                const account = getAccount(config)
                if (account.status === 'connected' && account.address) {
                  isRetryAfterRecoveryRef.current = true
                  void collectRef.current(args)
                } else {
                  // Dismiss the stale "Reconnecting…" toast before the
                  // modal takes over — otherwise it lingers in the corner
                  // while the user picks a wallet.
                  toast.dismiss(TOAST_ID)
                  openConnectModal?.()
                }
              } finally {
                isRecoveringRef.current = false
              }
            })()
          },
        })
        return null
      }
    },
    [address, publicClient, writeContractAsync, reconnectAsync, config, openConnectModal, ensureBase],
  )

  collectRef.current = collect

  return { collect, status }
}
