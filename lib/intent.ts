import { keccak256, toBytes } from 'viem'

/**
 * Intent message format for per-action authorization, using EIP-712 typed
 * data. Pure functions only — safe to import on both client (signTypedData)
 * and server (verifyTypedData) without pulling in redis/viem-server deps.
 *
 * Why EIP-712 instead of personal_sign over a string:
 *   - Newline / control-char injection in any binding value is structurally
 *     impossible (each field is its own typed slot, not concatenated into a
 *     single text blob).
 *   - The domain separator binds the signature to the Kismet+Base chain
 *     combination — a signature obtained on a phishing site claiming to be
 *     Kismet can be detected by wallets that surface the typed-data domain.
 *   - Wallet UIs render typed data as a labeled table; harder to overlook
 *     a tampered field than scanning a free-form text message.
 *
 * Server-side verification lives in lib/intentAuth.ts.
 */

export type IntentAction = 'mint' | 'write'

export interface IntentEnvelope {
  /** Hex-encoded 0x-prefixed signature returned by signTypedData / EIP-1271. */
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
  /**
   * MintForm's "Enable raffle" toggle. Consumed server-side in the post-mint
   * hooks (lib/mint-proxy enables the raffle beside setMomentMeta) and stripped
   * before the upstream forward. Deliberately NOT part of the signed intent
   * slots: the intent already authenticates the minter, and enabling a raffle
   * on one's own mint is an action the creator is independently authorized to
   * take (and reverse) at any time via /api/raffle/manage.
   */
  enableRaffle?: unknown
}

/**
 * EIP-712 domain. The chainId binds to Base mainnet — a signature
 * obtained for our domain cannot be replayed on any other chain because
 * wallets compute a different domain separator per chainId. `name` and
 * `version` are surfaced to wallet UIs that render the typed-data domain.
 */
export const KISMET_INTENT_DOMAIN = {
  name: 'Kismet',
  version: '1',
  chainId: 8453,
} as const

/**
 * Type schema for a mint/write intent. Every economically-relevant field
 * is its own slot; the wallet renders these as a labeled table. Using
 * `string` for numeric fields (salePrice, saleStart, etc.) sidesteps
 * BigInt serialization quirks across wallets and keeps the type schema
 * stable across optional/missing values (empty string is a valid string).
 */
export const MINT_INTENT_TYPES = {
  MintIntent: [
    { name: 'action', type: 'string' },
    { name: 'account', type: 'address' },
    { name: 'collection', type: 'string' },
    { name: 'tokenURI', type: 'string' },
    { name: 'tokenContentHash', type: 'string' },
    { name: 'maxSupply', type: 'string' },
    { name: 'mintToCreatorCount', type: 'string' },
    { name: 'saleType', type: 'string' },
    { name: 'salePrice', type: 'string' },
    { name: 'saleCurrency', type: 'string' },
    { name: 'saleStart', type: 'string' },
    { name: 'saleEnd', type: 'string' },
    { name: 'payoutRecipient', type: 'string' },
    { name: 'splitsHash', type: 'string' },
    { name: 'nonce', type: 'string' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const

interface MintIntentMessage {
  action: IntentAction
  account: `0x${string}`
  collection: string
  tokenURI: string
  tokenContentHash: string
  maxSupply: string
  mintToCreatorCount: string
  saleType: string
  salePrice: string
  saleCurrency: string
  saleStart: string
  saleEnd: string
  payoutRecipient: string
  splitsHash: string
  nonce: string
  expiresAt: bigint
}

/**
 * Canonical hash of the splits array. Lowercased, sorted by address,
 * joined as "addr:pct|addr:pct|...". Deterministic across client + server.
 * Empty string when no splits — both sides produce the same empty value
 * so they hash the same way.
 */
function hashSplits(splits: unknown): string {
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
 * Reduce the mint/write body to a canonical EIP-712 message. Both client
 * and server call this with the same body — any economically-relevant
 * field tampering between the signer and the server produces a different
 * message and the signature fails to verify.
 *
 * Bound: account, collection (resolved to address or new-deploy form),
 * tokenURI, tokenContent hash (so the writing body is bound by content
 * not just title), maxSupply, mintToCreatorCount (so a tamperer can't
 * inflate it to mint extra unwanted copies / blow past maxSupply), the
 * full sales config (type + price + currency + window — type binding
 * blocks a swap from erc20Mint to fixedPrice that would reinterpret
 * the price as ETH instead of USDC), payoutRecipient, splits hash
 * (canonical-sorted), nonce, expiresAt.
 *
 * Not bound: display name / title / comment. createReferral is
 * server-overwritten by mint-proxy regardless of body.
 */
export function buildMintIntent(
  body: MintBody,
  action: IntentAction,
  nonce: string,
  expiresAt: number,
): MintIntentMessage {
  const contract = (body.contract ?? {}) as { address?: unknown; name?: unknown; uri?: unknown }
  const token = (body.token ?? {}) as {
    tokenMetadataURI?: unknown
    tokenContent?: unknown
    maxSupply?: unknown
    mintToCreatorCount?: unknown
    salesConfig?: { type?: unknown; pricePerToken?: unknown; currency?: unknown; saleStart?: unknown; saleEnd?: unknown } | unknown
    payoutRecipient?: unknown
  }
  const salesConfig = (token.salesConfig ?? {}) as {
    type?: unknown
    pricePerToken?: unknown
    currency?: unknown
    saleStart?: unknown
    saleEnd?: unknown
  }

  const collection =
    typeof contract.address === 'string' && contract.address.length > 0
      ? contract.address.toLowerCase()
      : `new:${asString(contract.name)}:${asString(contract.uri)}`

  const tokenContent = asString(token.tokenContent)
  const tokenContentHash = tokenContent ? keccak256(toBytes(tokenContent)) : ''

  return {
    action,
    account: asString(body.account).toLowerCase() as `0x${string}`,
    collection,
    tokenURI: asString(token.tokenMetadataURI),
    tokenContentHash,
    maxSupply: asString(token.maxSupply),
    mintToCreatorCount: asString(token.mintToCreatorCount),
    saleType: asString(salesConfig.type),
    salePrice: asString(salesConfig.pricePerToken),
    saleCurrency: asString(salesConfig.currency),
    saleStart: asString(salesConfig.saleStart),
    saleEnd: asString(salesConfig.saleEnd),
    payoutRecipient: asString(token.payoutRecipient).toLowerCase(),
    splitsHash: hashSplits(body.splits),
    nonce,
    expiresAt: BigInt(expiresAt),
  }
}
