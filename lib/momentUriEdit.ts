import { encodeFunctionData, type Hex } from 'viem'
import { COLLECTION_ABI } from './collections'

// Pure core of the artwork metadata edit (the token-URI write). Kept free of
// wagmi/React so scripts/verify-metadata-edit.ts can pin it in CI.
//
// WHY THE EDIT IS A DIRECT WALLET WRITE (incident record, 2026-09).
// The editor used to relay the new URI through inprocess's PATCH /moment under
// the platform API key. Since inprocess's 2026-05-29 change that endpoint
// executes as one of the KEY OWNER's smart wallets and refuses with
// "No authorized smart wallet found for collection …" unless that wallet holds
// ADMIN at tokenId 0. That is true only for collections Kismet's Create form
// deployed with the operator grant baked into setupActions — never for a
// first-mint collection inprocess deployed, which grants ADMIN to the artist's
// EOA (defaultAdmin) and the artist's own smart wallet. Meanwhile Kismet's
// pencil and server preflight authorized the ARTIST's wallet, so the
// affordance passed and the relay failed, and no Kismet-side grant surface
// could fix it (they all grant the artist's mint wallet, not the operator).
//
// The contract's own gate is the artist's: updateTokenURI is
// onlyAdminOrRole(tokenId, METADATA) — ADMIN or METADATA on the token OR
// collection-wide — exactly the rows useMomentEditPermission reads. Signing
// from the artist's wallet makes the affordance and the write agree by
// construction and removes the relay dependency, the platform gas quota and
// the pause coupling — the same family as useUpdateMomentSale,
// useUpdateCollectionMetadata and useAirdrop. Propagation needs no relay
// either: the write emits the ERC-1155 `URI` event, which inprocess's chain
// indexer re-ingests (refetching the metadata JSON) on its cron.

/** Zora 1155 `updateTokenURI(uint256 tokenId, string _newURI)`. */
export const UPDATE_TOKEN_URI_SIGNATURE = 'updateTokenURI(uint256,string)'

/**
 * A URI we are willing to commit on-chain as a token's metadata pointer:
 * Arweave (what the editor uploads) or https. Rejects data:/blob:/javascript:
 * and anything empty or unparseable — the surface the retired server route
 * enforced, now enforced before the wallet prompt.
 */
export function isMetadataUri(uri: unknown): uri is string {
  if (typeof uri !== 'string') return false
  if (uri.startsWith('ar://')) return uri.length > 'ar://'.length && !/\s/.test(uri)
  if (uri.startsWith('https://')) return uri.length > 'https://'.length && !/\s/.test(uri)
  return false
}

/** Calldata for `updateTokenURI(tokenId, newUri)` on a Zora 1155 collection. */
export function encodeUpdateTokenUri(tokenId: bigint, newUri: string): Hex {
  return encodeFunctionData({
    abi: COLLECTION_ABI,
    functionName: 'updateTokenURI',
    args: [tokenId, newUri],
  })
}

/** The display name inside a metadata JSON, or undefined when absent / not a string. */
export function pickMetadataName(json: unknown): string | undefined {
  if (!json || typeof json !== 'object') return undefined
  const name = (json as { name?: unknown }).name
  if (typeof name !== 'string') return undefined
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
