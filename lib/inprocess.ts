import { formatEther, formatUnits } from 'viem'

export const INPROCESS_API = 'https://api.inprocess.world/api'

// Default comment sent on collect when the user leaves the textarea blank.
// Used by the collect route to filter out non-meaningful comments before storing
// them on notifications. Defined here so frontend and backend share one source.
export const DEFAULT_COLLECT_COMMENT = 'collected via Kismet Art'

export interface SalesConfig {
  type: 'fixedPrice' | 'erc20Mint'
  pricePerToken: string
  saleStart: string
  saleEnd: string
  currency?: string
}

export interface MomentAdmin {
  address: string
  username?: string
  hidden: boolean
}

export interface MomentMetadataInline {
  name?: string
  description?: string
  image?: string
  animation_url?: string
  external_url?: string
  content?: { uri?: string; mime?: string }
}

// Moment object as returned by GET /api/timeline (metadata inlined)
export interface Moment {
  address: string
  token_id: string
  chain_id?: number
  protocol?: string
  id?: string
  uri: string
  creator: MomentAdmin
  admins: MomentAdmin[]
  created_at: string
  updated_at?: string
  metadata?: MomentMetadataInline
}

export interface Split {
  address: string
  percentAllocation: number
}

export interface CreateMomentPayload {
  contract: {
    address?: string
    name?: string
    uri?: string
  }
  token: {
    tokenMetadataURI: string
    createReferral: string
    salesConfig: SalesConfig
    mintToCreatorCount: number
    payoutRecipient?: string
    maxSupply?: number
  }
  splits?: Split[]
  account: string
}

export interface CollectPayload {
  moment: {
    collectionAddress: string
    tokenId: string
    chainId?: number
  }
  amount: number
  comment?: string
}

export interface MomentComment {
  sender: string
  comment: string
  timestamp: number // may be ms or seconds — normalize before use
}

/** Convert ar:// or ipfs:// URIs to fetchable HTTPS URLs */
export function resolveUri(uri: string): string {
  if (!uri) return ''
  if (uri.startsWith('ar://')) {
    return `https://arweave.net/${uri.slice(5)}`
  }
  if (uri.startsWith('ipfs://')) {
    return `https://ipfs.io/ipfs/${uri.slice(7)}`
  }
  return uri
}

export interface MomentDetail {
  uri: string
  owner: string
  maxSupply?: number
  saleConfig: {
    type?: 'fixedPrice' | 'erc20Mint'
    pricePerToken: string
    saleStart: string
    saleEnd: string
    currency?: string
  }
  momentAdmins: string[]
  metadata: {
    name?: string
    description?: string
    image?: string
    animation_url?: string
    content?: { mime?: string; uri?: string }
  }
}

/**
 * Map an inprocess saleConfig to the currency tag used by the direct-collect
 * hook. Prefers the explicit `type` field; falls back to comparing `currency`
 * against the USDC address. Returns 'eth' as a safe default for legacy
 * responses missing both fields.
 */
export function inferCollectCurrency(saleConfig: {
  type?: string
  currency?: string
}): 'eth' | 'usdc' {
  if (saleConfig.type === 'erc20Mint') return 'usdc'
  if (saleConfig.type === 'fixedPrice') return 'eth'
  // Fallback: only USDC is currently supported as an ERC20 currency.
  const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  if (saleConfig.currency && saleConfig.currency.toLowerCase() === USDC_BASE) return 'usdc'
  return 'eth'
}

/**
 * Format an on-chain price (base units) for display. ETH renders as "X ETH"
 * (18 decimals); USDC renders as "$X" (6 decimals). Currency defaults to ETH
 * for legacy callers.
 */
export function formatPrice(
  pricePerToken: string,
  currency: 'eth' | 'usdc' = 'eth',
): string {
  const value = BigInt(pricePerToken)
  if (value === 0n) return 'free'
  if (currency === 'usdc') {
    const usd = formatUnits(value, 6)
    const trimmed = usd.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    return `$${trimmed}`
  }
  const eth = formatEther(value)
  const trimmed = eth.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return `${trimmed} ETH`
}

/** Shorten an Ethereum address for display */
export function shortAddress(address: string): string {
  if (!address) return ''
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function formatRelativeTime(timestamp: number): string {
  const secs = timestamp > 1e12 ? Math.floor(timestamp / 1000) : timestamp
  const diff = Math.floor(Date.now() / 1000) - secs
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  return `${Math.floor(diff / 86400)}d`
}

/**
 * Fetch the moments inside a single collection from inprocess's timeline API.
 * Returns [] on any error (network, non-2xx, malformed JSON) so callers can
 * render an empty state cleanly. `revalidate` controls Next.js fetch caching.
 */
export async function fetchCollectionMoments(
  collectionAddress: string,
  options: { revalidate?: number; limit?: number } = {},
): Promise<Moment[]> {
  const { revalidate = 60, limit = 50 } = options
  try {
    const url = new URL(`${INPROCESS_API}/timeline`)
    url.searchParams.set('collection', collectionAddress)
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('chain_id', '8453')
    const res = await fetch(url.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate },
    })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data.moments) ? data.moments : []
  } catch {
    return []
  }
}
