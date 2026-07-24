'use client'

import { useCallback, useRef, useState } from 'react'
import { useConfig, usePublicClient, useWriteContract } from 'wagmi'
import { getAccount } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { getAddress, type Address, type Hash } from 'viem'
import { isValidTokenId } from '@/lib/address'
import { trackFunnel } from '@/lib/funnel'
import { reportClientError } from '@/lib/clientError'
import { resolveOnchainSale } from '@/lib/saleConfig'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { useWalletRecovery } from '@/hooks/useWalletRecovery'
import { useFarcaster } from '@/providers/FarcasterProvider'
import { collectShareToastAction } from '@/lib/collectShare'
import { BUILDER_DATA_SUFFIX } from '@/lib/builderCode'
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

/**
 * Moment context for the post-collect share prompt. Optional: when provided
 * AND we're inside a Mini App, the success toast carries a "Share" action
 * that opens the host cast composer prefilled with
 * `collected "<name>" by @creator on @kismet` (see lib/collectShare). On the
 * web — where there's no host composer — the plain success toast shows as
 * before, so callers can pass this unconditionally.
 */
export interface CollectShareOffer {
  momentName: string | null
  creatorAddress: string | null
  creatorName?: string | null
}

export interface CollectArgs {
  collectionAddress: Address
  tokenId: string
  amount?: number
  comment?: string
  share?: CollectShareOffer
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
  const config = useConfig()
  const publicClient = usePublicClient({ chainId: base.id })
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()
  // Gates the post-collect share offer: composeCast is a host action, so the
  // Share toast action only renders inside a confirmed Mini App host.
  const { isInMiniApp } = useFarcaster()
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
      const { tokenId, amount = 1, comment = '' } = args

