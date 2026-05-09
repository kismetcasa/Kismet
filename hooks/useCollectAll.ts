'use client'

import { useCallback, useRef, useState } from 'react'
import { useAccount, useConfig, usePublicClient, useSendCalls } from 'wagmi'
import { waitForCallsStatus } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { toastError } from '@/lib/toast'
import {
  fetchEthEligibleTokens,
  fetchUsdcEligibleTokens,
  type EligibleToken,
} from '@/lib/saleConfig'
import {
  ERC20_ABI,
  KISMET_REFERRAL,
  MAX_COLLECT_ALL_BATCH,
  USDC_BASE,
  ZORA_1155_MINT_ABI,
  ZORA_ERC20_MINTER,
  ZORA_ERC20_MINTER_ABI,
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
  // Server-pre-filtered ETH-eligible token IDs from collection hydrators.
  // Re-checked client-side at click time (sale state may have shifted).
  ethCandidateTokenIds: string[]
  // Server-pre-filtered USDC-eligible token IDs (currency === USDC_BASE).
  // Same re-check semantics as the ETH list.
  usdcCandidateTokenIds: string[]
}

interface RecordEntry {
  tokenId: string
  pricePerToken: bigint
  currency: 'eth' | 'usdc'
}

// Bundle calls and the record entries they're responsible for stay in
// lockstep so that, after waitForCallsStatus returns, we can attribute
// each receipt's success/failure back to the exact tokens it covered.
// USDC.approve has no records (it's a setup call); ETH multicall carries
// every ETH mint's record; USDC mints carry one record each.
interface CallSegment {
  call: { to: Address; data: Hex; value?: bigint }
  records: RecordEntry[]
}

interface UseCollectAllReturn {
  collectAll: (args: CollectAllArgs) => Promise<{ minted: number } | null>
  status: Status
}

/**
 * "Collect all" — submits one EIP-5792 wallet_sendCalls bundle covering
 * every ETH- and USDC-eligible token in a collection. Wallets that
 * support atomic batching (Coinbase Smart Wallet, MetaMask post-Pectra,
 * etc.) confirm the entire bundle in a single signature; others fall
 * back to sequential prompts via experimental_fallback.
 *
 * Bundle layout (in order, only the legs we have eligible tokens for):
 *   1. ETH leg — one 1155.multicall(bytes[]) carrying all ETH mints
 *   2. USDC.approve(ERC20Minter, exactBatchTotal) — only when current
 *      allowance is below batch total. Bounded to the exact total per
 *      2024+ approval security guidance (no MaxUint256).
 *   3. USDC mints — one ERC20Minter.mint(...) per token (the minter
 *      doesn't expose a verified Multicall(bytes[]) entry point, so
 *      we list each mint as its own call in the bundle and let the
 *      wallet bundle them atomically).
 *
 * Pre-filtering removes tokens that would revert (sale ended, sold
 * out, or the connected account already owns to maxPerAddress) so the
 * batch lands cleanly. Capped at MAX_COLLECT_ALL_BATCH total mints to
 * keep wallet gas previews readable.
 */
