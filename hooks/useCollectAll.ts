'use client'

import { useCallback, useRef, useState } from 'react'
import { useAccount, useConfig, usePublicClient, useSendCalls, useWalletClient } from 'wagmi'
import { waitForCallsStatus } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { isUserRejection, toastError } from '@/lib/toast'
import { fetchEligibleTokens, type EligibleToken } from '@/lib/saleConfig'
import {
  ERC20_ABI,
  KISMET_REFERRAL,
  MAX_COLLECT_ALL_BATCH,
  USDC_BASE,
  ZORA_1155_MINT_ABI,
  ZORA_ERC20_MINTER,
  ZORA_ERC20_MINTER_ABI,
  ZORA_FIXED_PRICE_STRATEGY,
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
// USDC.approve has no records (it's a setup call); every mint call —
// ETH or USDC — carries exactly one record.
interface CallSegment {
  call: { to: Address; data: Hex; value?: bigint }
  records: RecordEntry[]
}

interface UseCollectAllReturn {
  collectAll: (args: CollectAllArgs) => Promise<{ minted: number } | null>
  status: Status
}

// wagmi's experimental_fallback only triggers on viem's
// MethodNotSupportedRpcError. Coinbase Wallet (mobile / WalletConnect path)
// returns a generic InternalRpcError whose `details` carries "this request
// method is not supported" — same intent, wrong shape, fallback never fires.
// Walk the cause chain looking for either the canonical viem error names or
// the recognizable phrasings (scoped to "method"-related wording so we don't
// false-positive on unrelated errors like "chain is not supported").
const UNSUPPORTED_METHOD_RE = /method (?:is )?not supported|method not found|request method is not supported|unsupported (?:rpc )?method/i

function isUnsupportedMethodError(err: unknown, depth = 0): boolean {
  if (err == null || depth > 5) return false
  if (typeof err === 'string') return UNSUPPORTED_METHOD_RE.test(err)
  if (typeof err !== 'object') return false
  const e = err as { message?: unknown; name?: unknown; details?: unknown; cause?: unknown }
  if (typeof e.name === 'string' &&
      /MethodNotSupportedRpcError|UnsupportedNonOptionalCapability|UnsupportedProviderMethodError/i.test(e.name)) {
    return true
  }
  if (typeof e.details === 'string' && UNSUPPORTED_METHOD_RE.test(e.details)) return true
  if (typeof e.message === 'string' && UNSUPPORTED_METHOD_RE.test(e.message)) return true
  if (e.cause != null) return isUnsupportedMethodError(e.cause, depth + 1)
  return false
}

/**
 * "Collect all" — submits one EIP-5792 wallet_sendCalls bundle covering
 * every ETH- and USDC-eligible token in a collection. Wallets that
 * support atomic batching (Coinbase Smart Wallet, MetaMask post-Pectra,
 * etc.) confirm the entire bundle in a single signature; others fall
 * back to sequential prompts via experimental_fallback.
 *
 * Bundle layout (in order, only the legs we have eligible tokens for):
 *   1. ETH mints — one 1155.mint(...) per token. We deliberately do NOT
 *      wrap these in OZ's multicall(bytes[]): that path uses delegatecall,
 *      which replicates the outer msg.value across every sub-call instead
 *      of partitioning it (OZ advisory GHSA-7grf-83vw-6f5x). Zora's
 *      FixedPriceSaleStrategy enforces strict ethValueSent equality and
 *      reverts WrongValueSent for any N>1 bundle. The EIP-5792 bundle
 *      itself gives us the atomic-batch UX one signature would.
 *   2. USDC.approve(ERC20Minter, exactBatchTotal) — only when current
 *      allowance is below batch total. Bounded to the exact total per
 *      2024+ approval security guidance (no MaxUint256).
 *   3. USDC mints — one ERC20Minter.mint(...) per token.
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
  const { data: walletClient } = useWalletClient({ chainId: base.id })
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
            ? fetchEligibleTokens(
                publicClient,
                collectionAddress,
                ethCandidateTokenIds.map((s) => BigInt(s)),
                'eth',
                address as Address,
              )
            : Promise.resolve<EligibleToken[]>([]),
          usdcCandidateTokenIds.length > 0
            ? fetchEligibleTokens(
                publicClient,
                collectionAddress,
                usdcCandidateTokenIds.map((s) => BigInt(s)),
                'usdc',
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
          for (const e of ethBatch) {
            segments.push({
              call: {
                to: collectionAddress,
                data: encodeFunctionData({
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
                // Per-call value: mintFee + price. Partitioned across
                // segments so each mint sees exactly what the strategy's
                // ethValueSent equality check expects.
                value: mintFee + e.pricePerToken,
              },
              records: [{
                tokenId: e.tokenId.toString(),
                pricePerToken: e.pricePerToken,
                currency: 'eth' as const,
              }],
            })
          }
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

        // experimental_fallback lets wagmi-recognized non-EIP-5792 wallets
        // receive the calls as sequential eth_sendTransaction prompts. It
        // only triggers on viem's MethodNotSupportedRpcError though — some
        // wallets (Coinbase Wallet over WalletConnect) raise InternalRpcError
        // with "this request method is not supported" instead, which slips
        // past the predicate. Catch that case and dispatch sequentially
        // ourselves below.
        type Receipt = { transactionHash: Hex; status: 'success' | 'reverted' | 'failure' }
        let receipts: Receipt[] = []
        let bundleStatus: string | undefined
        try {
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
          receipts = (result.receipts ?? []).map((r) => ({
            transactionHash: r.transactionHash,
            status: r.status,
          }))
          bundleStatus = result.status
        } catch (err) {
          // User cancellations and unrelated errors keep their original
          // surface so the catch block below can render the right toast.
          if (isUserRejection(err) || !isUnsupportedMethodError(err)) throw err
          if (!walletClient) throw err

          setStatus('confirming')
          toast.loading(
            calls.length > 1
              ? `Confirm ${calls.length} prompts in wallet…`
              : 'Confirm in wallet…',
            { id: TOAST_ID },
          )

          // Sequential dispatch: one eth_sendTransaction per call, in the
          // order segments were emitted (USDC.approve before USDC mints, so
          // allowance is in place by the time the minter is invoked). We do
          // NOT abort on a revert — partial success is the expected shape
          // for sequential bundles and the existing attribution logic
          // already handles per-receipt failure.
          for (const call of calls) {
            try {
              const hash = await walletClient.sendTransaction({
                to: call.to,
                data: call.data,
                value: call.value ?? 0n,
                chain: base,
              })
              const r = await publicClient.waitForTransactionReceipt({
                hash,
                timeout: 300_000,
              })
              receipts.push({
                transactionHash: hash,
                status: r.status === 'success' ? 'success' : 'reverted',
              })
            } catch (callErr) {
              // A user rejection mid-bundle ends the run — record nothing
              // further and bubble up so the toast reflects the cancel.
              if (isUserRejection(callErr)) throw callErr
              // Anything else (RPC blip, simulated revert) is treated as a
              // failed leg; keep going so subsequent legs still get a shot.
              receipts.push({
                transactionHash: '0x' as Hex,
                status: 'failure',
              })
            }
          }
        }

        // Walk segments[] against receipts[] to attribute success back to
        // specific records. Two shapes to handle:
        //   • Atomic mode: receipts.length === 1 — that single receipt's
        //     status applies to every record in every segment.
        //   • Sequential mode (wagmi fallback or our own): receipts.length
        //     === segments.length — each segment gets its own receipt and
        //     is recorded only if its receipt succeeded.
        // If receipts is missing or sized unexpectedly, treat as a total
        // failure rather than guessing — better to under-record than to
        // poison trending with phantom mints.
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
            bundleStatus === 'failure'
              ? 'Bundle reverted on-chain'
              : bundleStatus
                ? `Bundle ${bundleStatus}`
                : 'No mints landed',
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
    [address, config, publicClient, sendCallsAsync, walletClient, ensureBase],
  )

  return { collectAll, status }
}
