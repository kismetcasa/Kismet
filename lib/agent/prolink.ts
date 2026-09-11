import { decodeProlink, encodeProlink } from '@base-org/account/prolink'
import type { Address } from 'viem'
import type { AgentCall } from './types'

/**
 * Base app "prolink" deep links for the send_calls envelopes (collect, batch
 * collect, buy).
 *
 * A prolink packs a `wallet_sendCalls` request into a base.app URL
 * (`https://base.app/base-pay?p=<payload>`, the Compressed RPC Link Format the
 * Base Account SDK ships). The user opens it and approves in the Base app —
 * the very calls the envelope hands to Base MCP's `send_calls`, minus the MCP
 * round trip. It is one-way: no txHash comes back to the assistant, so it is
 * an ALTERNATIVE approval path, and the envelope's `record` step then needs
 * the hash from the user.
 *
 * Refusal guard. The SDK's own decoder (@base-org/account 2.5.10,
 * prolink/utils/encoding.js `bytesToHex`) strips leading zero nibbles from a
 * generic call's `data`, so `0x095ea7b3…` — the ERC-20 `approve` selector —
 * decodes as `0x95ea7b3…`, different calldata. The encoder is lossless (the
 * bytes on the wire are right), but whether the Base app's decoder reproduces
 * them cannot be verified from here. So a link is issued only when the
 * reference decoder gives back every call byte-for-byte; otherwise `null` and
 * the assistant stays on `send_calls`. Today that withholds exactly the
 * batches that prepend a USDC `approve` (every other selector we emit —
 * 0x359f1302 / 0xf54f216a mint, 0xf7aee3ab fulfillOrder — round-trips).
 */
export interface AgentApproveLink {
  url: string
  note: string
}

export const BASE_APP_PROLINK_URL = 'https://base.app/base-pay'
const BASE_CHAIN_ID_HEX = '0x2105' // 8453

export const APPROVE_LINK_NOTE =
  'Alternative to send_calls: the user opens this in the Base app and approves the same calls there. Nothing comes back to you — ask the user for the transaction hash from the Base app before recording.'

/** `from` pins the sending account so the link is only approvable by the
 *  account the calls were built for (mintTo / the USDC payer). */
export async function buildApproveLink(calls: AgentCall[], from: Address): Promise<AgentApproveLink | null> {
  if (calls.length === 0) return null
  try {
    const payload = await encodeProlink({
      method: 'wallet_sendCalls',
      params: [{ version: '2.0.0', chainId: BASE_CHAIN_ID_HEX, from, calls }],
    })
    if (!(await roundTrips(payload, from, calls))) return null
    const url = new URL(BASE_APP_PROLINK_URL)
    url.searchParams.set('p', payload)
    return { url: url.toString(), note: APPROVE_LINK_NOTE }
  } catch {
    // A link is a convenience; an encoder failure must never fail the prepare.
    return null
  }
}

interface DecodedSendCalls {
  chainId?: unknown
  from?: unknown
  calls?: unknown
}

async function roundTrips(payload: string, from: Address, calls: AgentCall[]): Promise<boolean> {
  const decoded = await decodeProlink(payload)
  if (decoded.method !== 'wallet_sendCalls' || !Array.isArray(decoded.params)) return false
  const p = decoded.params[0] as DecodedSendCalls | undefined
  if (!p || typeof p.chainId !== 'string' || BigInt(p.chainId) !== 8453n) return false
  if (typeof p.from !== 'string' || p.from.toLowerCase() !== from.toLowerCase()) return false
  const decodedCalls: unknown[] | undefined = Array.isArray(p.calls) ? p.calls : undefined
  if (!decodedCalls || decodedCalls.length !== calls.length) return false
  return calls.every((c, i) => {
    const d = decodedCalls[i] as Partial<AgentCall> | undefined
    return (
      !!d &&
      typeof d.to === 'string' &&
      d.to.toLowerCase() === c.to.toLowerCase() &&
      typeof d.data === 'string' &&
      d.data.toLowerCase() === c.data.toLowerCase() &&
      typeof d.value === 'string' &&
      BigInt(d.value) === BigInt(c.value)
    )
  })
}
