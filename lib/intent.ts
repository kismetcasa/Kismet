import { keccak256, toBytes } from 'viem'

/**
 * Intent message format for per-action authorization. Pure functions only —
 * safe to import on both client (signMessage) and server (verifyMessage)
 * without pulling in redis/viem-server deps. Server-side verification
 * lives in lib/intentAuth.ts.
 *
 * The signed message binds the user's intent to specific action params so
 * an attacker who intercepts the request can't substitute different
 * economically-relevant fields (price, recipient, splits, etc.) and have
 * the signature still verify. Both client and server build the same
 * message string from the same canonical body — any mismatch fails closed.
 */

export type IntentAction = 'mint' | 'write'

export interface IntentEnvelope {
  /** Hex-encoded 0x-prefixed signature returned by personal_sign / EIP-1271. */
  signature: string
  /** Server-issued single-use nonce echoed back unchanged. */
  nonce: string
  /** Unix seconds; must equal the value signed. Server enforces a bound. */
  expiresAt: number
}

export interface MintBody {
  account?: unknown
  contract?: { address?: unknown; name?: unknown; uri?: unknown } | unknown
  token?: {
    tokenMetadataURI?: unknown
    tokenContent?: unknown
    maxSupply?: unknown
    salesConfig?: {
      pricePerToken?: unknown
      currency?: unknown
      saleStart?: unknown
      saleEnd?: unknown
    } | unknown
    payoutRecipient?: unknown
    mintToCreatorCount?: unknown
  } | unknown
  splits?: unknown
}

/**
 * Canonical hash of the splits array. Lowercased, sorted by address,
 * joined as "addr:pct|addr:pct|...". Deterministic across client + server.
 * Returns the empty string when no splits are present so the caller can
 * include a constant placeholder in the message rather than branching on
 * presence (and accidentally producing a different message shape).
 */
export function hashSplits(splits: unknown): string {
  if (!Array.isArray(splits) || splits.length === 0) return ''
  const items = splits
    .filter((s): s is { address: string; percentAllocation: number } =>
      !!s && typeof s === 'object'
        && typeof (s as { address?: unknown }).address === 'string'
        && typeof (s as { percentAllocation?: unknown }).percentAllocation === 'number',
    )
    .map((s) => ({
      address: s.address.toLowerCase(),
      pct: Math.floor(s.percentAllocation),
    }))
    .sort((a, b) => (a.address < b.address ? -1 : 1))
  const joined = items.map((s) => `${s.address}:${s.pct}`).join('|')
  return keccak256(toBytes(joined))
}

function asString(v: unknown): string {
  if (v === undefined || v === null) return ''
  return String(v)
}

/**
 * Reduce the mint/write request body to a canonical, deterministic set of
 * bindings. Both client and server call this on the same payload — any
 * mismatch surfaces as a signature failure.
 *
 * Bound fields are everything economically relevant: who, what collection,
 * what content, max supply, sale params (price + currency + window),
 * payout recipient, and the canonical splits hash. Display-only fields
 * (display name, comment) are NOT bound — they can't move funds and would
 * just bloat the wallet popup. createReferral is also NOT bound because
 * mint-proxy server-overwrites it from CREATE_REFERRAL regardless of body.
 */
export function buildMintBindings(body: MintBody): Record<string, string> {
  const contract = (body.contract ?? {}) as { address?: unknown; name?: unknown; uri?: unknown }
  const token = (body.token ?? {}) as {
    tokenMetadataURI?: unknown
    tokenContent?: unknown
    maxSupply?: unknown
    salesConfig?: { pricePerToken?: unknown; currency?: unknown; saleStart?: unknown; saleEnd?: unknown } | unknown
    payoutRecipient?: unknown
  }
  const salesConfig = (token.salesConfig ?? {}) as {
    pricePerToken?: unknown
    currency?: unknown
    saleStart?: unknown
    saleEnd?: unknown
  }

  const collection =
    typeof contract.address === 'string' && contract.address.length > 0
      ? contract.address.toLowerCase()
      : `new:${asString(contract.name)}:${asString(contract.uri)}`

  // tokenContent is potentially large (writing moment body). Hash it instead
  // of pasting the whole text into the signed message — the user sees a
  // short hash in the wallet popup but the binding still covers every byte.
  const tokenContent = asString(token.tokenContent)
  const tokenContentHash = tokenContent ? keccak256(toBytes(tokenContent)) : ''

  return {
    account: asString(body.account).toLowerCase(),
    collection,
    tokenURI: asString(token.tokenMetadataURI),
    tokenContentHash,
    maxSupply: asString(token.maxSupply),
    salePrice: asString(salesConfig.pricePerToken),
    saleCurrency: asString(salesConfig.currency),
    saleStart: asString(salesConfig.saleStart),
    saleEnd: asString(salesConfig.saleEnd),
    payoutRecipient: asString(token.payoutRecipient).toLowerCase(),
    splitsHash: hashSplits(body.splits),
  }
}

/**
 * Build the human-readable message string that the user signs. Keys are
 * sorted so client and server produce byte-identical strings. The wallet
 * popup renders this verbatim so the user can audit what they're
 * authorizing (collection, price, recipient, etc.) before tapping sign.
 */
export function buildIntentMessage(
  action: IntentAction,
  bindings: Record<string, string>,
  nonce: string,
  expiresAt: number,
): string {
  const lines: string[] = [
    `Kismet — Authorize ${action}`,
    '',
  ]
  for (const key of Object.keys(bindings).sort()) {
    lines.push(`${key}: ${bindings[key]}`)
  }
  lines.push('')
  lines.push(`Nonce: ${nonce}`)
  lines.push(`Expires: ${expiresAt}`)
  return lines.join('\n')
}
