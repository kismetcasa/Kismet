import { parseAbiItem, type Address, type Hex, type PublicClient } from 'viem'

// Confirms an airdrop from the chain instead of from the wallet's reply.
//
// The 2026-10 Zen + Rainbow incident: the artist approved the airdrop, it
// landed on-chain, and the page sat on "Confirm airdrop in wallet…" because
// the extension's reply never reached the tab (lib/walletPrompt has the
// mechanism). The mint itself is visible to anyone: each recipient's
// adminMint emits TransferSingle(operator = the sender, from = 0x0, to, id).
// useAirdrop races this watcher against the wallet's reply, so a lost reply
// costs a few seconds instead of the whole flow — and the airdrop is still
// recorded (notifyAirdrop needs the tx hash, which the logs carry).

export const TRANSFER_SINGLE_EVENT = parseAbiItem(
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
)

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

/** How often the chain is asked. Base makes a block every ~2 s. */
export const AIRDROP_POLL_MS = 4_000

export interface TransferSingleLike {
  transactionHash: Hex | null
  args: { operator?: Address; from?: Address; to?: Address; id?: bigint }
}

/**
 * The transaction among `logs` that minted `tokenId` from 0x0 to EVERY
 * recipient — one airdrop is one transaction (a single adminMint, or the
 * multicall of them), so a match must cover the whole list in one hash.
 * Null when none does yet.
 */
export function matchAirdropTx(
  logs: readonly TransferSingleLike[],
  want: { tokenId: bigint; recipients: readonly string[]; operator: string },
): Hex | null {
  const needed = new Set(want.recipients.map((r) => r.toLowerCase()))
  const byTx = new Map<Hex, Set<string>>()
  for (const log of logs) {
    const { operator, from, to, id } = log.args
    if (!log.transactionHash || !to || id !== want.tokenId) continue
    if (from?.toLowerCase() !== ZERO_ADDRESS) continue
    if (operator?.toLowerCase() !== want.operator.toLowerCase()) continue
    const to_ = to.toLowerCase()
    if (!needed.has(to_)) continue
    let seen = byTx.get(log.transactionHash)
    if (!seen) byTx.set(log.transactionHash, (seen = new Set()))
    seen.add(to_)
  }
  for (const [hash, seen] of byTx) if (seen.size === needed.size) return hash
  return null
}

type LogsClient = Pick<PublicClient, 'getLogs'>

/**
 * Polls for the airdrop's mint from `fromBlock` (read before the wallet was
 * asked) until it shows up, then resolves with its tx hash. Never rejects on
 * an RPC error — a flaky read just waits for the next poll — and rejects with
 * the abort reason when `signal` aborts (the wallet answered first, or
 * refused).
 */
export function watchAirdropLanded(params: {
  client: LogsClient
  collection: Address
  operator: Address
  tokenId: bigint
  recipients: readonly Address[]
  fromBlock: bigint
  signal: AbortSignal
  intervalMs?: number
}): Promise<Hex> {
  const { client, collection, operator, tokenId, recipients, fromBlock, signal } = params
  const intervalMs = params.intervalMs ?? AIRDROP_POLL_MS
  return new Promise<Hex>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onAbort = () => {
      if (timer) clearTimeout(timer)
      reject(signal.reason)
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })

    const poll = async () => {
      try {
        const logs = await client.getLogs({
          address: collection,
          event: TRANSFER_SINGLE_EVENT,
          args: { operator, from: ZERO_ADDRESS },
          fromBlock,
          toBlock: 'latest',
        })
        if (signal.aborted) return
        const hash = matchAirdropTx(logs, { tokenId, recipients, operator })
        if (hash) {
          signal.removeEventListener('abort', onAbort)
          resolve(hash)
          return
        }
      } catch {
        // A failed read is not an answer; ask again next round.
      }
      if (!signal.aborted) timer = setTimeout(poll, intervalMs)
    }
    timer = setTimeout(poll, intervalMs)
  })
}
