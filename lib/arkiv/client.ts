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
import { getAddress, http, isAddress, isHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

/**
 * Arkiv connection for Kismet's server (Rabdi, Arkiv's current testnet).
 *
 *   ARKIV_ACCESS_KEY          optional — an access key from
 *                             hub.arkiv.network/access-keys; empty uses the
 *                             heavily rate-limited public endpoint.
 *   ARKIV_WRITER_PRIVATE_KEY  the server wallet that writes every drop and
 *                             claim (funded with tGLM from the faucet). Its
 *                             address is the `$creator` every read filters
 *                             on. Server-only; never NEXT_PUBLIC_.
 *   ARKIV_WRITER_ADDRESS      optional — for a read-only deployment that has
 *                             no writer key; must match the writer.
 *
 * Users never sign Arkiv transactions: a Base Account is a smart contract
 * on Base, not on Arkiv's chain. They sign EIP-712 intents on Base; this
 * wallet pays the Arkiv gas and hands each entity to its user.
 */

const RPC_TIMEOUT_MS = 15_000

function accessKey(): string {
  return process.env.ARKIV_ACCESS_KEY?.trim() ?? ''
}

function writerKey(): Hex | null {
  const raw = process.env.ARKIV_WRITER_PRIVATE_KEY?.trim()
  if (!raw) return null
  const k = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
  return isHex(k) && k.length === 66 ? k : null
}

/** The address every read trusts as `$creator`. Null = Arkiv not configured. */
export function arkivWriterAddress(): Address | null {
  const key = writerKey()
  if (key) return privateKeyToAccount(key).address
  const configured = process.env.ARKIV_WRITER_ADDRESS?.trim()
  return configured && isAddress(configured) ? getAddress(configured) : null
}

export function isArkivReadable(): boolean {
  return arkivWriterAddress() !== null
}

export function isArkivWritable(): boolean {
  return writerKey() !== null
}

let _public: PublicArkivClient | null = null
export function arkivPublicClient(): PublicArkivClient {
  if (!_public) {
    _public = createPublicClient({
      chain: rabdi({ accessKey: accessKey() }),
      transport: http(undefined, { timeout: RPC_TIMEOUT_MS, retryCount: 2 }),
    }) as PublicArkivClient
  }
  return _public
}

let _wallet: WalletArkivClient | null = null
function arkivWalletClient(): WalletArkivClient {
  const key = writerKey()
  if (!key) throw new Error('ARKIV_WRITER_PRIVATE_KEY is not configured')
  if (!_wallet) {
    _wallet = createWalletClient({
      chain: rabdi({ accessKey: accessKey() }),
      transport: http(undefined, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }),
      account: privateKeyToAccount(key),
    }) as WalletArkivClient
  }
  return _wallet
}

// ── Serialized, batching writer ──────────────────────────────────────────
//
// Every entity is created by the writer and then handed to its user in the
// SAME transaction: the SDK predicts the new keys (from the writer's entity
// nonce + a salt), and a batch applies creates before ownership changes.
// A prediction is only right if nothing else creates as this writer between
// the prediction and the transaction landing, so all writes go through one
// in-process queue (Kismet runs as a single container — OPS_RUNBOOK.md). Run
// one writer key per deployment: a second process writing with the same key
// would make predictions miss, and the whole batch would revert (atomic, so
// no entity is ever handed to the wrong wallet — the claim just fails and can
// be retried).
//
// While one batch is in flight, new writes queue up and the next batch takes
// them all (up to MAX_BATCH), so a burst of claims costs a few transactions,
// not one each.

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
  const writer = wallet.account!.address
  const predicted = await arkivPublicClient().predictEntityKeys({ owner: writer, count: batch.length })

  type BatchArgs = Parameters<WalletArkivClient['executeBatch']>[0]
  const creates = batch.map((job, i) => ({
    schema: job.schema,
    values: job.values,
    expiration: job.expiration,
    flags: job.flags,
    salt: predicted[i].salt,
  })) as unknown as BatchArgs['creates']
  const ownershipChanges = batch.map((job, i) => ({
    entityKey: predicted[i].key,
    newOwner: job.newOwner,
  }))

  const { txHash, createdEntities } = await wallet.executeBatch({ creates, ownershipChanges })

  // The transaction is atomic, so a missed prediction reverts it before we
  // get here; this guards the invariant explicitly anyway.
  createdEntities.forEach((k, i) => {
    if (k.toLowerCase() !== predicted[i].key.toLowerCase()) {
      throw new Error(`Arkiv key prediction mismatch at ${i}: ${k} != ${predicted[i].key}`)
    }
  })
  return createdEntities.map((entityKey) => ({ entityKey, txHash }))
}
