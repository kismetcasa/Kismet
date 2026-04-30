import { formatEther } from 'viem'

export const INPROCESS_API = 'https://api.inprocess.world/api'

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

export interface TimelineResponse {
  moments: Moment[]
  pagination: { page: number; limit: number; total_pages: number }
  status: string
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

export interface CreateMomentResponse {
  contractAddress: string
  tokenId: string
  hash: string
  chainId: number
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

export interface CollectResponse {
  hash: string
  chainId: number
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
  saleConfig: {
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

/** Format wei price to a human-readable ETH string (BigInt-safe via viem) */
export function formatPrice(pricePerToken: string): string {
  const wei = BigInt(pricePerToken)
  if (wei === 0n) return 'free'
  const eth = formatEther(wei)
  // Trim trailing zeros: "0.100000…" → "0.1"
  const trimmed = eth.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return `${trimmed} ETH`
}

/** Shorten an Ethereum address for display */
export function shortAddress(address: string): string {
  if (!address) return ''
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}