      // Read the signer from the wagmi store — authoritative, and reflects a
      // wallet connected in this same tap (via useEnsureConnected) before
      // React re-renders this hook.
      const account = getAccount(config).address
      if (!account) {
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
      if (inFlightRef.current) return null
      inFlightRef.current = true

      // Funnel: one real attempt per latch pass (re-entrance and recovery
      // retries of the same press don't double-count).
      trackFunnel('collect_attempt')
      setStatus('preparing')
      toast.loading('Switch to Base if prompted…', { id: TOAST_ID })

      try {
        await ensureBase()

        const tokenIdBn = BigInt(tokenId)

        // Read the live sale (price + currency) straight from chain — the
        // authoritative source, exactly like the mint fee below. Collect never
        // depends on the feed's best-effort display price (useMomentSale), so
        // the button is never a silent dead-end when that hasn't resolved.
        // publicClient is pinned to Base, so the read targets the right chain.
        toast.loading('Loading sale…', { id: TOAST_ID })
        const sale = await resolveOnchainSale(publicClient, collectionAddress, tokenIdBn)
        if (!sale) {
          setStatus('error')
          toast.error('No active sale for this artwork', { id: TOAST_ID })
          return null
        }
        const { pricePerToken, currency } = sale

        // Window check. resolveOnchainSale returns a configured sale whenever its
        // row exists (it checks neither bound), and the button's saleNotStarted /
        // saleEnded gates only bite once the card's saleConfig has loaded — so a
        // click in that pre-load window (or any non-button caller) would reach the
        // strategy and revert with SaleHasNotStarted / SaleEnded. Refuse outside
        // [saleStart, saleEnd] with a clean message; the on-chain check stays the
        // backstop. Operators match the strategy exactly (active for
        // saleStart <= now <= saleEnd) so we never block a mint the chain would
        // accept; saleEnd 0 = no end. Wall-clock matches the display gate's clock.
        const nowSec = BigInt(Math.floor(Date.now() / 1000))
        if (sale.saleStart > nowSec) {
          setStatus('error')
          toast.error('This mint has not started yet', { id: TOAST_ID })
          return null
        }
        if (sale.saleEnd !== 0n && nowSec > sale.saleEnd) {
          setStatus('error')
          toast.error('This mint has ended', { id: TOAST_ID })
          return null
        }

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
              mintTo: account,
              quantity,
              mintFee,
              pricePerToken,
              comment,
            }),
            dataSuffix: BUILDER_DATA_SUFFIX,
          })
        } else {
          // ERC20 (USDC) path: check allowance, approve if short, then mint.
          const currentAllowance = await publicClient.readContract({
            address: USDC_BASE,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [account, ZORA_ERC20_MINTER],
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
              dataSuffix: BUILDER_DATA_SUFFIX,
            })

            toast.loading('Confirming approval…', { id: TOAST_ID })
            const approveReceipt = await publicClient.waitForTransactionReceipt({
              hash: approveHash,
              timeout: 300_000,
            })
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
              mintTo: account,
              quantity,
              pricePerToken,
              comment,
            }),
            dataSuffix: BUILDER_DATA_SUFFIX,
          })
        }

        setStatus('confirming')
        toast.loading('Confirming on-chain…', { id: TOAST_ID })

        // Bounded wait: without a timeout this await can hang indefinitely on
        // a stuck RPC/websocket, leaving the mint successful on-chain but the
        // record (collected list, trending, Pass validity) never sent — the
        // exact silent-loss that stranded a desktop-browser Pass buyer. 300s
        // matches useCollectAll; a timeout throws into the catch below (visible
        // error the user can retry) instead of an infinite "Confirming…" spinner.
        const receipt = await publicClient.waitForTransactionReceipt({
          hash,
          timeout: 300_000,
        })
        if (receipt.status !== 'success') {
          throw new Error('Mint reverted on-chain')
        }

        // Post-mint recording: trending score, collected list, creator
        // notification, and — for a Pass — the validity credit. The mint has
        // already succeeded on-chain, so a dropped record here is SILENT data
        // loss (the buyer can't see the piece and, for a Pass, can't mint).
        // Make it resilient:
        //   • keepalive — a same-tap navigation still flushes the request
        //     (plain fetch is abandoned on unload; this is a likely contributor
        //     to the stranded desktop-browser Pass buyer),
        //   • bounded retry — the server 403s until ITS RPC has indexed the tx;
        //     a couple of spaced retries absorb that lag. /api/collect is
        //     idempotent (per-tuple lock), so retries never double-count,
        //   • reportClientError on total failure — a durable server-side trace
        //     instead of a discarded console line, so the lost record can be
        //     reconciled.
        // Fix A (the webhook crediting mints unconditionally) and the
        // reconciliation script are the last-resort backstops for Pass validity
        // if the record is lost entirely.
        setStatus('recording')
        const collectBody = JSON.stringify({
          moment: { collectionAddress, tokenId, chainId: base.id },
          account,
          amount: Number(quantity),
          comment,
          pricePerToken: pricePerToken.toString(),
          currency,
          txHash: hash,
        })
        let recorded = false
        for (let attempt = 0; attempt < 3 && !recorded; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 600 * attempt))
          try {
            const res = await fetch('/api/collect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: collectBody,
              keepalive: true,
            })
            if (res.ok) {
              recorded = true
            } else {
              console.error('[direct-collect] /api/collect non-2xx', {
                tokenId,
                status: res.status,
                attempt,
              })
            }
          } catch (err) {
            console.error('[direct-collect] /api/collect failed', { tokenId, attempt, err })
          }
        }
        if (!recorded) {
          reportClientError('direct_collect.record_failed', {
            tokenId,
            collectionAddress,
            txHash: hash,
            account,
          })
        }

        trackFunnel('collect_success')
        setStatus('done')
        // Success toast — inside a Mini App (and given moment context) it
        // doubles as the share-to-feed prompt: 8s (matching the Add Kismet
        // prompt) so the user has time to act, with a Share action that opens
        // the host cast composer prefilled for /kismet.
        if (args.share && isInMiniApp) {
          toast.success('Collected!', {
            id: TOAST_ID,
            description: 'Share it to /kismet?',
            duration: 8000,
            action: collectShareToastAction({
              collectionAddress,
              tokenId,
              momentName: args.share.momentName,
              creatorAddress: args.share.creatorAddress,
              creatorName: args.share.creatorName,
            }),
          })
        } else {
          toast.success('Collected!', { id: TOAST_ID })
        }
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
    [config, publicClient, writeContractAsync, ensureBase, isInMiniApp, consumeRetryFlag, showError, ackSuccess],
  )

  collectRef.current = collect

  return { collect, status }
}
