import { decodeEventLog, parseAbi, type Hex } from 'viem'

/**
 * ERC-4337 receipt introspection. A smart-wallet transaction's top-level
 * `from` is the BUNDLER and its `to` the EntryPoint — the user's identity
 * lives in the receipt's UserOperationEvent, whose `sender` is the smart
 * account that signed the operation. The gift-fund routes use this two ways:
 * the open route derives a 4337 gift's ORGANIZER from it, and the claim
 * route's trace tier credits only value-calls made BY a userOp sender
 * (the binding that keeps Seaport conduits and other protocol contracts
 * from ever being read as backers — lib/giftFund has the rule).
 */

/** EntryPoint v0.6 and v0.7 — the two deployments live on Base. */
export const ENTRYPOINTS = new Set([
  '0x5ff137d4b0fdcd49dca30c7cf57e578a026d2789',
  '0x0000000071727de22e5e9d8baf0edac6f37da032',
])

const USER_OPERATION_EVENT_ABI = parseAbi([
  'event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)',
])

/** All UserOperationEvents in a receipt's logs, with each event's logIndex —
 *  the ordering the shared-bundle attribution rule (lib/giftFund.payerForMint)
 *  runs on. Empty for any non-4337 transaction. */
export function userOpEventsFromLogs(
  logs: readonly { address: string; data: Hex; topics: readonly Hex[]; logIndex: number }[],
): { sender: string; logIndex: number }[] {
  const out: { sender: string; logIndex: number }[] = []
  for (const log of logs) {
    if (!ENTRYPOINTS.has(log.address.toLowerCase())) continue
    try {
      const decoded = decodeEventLog({
        abi: USER_OPERATION_EVENT_ABI,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      })
      out.push({ sender: decoded.args.sender.toLowerCase(), logIndex: log.logIndex })
    } catch {
      continue
    }
  }
  return out
}

/** Just the senders (deduped by the caller if needed) — the claim route's
 *  trace-tier binding, where WHICH op sent value is answered by the trace
 *  frames themselves, not by log order. */
export function userOpSendersFromLogs(
  logs: readonly { address: string; data: Hex; topics: readonly Hex[]; logIndex: number }[],
): string[] {
  return userOpEventsFromLogs(logs).map((e) => e.sender)
}
