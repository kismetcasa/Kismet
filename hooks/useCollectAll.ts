'use client'

import { useCallback, useRef, useState } from 'react'
import {
  useAccount,
  useConfig,
  usePublicClient,
  useSendCalls,
  useWalletClient,
  useWriteContract,
} from 'wagmi'
import { getAccount, waitForCallsStatus } from '@wagmi/core'
import { base } from 'wagmi/chains'
import { toast } from 'sonner'
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { isValidTokenId } from '@/lib/address'
import { useEnsureBase } from '@/lib/useEnsureBase'
import { isUserRejection, walkError } from '@/lib/toast'
import { useWalletRecovery } from '@/hooks/useWalletRecovery'
import { fetchEligibleTokens, type EligibleToken } from '@/lib/saleConfig'
import { DEFAULT_COLLECT_COMMENT } from '@/lib/inprocess'
import {
  ERC20_ABI,
  MAX_COLLECT_ALL_BATCH,
  MULTICALL3_ADDRESS,
  USDC_BASE,
  ZORA_ERC20_MINTER,
  buildEthMintCall,
  buildMulticall3Batch,
  buildUsdcMintCall,
  readMintFeeWithBound,
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
// Scoped to "method"-related wording so we don't false-positive on
// unrelated errors like "chain is not supported".
const UNSUPPORTED_METHOD_RE = /method (?:is )?not supported|method not found|request method is not supported|unsupported (?:rpc )?method/i
const UNSUPPORTED_METHOD_NAME_RE = /MethodNotSupportedRpcError|UnsupportedNonOptionalCapability|UnsupportedProviderMethodError/i

function isUnsupportedMethodError(err: unknown): boolean {
  if (typeof err === 'string') return UNSUPPORTED_METHOD_RE.test(err)
  return walkError(err, (e) =>
    (typeof e.name === 'string' && UNSUPPORTED_METHOD_NAME_RE.test(e.name)) ||
    (typeof e.details === 'string' && UNSUPPORTED_METHOD_RE.test(e.details)) ||
    (typeof e.message === 'string' && UNSUPPORTED_METHOD_RE.test(e.message)),
  )
}

/**
 * "Collect all" — bundles every ETH- and USDC-eligible token in a collection
 * into one wallet-signed batch. Two dispatch paths, picked automatically:
 *
 *   • Pure-ETH bundle with >= 2 mints → Multicall3.aggregate3Value: ONE tx,
 *     one signature, works on ANY wallet (no EIP-5792 dependency). Each
 *     inner call gets its own partitioned msg.value, satisfying the strategy's
 *     strict equality check. allowFailure=false so any inner revert undoes
 *     the whole batch (atomic, same UX as EIP-5792 atomic mode).
 *
 *   • Everything else (USDC present, mixed currencies, or N=1) → EIP-5792
 *     wallet_sendCalls. Atomic on supporting wallets (Coinbase Smart Wallet,
 *     MetaMask post-Pectra, etc.); falls back to sequential eth_sendTransaction
 *     prompts via experimental_fallback for legacy wallets.
 *
 * Why Multicall3 only for pure-ETH: the ERC20Minter pulls funds via
 * safeTransferFrom(msg.sender, …) and msg.sender of each inner call inside
 * Multicall3 is Multicall3 itself, which holds no USDC. ETH mints don't have
 * this constraint — recipient comes from the encoded minterArguments and
 * the value is partitioned per-call by aggregate3Value.
 *
 * Why N >= 2: a single mint via Multicall3 adds gas overhead and shifts the
 * Purchased event's `sender` field to the batcher with no UX gain. For N=1
 * the existing direct mint path is simpler.
 *
 * Bundle layout (only the legs we have eligible tokens for):
 *   1. ETH mints — one 1155.mint(...) per token. Each segment carries its
 *      own value = mintFee + pricePerToken, matching the canonical formula
 *      from Zora protocol-sdk's parseMintCosts.
 *   2. USDC.approve(ERC20Minter, exactBatchTotal) — only when current
 *      allowance is below batch total. Bounded to the exact total per
 *      2024+ approval security guidance (no MaxUint256).
 *   3. USDC mints — one ERC20Minter.mint(...) per token.
 *
 * REGRESSION NOTE: do NOT route ETH mints through the 1155's inherited
 * multicall(bytes[]). It's declared `nonpayable` in Zora's on-chain ABI
 * (verified in PublicMulticall.sol) and uses OZ delegatecall which would
 * replicate msg.value across sub-calls, which FixedPriceSaleStrategy rejects
 * with WrongValueSent. Multicall3 (a separate standalone contract at
 * 0xcA11bde…6CA11) is the correct batch primitive here.
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
  const { writeContractAsync } = useWriteContract()
  const ensureBase = useEnsureBase()
  const { consumeRetryFlag, showError, ackSuccess } = useWalletRecovery(TOAST_ID, 'Collect all')
  const [status, setStatus] = useState<Status>('idle')
  // Lets the recovery flow's post-reconnect retry re-invoke the latest
  // `collectAll` closure. A ref breaks the cycle that would otherwise
  // require collectAll's own useCallback to depend on itself.
  const collectAllRef = useRef<(args: CollectAllArgs) => Promise<{ minted: number } | null>>(
    () => Promise.resolve(null),
  )
  // Synchronous re-entrance latch. setStatus is async — between the user's
  // click and React committing the disabled-button render, a double-click
  // could otherwise kick off two parallel bundles.
  const inFlightRef = useRef(false)

  const collectAll = useCallback(
    async (args: CollectAllArgs) => {
      const isRetryAfterRecovery = consumeRetryFlag()
      const { ethCandidateTokenIds, usdcCandidateTokenIds } = args

      if (!address) {
        toast.error('Connect a wallet to collect')
        return null
      }
      if (!publicClient) {
        toast.error('Network unavailable')
        return null
      }
      // Defense in depth at the trust boundary: normalize and validate the
      // collection address before any encoding uses it. The interface types
      // it as Address, but a bad `as Address` cast upstream would otherwise
      // slip through silently.
      let collectionAddress: Address
      try {
        collectionAddress = getAddress(args.collectionAddress)
      } catch {
        toast.error('Invalid collection address')
        return null
      }
      // Drop any non-decimal candidate IDs before BigInt() — a malformed
      // string from upstream would throw synchronously and abort the hook.
      const ethIds = ethCandidateTokenIds.filter(isValidTokenId)
      const usdcIds = usdcCandidateTokenIds.filter(isValidTokenId)
      if (ethIds.length === 0 && usdcIds.length === 0) {
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
          ethIds.length > 0
            ? fetchEligibleTokens(
                publicClient,
                collectionAddress,
                ethIds.map(BigInt),
                'eth',
                address,
              )
            : Promise.resolve<EligibleToken[]>([]),
          usdcIds.length > 0
            ? fetchEligibleTokens(
                publicClient,
                collectionAddress,
                usdcIds.map(BigInt),
                'usdc',
                address,
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
          // Mint fee changes occasionally; read once per submit. The helper
          // also enforces the sanity bound so we abort before encoding any
          // value-carrying call on a pathological contract.
          const mintFee = await readMintFeeWithBound(publicClient, collectionAddress)
          for (const e of ethBatch) {
            const { abi, functionName, args, value } = buildEthMintCall({
              tokenId: e.tokenId,
              mintTo: address,
              quantity: 1n,
              mintFee,
              pricePerToken: e.pricePerToken,
              comment: DEFAULT_COLLECT_COMMENT,
            })
            segments.push({
              call: {
                to: collectionAddress,
                data: encodeFunctionData({ abi, functionName, args }) as Hex,
                // Per-call value: mintFee + price. Partitioned across
                // segments so each mint sees exactly what the strategy's
                // ethValueSent equality check expects.
                value,
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
            args: [address, ZORA_ERC20_MINTER],
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
            const { abi, functionName, args } = buildUsdcMintCall({
              collection: collectionAddress,
              tokenId: e.tokenId,
              mintTo: address,
              quantity: 1n,
              pricePerToken: e.pricePerToken,
              comment: DEFAULT_COLLECT_COMMENT,
            })
            segments.push({
              call: {
                to: ZORA_ERC20_MINTER,
                data: encodeFunctionData({ abi, functionName, args }) as Hex,
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

        // Defense in depth: read fresh chain state from the wagmi store
        // right before send. ensureBase() ran at the top, but the user
        // could have switched networks during the eligibility re-check
        // window. Reading via getAccount(config) bypasses any closure
        // staleness from the hook's render-time useAccount snapshot.
        if (getAccount(config).chainId !== base.id) {
          throw new Error('Switched off Base — retry to continue')
        }

        setStatus('minting')
        toast.loading(`Confirm in wallet — collecting ${totalMints}…`, {
          id: TOAST_ID,
        })

        type Receipt = { transactionHash: Hex; status: 'success' | 'reverted' | 'failure' }
        let receipts: Receipt[] = []
        let bundleStatus: string | undefined

        // Pure-ETH fast path: route the bundle through Multicall3's
        // aggregate3Value (canonical at MULTICALL3_ADDRESS on every EVM chain
        // including Base) to get single-signature, single-tx UX on ANY wallet
        // — important for users on legacy MetaMask / Rabby / etc. that don't
        // speak EIP-5792 and would otherwise fall into the sequential
        // fallback below. allowFailure=false matches EIP-5792 atomic
        // semantics: any inner revert undoes the whole batch, so the user
        // is never partially charged.
        //
        // Restricted to pure-ETH because Multicall3 calls ERC20Minter with
        // msg.sender = Multicall3, which holds no USDC — see buildMulticall3Batch.
        // N >= 2 only because Multicall3 indirection has no benefit for a
        // single mint (current EIP-5792 already lands as one tx there).
        const useMulticall3 = ethBatch.length >= 2 && usdcBatch.length === 0
        if (useMulticall3) {
          // Errors (user reject, RPC blip, revert) propagate to the outer
          // try/catch and render via toastError, same as any other path.
          const hash = await writeContractAsync({
            chainId: base.id,
            address: MULTICALL3_ADDRESS,
            ...buildMulticall3Batch(
              segments.map((s) => ({
                to: s.call.to,
                data: s.call.data,
                // Pure-ETH fast path only fires when every segment is an
                // ETH mint, and ETH mint segments always carry `value`.
                // The non-null assertion narrows the optional type to bigint
                // without a runtime cost.
                value: s.call.value!,
              })),
            ),
          })

          setStatus('confirming')
          toast.loading('Confirming on-chain…', { id: TOAST_ID })

          const r = await publicClient.waitForTransactionReceipt({
            hash,
            timeout: 300_000,
          })
          receipts = [{
            transactionHash: hash,
            status: r.status === 'success' ? 'success' : 'reverted',
          }]
          bundleStatus = r.status === 'success' ? 'success' : 'failure'
        } else {
        // experimental_fallback lets wagmi-recognized non-EIP-5792 wallets
        // receive the calls as sequential eth_sendTransaction prompts. It
        // only triggers on viem's MethodNotSupportedRpcError though — some
        // wallets (Coinbase Wallet over WalletConnect) raise InternalRpcError
        // with "this request method is not supported" instead, which slips
        // past the predicate. Catch that case and dispatch sequentially
        // ourselves below.
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
          // allowance is in place by the time the minter is invoked). Partial
          // success is the expected shape for sequential bundles and the
          // existing attribution logic handles per-receipt failure.
          //
          // The one place we DO short-circuit is right after a setup-call
          // (USDC.approve, records.length === 0) failure: every subsequent
          // USDC mint reverts on zero allowance, so prompting for them just
          // wastes user gas and confidence. Mark them all as failed without
          // dispatching, preserving the segments[]↔receipts[] alignment the
          // attribution loop relies on.
          let setupFailureSkipRemaining = false
          for (let i = 0; i < calls.length; i++) {
            const call = calls[i]
            if (setupFailureSkipRemaining) {
              receipts.push({ transactionHash: '0x' as Hex, status: 'failure' })
              continue
            }
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
              if (r.status !== 'success' && segments[i].records.length === 0) {
                setupFailureSkipRemaining = true
              }
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
              if (segments[i].records.length === 0) {
                setupFailureSkipRemaining = true
              }
            }
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
          // Only 'failure' is a known wagmi terminal state worth surfacing
          // verbatim. Anything else (pending, success-without-receipts,
          // shape mismatch) collapses to a generic message rather than
          // leaking wagmi internals to the user.
          throw new Error(
            bundleStatus === 'failure'
              ? 'Bundle reverted on-chain'
              : 'Bundle did not complete on-chain',
          )
        }

        // Best-effort post-mint hooks: trending score, collected list,
        // creator notification. Each entry uses ITS OWN tx hash so the
        // recording endpoint can de-dup correctly even in fallback mode.
        // Failures are logged (not silenced) so support can trace dropped
        // recordings; the toast still reflects on-chain success because
        // the mint itself already landed. Both network failures (.catch)
        // and non-2xx HTTP responses (.then non-ok branch) are surfaced —
        // fetch only rejects on transport errors, so 429/403/500s would
        // otherwise be lost.
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
                comment: DEFAULT_COLLECT_COMMENT,
                pricePerToken: entry.pricePerToken.toString(),
                currency: entry.currency,
                txHash,
              }),
            })
              .then((res) => {
                if (!res.ok) {
                  console.error('[collect-all] /api/collect non-2xx', {
                    tokenId: entry.tokenId,
                    status: res.status,
                  })
                }
              })
              .catch((err) => {
                console.error('[collect-all] /api/collect failed', { tokenId: entry.tokenId, err })
              }),
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
          // sub-tx reverts (sale ended mid-bundle, etc.). On-chain mints
          // that reverted aren't charged, so reassure the user explicitly.
          const failed = totalMints - recorded.length
          toast.warning(
            `Collected ${recorded.length} of ${totalMints} — ${failed} reverted (not charged)`,
            { id: TOAST_ID },
          )
        }
        ackSuccess()
        return { minted: recorded.length }
      } catch (err) {
        setStatus('error')
        showError(err, isRetryAfterRecovery, () => {
          void collectAllRef.current(args)
        })
        return null
      } finally {
        inFlightRef.current = false
      }
    },
    [address, config, publicClient, sendCallsAsync, walletClient, writeContractAsync, ensureBase, consumeRetryFlag, showError, ackSuccess],
  )

  collectAllRef.current = collectAll

  return { collectAll, status }
}
