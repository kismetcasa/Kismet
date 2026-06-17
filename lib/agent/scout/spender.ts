/**
 * Scout spender (Phase 2, autonomous) — the on-chain identity that holds the
 * user's bounded Spend Permission `spender` role and submits spend()+mint
 * server-side, with NO per-collect approval (that's the whole point of a Spend
 * Permission). Bounded by the on-chain allowance + the engine policy; revocable.
 *
 * Two implementations behind one seam (see AGENT_SCOUT_MODE_B_DESIGN.md):
 *   - cdpSpender  — CANONICAL: a CDP Server Wallet smart account. Gasless via a
 *     CDP paymaster, atomic `sendUserOperation` (spend+approve+mint in one user
 *     op, so funds never rest in the spender), policy controls. Requires CDP creds.
 *   - ownKeySpender — LEAN fallback: a plain EOA (viem). Sequential txs (an EOA
 *     can't batch), pays its own gas; a brief window where pulled funds rest in
 *     the EOA between spend and mint.
 */

import { createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { redis } from '@/lib/redis'
import { serverBaseClient } from '@/lib/rpc'

/** One call the spender submits. `value` is wei (bigint) — the spend()/mint
 *  calldata is built upstream; this is the on-chain submission shape. */
export interface SpenderCall {
  to: Address
  data: Hex
  value: bigint
}

export interface ScoutSpender {
  /** The Spend Permission's `spender` address (msg.sender of spend()+mint). */
  readonly address: Address
  /** True when calls land in ONE atomic transaction (spend+mint together, so a
   *  revert rolls back everything). Lets the executor safely mint multiple
   *  editions of a drop in one collect; a non-atomic spender must not, since a
   *  mint revert after spend() would strand the pulled funds. */
  readonly atomic: boolean
  /** Submit the ordered calls; resolves to the tx hash carrying the mint (the
   *  TransferSingle `/api/collect` verifies). Atomic when the impl supports it. */
  sendCalls(calls: readonly SpenderCall[]): Promise<{ txHash: Hex }>
}

/**
 * Lean self-hosted spender: a plain EOA (its key in SCOUT_SPENDER_PRIVATE_KEY).
 * An EOA can't batch, so calls run SEQUENTIALLY, each awaited to a receipt so
 * spend() lands before the mint pulls the funds. The mint is last, so its hash
 * is returned. Trade-off vs the CDP smart account: pays its own gas and leaves a
 * brief custody window between spend and mint.
 */
export function ownKeySpender(privateKey: Hex): ScoutSpender {
  const account = privateKeyToAccount(privateKey)
  const wallet = createWalletClient({
    account,
    chain: base,
    transport: http(process.env.BASE_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL),
  })
  const pub = serverBaseClient()
  return {
    address: account.address,
    atomic: false, // sequential eth_sendTransaction — one edition per run
    async sendCalls(calls) {
      if (calls.length === 0) throw new Error('No calls to submit')
      let txHash: Hex = '0x'
      for (const c of calls) {
        txHash = await wallet.sendTransaction({ to: c.to, data: c.data, value: c.value })
        // waitForTransactionReceipt does NOT throw on a reverted tx — check the
        // status, or a reverted mint (e.g. sold out mid-run) would be counted as a
        // successful collect (after spend() already moved funds). Throw so the run
        // loop skips it. (The sequential EOA can still strand the spent funds on a
        // late revert — the atomic CDP spender closes that window; see the design.)
        const receipt = await pub.waitForTransactionReceipt({ hash: txHash })
        if (receipt.status !== 'success') throw new Error(`Call reverted on-chain (${txHash})`)
      }
      return { txHash }
    },
  }
}

/**
 * Canonical spender (recommended): a CDP Server Wallet smart account — gasless
 * via an ERC-7677 paymaster, ATOMIC `sendUserOperation` (spend + approve + mint
 * in one user op, so pulled funds never rest in the spender), TEE-secured keys.
 * Submits the SAME composed spend()+mint calls the EOA path builds
 * (composeScoutCollect), so serverExecutor is unchanged — only the on-chain
 * submission differs (one sponsored user op vs. sequential EOA txs).
 *
 * Config (server env; the SDK also reads the three CDP_* secrets from env on its
 * own): CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET to authenticate;
 * CDP_PAYMASTER_URL to sponsor gas (omit → the smart account pays its own gas
 * from its ETH balance); CDP_SCOUT_OWNER_NAME / CDP_SCOUT_ACCOUNT_NAME name the
 * deterministic owner + smart account (stable address across restarts).
 *
 * The @coinbase/cdp-sdk import is dynamic so the heavy SDK stays out of the
 * bundle graph until a CDP spender is actually resolved (mirrors grantBudget's
 * lazy @base-org import). Typechecked against the installed SDK (1.51.0); a live
 * Base-mainnet smoke (real creds + one sponsored op) is the remaining gate.
 */
export async function cdpSpender(): Promise<ScoutSpender> {
  const apiKeyId = process.env.CDP_API_KEY_ID
  const apiKeySecret = process.env.CDP_API_KEY_SECRET
  const walletSecret = process.env.CDP_WALLET_SECRET
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error(
      'CDP spender not configured — set CDP_API_KEY_ID + CDP_API_KEY_SECRET + CDP_WALLET_SECRET (and CDP_PAYMASTER_URL for gasless), or set SCOUT_SPENDER_PRIVATE_KEY for the self-hosted EOA fallback.',
    )
  }

  const { CdpClient } = await import('@coinbase/cdp-sdk')
  const cdp = new CdpClient({ apiKeyId, apiKeySecret, walletSecret })

  // Deterministic owner + smart account (resolved by name → stable address).
  const owner = await cdp.evm.getOrCreateAccount({
    name: process.env.CDP_SCOUT_OWNER_NAME || 'kismet-scout-owner',
  })
  const smartAccount = await cdp.evm.getOrCreateSmartAccount({
    name: process.env.CDP_SCOUT_ACCOUNT_NAME || 'kismet-scout-spender',
    owner,
  })
  const address = smartAccount.address as Address

  // The address users grant the Spend Permission to MUST be this spender, or
  // every spend() would target a permission this account can't draw on. Fail
  // fast on a misconfig rather than silently no-op every autonomous collect.
  const configured = process.env.NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS
  if (configured && configured.toLowerCase() !== address.toLowerCase()) {
    throw new Error(
      `CDP smart account (${address}) does not match NEXT_PUBLIC_SCOUT_SPENDER_ADDRESS (${configured}); point the public spender at the CDP account address.`,
    )
  }

  const paymasterUrl = process.env.CDP_PAYMASTER_URL || undefined

  return {
    address,
    atomic: true, // one sendUserOperation — spend+mint land together
    async sendCalls(calls) {
      if (calls.length === 0) throw new Error('No calls to submit')
      // ONE atomic user op carries the whole spend()+approve+mint sequence, so
      // pulled funds never rest in the spender. Gas-sponsored when a paymaster
      // URL is set; otherwise the smart account pays from its own ETH.
      //
      // The SDK resolves paymaster sponsorship inside this call (prepareUserOperation),
      // which is also where the userOpHash is created — so a sponsorship-denied /
      // exhausted failure throws HERE, before any hash exists (distinct from an
      // on-chain revert, which surfaces in the wait below WITH a hash). With a
      // paymaster set the spender holds no ETH, so sponsorship loss hard-fails every
      // collect; label it so that class is unambiguous in the logs.
      let userOpHash: Hex
      try {
        const sent = await smartAccount.sendUserOperation({
          calls: calls.map((c) => ({ to: c.to, value: c.value, data: c.data })),
          network: 'base',
          ...(paymasterUrl ? { paymasterUrl } : {}),
        })
        userOpHash = sent.userOpHash as Hex
      } catch (err) {
        console.error('[scout] CDP send failed before broadcast (likely paymaster/sponsorship)', {
          spender: address,
          paymaster: !!paymasterUrl,
          err: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
      // The SDK's default wait is 30s and throws TimeoutError ("may still succeed")
      // on expiry — under Base load a slow-but-landed mint would be counted as a skip
      // (user gets the NFT, /api/collect never records it). Use the SDK's own longer
      // value (60s, its EIP-7702 default) to make timeouts rare, and on an
      // indeterminate timeout log the userOpHash so the op is traceable in the CDP
      // dashboard; the next run's on-chain balance-dedup prevents a double-collect.
      let result
      try {
        result = await smartAccount.waitForUserOperation({ userOpHash, waitOptions: { timeoutSeconds: 60 } })
      } catch (err) {
        console.error('[scout] CDP user op did not confirm in time — may still land', {
          spender: address,
          userOpHash,
          err: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
      if (result.status !== 'complete') {
        throw new Error(`CDP user operation ${userOpHash} reverted on-chain (status: ${result.status})`)
      }
      return { txHash: result.transactionHash as Hex }
    },
  }
}

/**
 * Serialize every on-chain submission from the shared spender. Both account types
 * use a SINGLE sequential nonce — CDP smart accounts explicitly require user ops
 * to be sent "sequentially, not concurrently" (concurrent → replacement-underpriced
 * failures), and one EOA has one nonce sequence. The drop coordinator and the
 * per-user run loop share ONE spender, so without this lock two drops, or a drop
 * overlapping a "Run now", would submit concurrently and silently fail. A short
 * Redis mutex keyed on the spender address makes all submitters take turns
 * (cross-instance safe). If the lock store is unreachable we proceed unserialized
 * (rare; the worst case is a caught, self-healing nonce error).
 */
// Must comfortably exceed the SLOWEST sendCalls so the mutex never expires
// mid-submit (which would defeat serialization and reintroduce nonce races). The
// worst case is the EOA path on a not-yet-registered USDC permission: 4 sequential
// txs (approveWithSignature → spend → USDC approve → mint), each awaited to a
// receipt. At ~2s Base blocks that can reach the tens of seconds on congestion, so
// 240s leaves wide margin. The CDP smart-account path is ONE atomic user-op (far
// faster) — this TTL is sized for the slow EOA fallback. It's only a crash-safety
// net; the lock is always released in finally on the happy path.
const LOCK_TTL_S = 240
const LOCK_WAIT_MS = 45_000
const LOCK_POLL_MS = 200

function serialized(spender: ScoutSpender): ScoutSpender {
  const lockKey = `kismetart:scout-spender-lock:${spender.address.toLowerCase()}`
  return {
    address: spender.address,
    atomic: spender.atomic,
    async sendCalls(calls) {
      const deadline = Date.now() + LOCK_WAIT_MS
      for (;;) {
        let acquired: unknown
        try {
          acquired = await redis.set(lockKey, '1', { nx: true, ex: LOCK_TTL_S })
        } catch {
          return spender.sendCalls(calls) // lock store down → best-effort, unserialized
        }
        if (acquired === 'OK') {
          try {
            return await spender.sendCalls(calls)
          } finally {
            try {
              await redis.del(lockKey)
            } catch {}
          }
        }
        if (Date.now() >= deadline) throw new Error('Scout spender busy — serialized submit timed out')
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS))
      }
    },
  }
}

/** Resolve the configured spender: the self-hosted EOA when
 *  SCOUT_SPENDER_PRIVATE_KEY is set, else the canonical CDP smart-account spender.
 *  Wrapped in the serializer so all callers share one nonce-safe submit queue.
 *
 *  MEMOIZED per process: the CDP path costs two API round-trips
 *  (getOrCreate{Account,SmartAccount}) and the account is deterministic by name,
 *  so re-resolving it on every drop + run is wasted work. We cache the in-flight
 *  promise (concurrent callers share one resolution) but DROP it on failure, so a
 *  transient CDP error — or creds added after boot — re-resolves next call. */
let cachedSpender: Promise<ScoutSpender> | null = null

export function getScoutSpender(): Promise<ScoutSpender> {
  if (!cachedSpender) {
    cachedSpender = (async () => {
      const pk = process.env.SCOUT_SPENDER_PRIVATE_KEY
      const spender = pk ? ownKeySpender(pk as Hex) : await cdpSpender()
      return serialized(spender)
    })()
    cachedSpender.catch(() => {
      cachedSpender = null
    })
  }
  return cachedSpender
}
