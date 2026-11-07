import 'server-only'
import {
  createPublicClient,
  createWalletClient,
  type PublicArkivClient,
  type WalletArkivClient,
} from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import type { Schema } from '@arkiv-network/sdk/schema'
import type { CreationFlags, Expiry } from '@arkiv-network/sdk/entity'
import { formatEther, http, isHex, type Address, type Hex } from 'viem'
import { getGasPrice } from 'viem/actions'
import { privateKeyToAccount } from 'viem/accounts'
import { memoize } from '../memoCache'

/**
 * Arkiv connection for Kismet's server (Rabdi, Arkiv's current testnet).
 *
 *   ARKIV_ACCESS_KEY          an access key from hub.arkiv.network/access-keys;
 *                             empty uses the heavily rate-limited public RPC.
 *   ARKIV_WRITER_PRIVATE_KEY  the server wallet that writes every drop and
 *                             claim (funded with tGLM from the faucet). Its
 *                             address is the `$creator` every read filters
 *                             on. Server-only; never NEXT_PUBLIC_.
 *
 * Users never sign Arkiv transactions: a Base Account is a smart contract
 * on Base, not on Arkiv's chain. They sign EIP-712 intents on Base; this
 * wallet pays the Arkiv gas and hands each entity to its user.
 */

function writerKey(): Hex | null {
  const raw = process.env.ARKIV_WRITER_PRIVATE_KEY?.trim()
  if (!raw) return null
  const k = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
  return isHex(k) && k.length === 66 ? k : null
}

/** The address every read trusts as `$creator`. Null = Arkiv not configured. */
export function arkivWriterAddress(): Address | null {
  const key = writerKey()
  return key ? privateKeyToAccount(key).address : null
}

export function isArkivConfigured(): boolean {
  return writerKey() !== null
}

function chain() {
  return rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY?.trim() ?? '' })
}

let _public: PublicArkivClient | null = null
export function arkivPublicClient(): PublicArkivClient {
  if (!_public) _public = createPublicClient({ chain: chain(), transport: http() }) as PublicArkivClient
  return _public
}

let _wallet: WalletArkivClient | null = null
function arkivWalletClient(): WalletArkivClient {
  const key = writerKey()
  if (!key) throw new Error('ARKIV_WRITER_PRIVATE_KEY is not configured')
  if (!_wallet) {
    _wallet = createWalletClient({ chain: chain(), transport: http(), account: privateKeyToAccount(key) }) as WalletArkivClient
  }
  return _wallet
}

// ── Writer funds ─────────────────────────────────────────────────────────
//
// An unfunded writer fails every write with an opaque "Execution error
// without revert data" (seen on Rabdi with an empty key). So writes check the
// balance first and refuse with a clear message — and log loudly — when it
// can't cover WRITES_HEADROOM more claims at 271,151 gas each: measured on
// Rabdi for a claim and its hand-off carrying a 1 KB smart-wallet signature
// (173,158 with a 65-byte EOA one), so the bound holds for every signer.
// Read at most once a minute (memoize); a failed read fails open, since the
// write itself still fails safely.
const CLAIM_GAS = 271_151n
const WRITES_HEADROOM = 20n

const funded = memoize(async () => {
  const writer = arkivWriterAddress()
  if (!writer) return false
  const pub = arkivPublicClient()
  // The Arkiv client exposes no getGasPrice; viem's action works on any client.
  const [balance, gasPrice] = await Promise.all([pub.getBalance({ address: writer }), getGasPrice(pub)])
  const needed = CLAIM_GAS * gasPrice * WRITES_HEADROOM
  if (balance < needed) {
    console.error(
      `[drops] Arkiv writer ${writer} is low on tGLM: ${formatEther(balance)} < ${formatEther(needed)} — top it up at hub.arkiv.network/faucet`,
    )
  }
  return balance >= needed
}, 60_000)

export async function writerIsFunded(): Promise<boolean> {
  try {
    return await funded()
  } catch {
    return true
  }
}

// ── Serialized, batching writer ──────────────────────────────────────────
//
// Every entity is created by the writer and handed to its user in the SAME
// transaction: `predictEntityKeys` gives the keys the next creates will get
// (derived from the writer's entity nonce and a salt), and the node "applies
// [operations] in order, and either all of them apply or none do"
// (docs.arkiv.network/json-rpc/mutating-entities) — the SDK sends creates
// before ownership changes.
//
// "A prediction holds only while nothing else from the same account lands
// first" (docs.arkiv.network/writing/batches), so every write goes through
// this one in-process queue (Kismet runs as a single container —
// OPS_RUNBOOK.md); run one writer key per deployment. A missed prediction
// can't hand an entity to the wrong wallet: simulated on Rabdi, a hand-off of
// a key the batch didn't create reverts the whole batch with
// EntityNotFound(bytes32) — the claim just fails and can be retried.
//
// While a batch is in flight, new writes queue up and the next batch takes
// up to MAX_BATCH of them, so a burst of claims costs a few transactions.
// Measured on Rabdi: 16 claims + hand-offs with 1 KB signatures estimate at
// 3,858,802 gas, under a quarter of the 2^24 per-transaction cap.
const MAX_BATCH = 16

export interface ArkivCreateJob {
  schema: Schema
  values: Record<string, unknown>
  expiration: Expiry
  flags: CreationFlags
  /** Who the entity is handed to once created. */
  newOwner: Address
}

export interface ArkivCreateResult {
  entityKey: Hex
  txHash: Hex
}

interface QueuedJob extends ArkivCreateJob {
  resolve: (r: ArkivCreateResult) => void
  reject: (e: unknown) => void
}

const queue: QueuedJob[] = []
let pumping = false

export function createAndHandOff(job: ArkivCreateJob): Promise<ArkivCreateResult> {
  return new Promise((resolve, reject) => {
    queue.push({ ...job, resolve, reject })
    void pump()
  })
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    while (queue.length > 0) {
      const batch = queue.splice(0, MAX_BATCH)
      try {
        const results = await writeBatch(batch)
        batch.forEach((job, i) => job.resolve(results[i]))
      } catch (err) {
        batch.forEach((job) => job.reject(err))
      }
    }
  } finally {
    pumping = false
  }
}

async function writeBatch(batch: ArkivCreateJob[]): Promise<ArkivCreateResult[]> {
  const wallet = arkivWalletClient()
  const predicted = await arkivPublicClient().predictEntityKeys({ owner: wallet.account!.address, count: batch.length })

  type BatchArgs = Parameters<WalletArkivClient['executeBatch']>[0]
  const { txHash, createdEntities } = await wallet.executeBatch({
    creates: batch.map((job, i) => ({
      schema: job.schema,
      values: job.values,
      expiration: job.expiration,
      flags: job.flags,
      salt: predicted[i].salt,
    })) as unknown as BatchArgs['creates'],
    ownershipChanges: batch.map((job, i) => ({ entityKey: predicted[i].key, newOwner: job.newOwner })),
  })
  return createdEntities.map((entityKey) => ({ entityKey, txHash }))
}