export function useCollectAll(): UseCollectAllReturn {
  const { address } = useAccount()
  const config = useConfig()
  const publicClient = usePublicClient({ chainId: base.id })
  const { sendCallsAsync } = useSendCalls()
  const ensureBase = useEnsureBase()
  const [status, setStatus] = useState<Status>('idle')
  // Synchronous re-entrance latch. setStatus is async — between the user's
  // click and React committing the disabled-button render, a double-click
  // could otherwise kick off two parallel bundles.
  const inFlightRef = useRef(false)

  const collectAll = useCallback(
    async (args: CollectAllArgs) => {
      const { collectionAddress, ethCandidateTokenIds, usdcCandidateTokenIds } = args

      if (!address) {
        toast.error('Connect a wallet to collect')
        return null
      }
      if (!publicClient) {
        toast.error('Network unavailable')
        return null
      }
      if (ethCandidateTokenIds.length === 0 && usdcCandidateTokenIds.length === 0) {
        toast.info('Nothing to collect in this collection')
        return null
      }
      if (inFlightRef.current) return null
      inFlightRef.current = true

      setStatus('preparing')
      toast.loading('Switch to Base if prompted…', { id: TOAST_ID })

      try {
        await ensureBase()

        // Fresh eligibility re-check with the connected account so we can
        // skip tokens already at the per-account cap. A revert in any single
        // bundled call would cascade on atomic wallets.
        const [ethEligible, usdcEligible] = await Promise.all([
          ethCandidateTokenIds.length > 0
            ? fetchEthEligibleTokens(
                publicClient,
                collectionAddress,
                ethCandidateTokenIds.map((s) => BigInt(s)),
                address as Address,
              )
            : Promise.resolve<EligibleToken[]>([]),
          usdcCandidateTokenIds.length > 0
            ? fetchUsdcEligibleTokens(
                publicClient,
                collectionAddress,
                usdcCandidateTokenIds.map((s) => BigInt(s)),
                address as Address,
              )
            : Promise.resolve<EligibleToken[]>([]),
        ])

        // Apply the global batch cap proportionally — favor ETH first since
        // it's cheaper per call. Anything dropped here just isn't collected
        // this round; the user can re-click to grab the rest.
        const ethBatch = ethEligible.slice(0, MAX_COLLECT_ALL_BATCH)
        const remaining = MAX_COLLECT_ALL_BATCH - ethBatch.length
        const usdcBatch = remaining > 0 ? usdcEligible.slice(0, remaining) : []

        if (ethBatch.length === 0 && usdcBatch.length === 0) {
          setStatus('idle')
          toast.error(
            'Nothing to collect right now — sales may have ended, sold out, or you already own them',
            { id: TOAST_ID },
          )
          return null
        }

        const segments: CallSegment[] = []

        // ─── ETH leg ─────────────────────────────────────────────────────
        if (ethBatch.length > 0) {
          // Mint fee changes occasionally; read once per submit.
          const mintFee = await publicClient.readContract({
            address: collectionAddress,
            abi: ZORA_1155_MINT_ABI,
            functionName: 'mintFee',
          })
          const minterArgs = encodeFixedPriceMinterArgs(address as Address, '')
          const ethCalls = ethBatch.map(
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
              }) as Hex,
          )
          const ethValue = ethBatch.reduce(
            (sum, e) => sum + mintFee + e.pricePerToken,
            0n,
          )
          segments.push({
            call: {
              to: collectionAddress,
              data: encodeFunctionData({
                abi: ZORA_MULTICALL_ABI,
                functionName: 'multicall',
                args: [ethCalls],
              }) as Hex,
              value: ethValue,
            },
            // OZ multicall is atomic — either all sub-mints succeed or the
            // whole call reverts — so the single ETH segment carries every
            // ETH record. The receipt's status applies to the whole group.
            records: ethBatch.map((e) => ({
              tokenId: e.tokenId.toString(),
              pricePerToken: e.pricePerToken,
              currency: 'eth' as const,
            })),
          })
        }

        // ─── USDC leg ────────────────────────────────────────────────────
        if (usdcBatch.length > 0) {
          const usdcTotal = usdcBatch.reduce((sum, e) => sum + e.pricePerToken, 0n)

          // Bounded approve — exact batch total, never MaxUint256. Skip the
          // approve call entirely if existing allowance already covers it.
          const currentAllowance = await publicClient.readContract({
            address: USDC_BASE,
            abi: ERC20_ABI,
            functionName: 'allowance',
            args: [address as Address, ZORA_ERC20_MINTER],
          })
          if (currentAllowance < usdcTotal) {
            segments.push({
              call: {
                to: USDC_BASE,
                data: encodeFunctionData({
                  abi: ERC20_ABI,
                  functionName: 'approve',
                  args: [ZORA_ERC20_MINTER, usdcTotal],
                }) as Hex,
              },
              // Approve is a setup call, not a mint. No records to attribute.
              records: [],
            })
          }

          for (const e of usdcBatch) {
            segments.push({
              call: {
                to: ZORA_ERC20_MINTER,
                data: encodeFunctionData({
                  abi: ZORA_ERC20_MINTER_ABI,
                  functionName: 'mint',
                  args: [
                    address as Address,
                    1n,
                    collectionAddress,
                    e.tokenId,
                    e.pricePerToken,
                    USDC_BASE,
                    KISMET_REFERRAL,
                    '',
                  ],
                }) as Hex,
              },
              records: [{
                tokenId: e.tokenId.toString(),
                pricePerToken: e.pricePerToken,
                currency: 'usdc' as const,
              }],
            })
          }
        }

        const calls = segments.map((s) => s.call)
        const totalMints = ethBatch.length + usdcBatch.length

        setStatus('minting')
        toast.loading(`Confirm in wallet — collecting ${totalMints}…`, {
          id: TOAST_ID,
        })

        // experimental_fallback lets non-EIP-5792 wallets receive the calls
        // as sequential eth_sendTransaction prompts, preserving the same
        // user-facing flow on legacy wallets.
        const { id } = await sendCallsAsync({
          calls,
          chainId: base.id,
          experimental_fallback: true,
        })

        setStatus('confirming')
        toast.loading('Confirming on-chain…', { id: TOAST_ID })

        // throwOnFailure: false so we can inspect per-receipt status —
        // sequential-fallback bundles can have some sub-txs revert while
        // others succeed, and we want to record the survivors.
        const result = await waitForCallsStatus(config, {
          id,
          throwOnFailure: false,
          // Bundles with ≥3 sequential txs on slow wallets can exceed the
          // default 60s. 5 minutes covers worst-case fallback paths.
          timeout: 300_000,
        })

        // Walk segments[] against result.receipts[] to attribute success
        // back to specific records. Two shapes to handle:
        //   • Atomic mode: receipts.length === 1 — that single receipt's
        //     status applies to every record in every segment.
        //   • Sequential / per-call mode: receipts.length === segments.length
        //     — each segment gets its own receipt and is recorded only if
        //     its receipt succeeded.
        // If receipts is missing or sized unexpectedly, treat as a total
        // failure rather than guessing — better to under-record than to
        // poison trending with phantom mints.
        const receipts = result.receipts ?? []
        type Recorded = { entry: RecordEntry; txHash: Hex }
        const recorded: Recorded[] = []
        if (receipts.length === 1 && receipts[0].status === 'success') {
          for (const seg of segments) {
            for (const entry of seg.records) {
              recorded.push({ entry, txHash: receipts[0].transactionHash })
            }
          }
        } else if (receipts.length === segments.length) {
          for (let i = 0; i < segments.length; i++) {
            if (receipts[i].status !== 'success') continue
            for (const entry of segments[i].records) {
              recorded.push({ entry, txHash: receipts[i].transactionHash })
            }
          }
        }

        if (recorded.length === 0) {
          throw new Error(
            result.status === 'failure'
              ? 'Bundle reverted on-chain'
              : `Bundle ${result.status ?? 'failed'}`,
          )
        }

        // Best-effort post-mint hooks: trending score, collected list,
        // creator notification. Each entry uses ITS OWN tx hash so the
        // recording endpoint can de-dup correctly even in fallback mode.
        setStatus('recording')
        await Promise.all(
          recorded.map(({ entry, txHash }) =>
            fetch('/api/collect', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                moment: {
                  collectionAddress,
                  tokenId: entry.tokenId,
                  chainId: base.id,
                },
                account: address,
                amount: 1,
                comment: '',
                pricePerToken: entry.pricePerToken.toString(),
                currency: entry.currency,
                txHash,
              }),
            }).catch(() => {}),
          ),
        )

        setStatus('done')
        if (recorded.length === totalMints) {
          toast.success(
            `Collected ${totalMints} moment${totalMints === 1 ? '' : 's'}!`,
            { id: TOAST_ID },
          )
        } else {
          // Partial — common in sequential-fallback mode when a later
          // sub-tx reverts (sale ended mid-bundle, slippage, etc.). Be
          // explicit so the user knows their wallet history is correct.
          toast.warning(
            `Collected ${recorded.length} of ${totalMints} — see your wallet for the rest`,
            { id: TOAST_ID },
          )
        }
        return { minted: recorded.length }
      } catch (err) {
        setStatus('error')
        toastError('Collect all', err, { id: TOAST_ID })
        return null
      } finally {
        inFlightRef.current = false
      }
    },
    [address, config, publicClient, sendCallsAsync, ensureBase],
  )

  return { collectAll, status }
}
