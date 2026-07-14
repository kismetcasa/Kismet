/**
 * Pure, network-free builders for the agent "mint" (create a new moment) verb.
 *
 * The MCP mint deliberately reuses the EXACT app mint path — the same
 * `MintIntent` EIP-712 (lib/intent), the same `/api/mint` (media) or `/api/write`
 * (text) sponsored execution, the same salesConfig / metadata / CREATE_REFERRAL
 * shape MintForm posts — so there is zero drift between "mint in the app" and
 * "mint from your AI assistant", and the MCP path inherits every gate/quota/
 * sponsorship control the app mint already enforces. The ONLY thing that differs
 * (and only because a server can't stream to Turbo like a browser can) is media
 * ingestion, which lives in the route + lib/arweave/uploadMedia, not here.
 *
 * Everything in this file is a pure function of its inputs (chain-free,
 * network-free) so it's exhaustively unit-testable — see the agent verify suite.
 */

import { CREATE_REFERRAL } from '@/lib/config'
import { USDC_BASE, OPEN_EDITION_MINT_SIZE } from '@/lib/zoraMint'
import { priceToBaseUnits } from './list'
import { buildMintIntent, KISMET_INTENT_DOMAIN, MINT_INTENT_TYPES, type MintBody } from '@/lib/intent'
import type { AgentActionEnvelope } from './types'

/** saleEnd sentinel = "never" (max uint64), matching MintForm's OPEN_ENDED_SALE. */
const OPEN_ENDED_SALE = OPEN_EDITION_MINT_SIZE.toString()

export type MintMediaKind = 'image' | 'video' | 'text'

export interface MomentMetadata {
  name: string
  description: string
  image?: string
  animation_url?: string
  content?: { uri: string; mime: string }
}

/**
 * Token metadata JSON (Zora/OpenSea convention), byte-for-byte the shape
 * MintForm uploads:
 *  - image  → { image }
 *  - video  → { image?(poster), animation_url, content:{uri,mime} }
 *  - text   → { image?(cover) }  (the words live in tokenContent, not here)
 * A video with no poster omits `image` (feeds fall back to the play placeholder)
 * — the poster/thumbhash/transcode enrichments are browser-canvas-only and are
 * intentionally not reproduced server-side (see file header).
 */
export function buildMomentMetadata(input: {
  name: string
  description: string
  kind: MintMediaKind
  /** image kind → the image URI; video kind → the video URI; text kind → unused. */
  mediaUri?: string
  /** video kind → optional poster still shown in feeds. */
  posterUri?: string
  /** video kind → mime for the `content` hint (defaults video/mp4). */
  mime?: string
  /** text kind → optional cover image. */
  coverUri?: string
}): MomentMetadata {
  const { name, description, kind } = input
  if (kind === 'video') {
    return {
      name,
      description,
      ...(input.posterUri ? { image: input.posterUri } : {}),
      ...(input.mediaUri
        ? { animation_url: input.mediaUri, content: { uri: input.mediaUri, mime: input.mime ?? 'video/mp4' } }
        : {}),
    }
  }
  if (kind === 'text') {
    return { name, description, ...(input.coverUri ? { image: input.coverUri } : {}) }
  }
  return { name, description, ...(input.mediaUri ? { image: input.mediaUri } : {}) }
}

export interface MintParams {
  account: `0x${string}`
  kind: MintMediaKind
  /** The uploaded token metadata URI (ar://…), from buildMomentMetadata → upload. */
  tokenMetadataURI: string
  /** text kind only: the writing body. */
  tokenContent?: string
  name: string
  /** Human decimal price ("0" = free). */
  price: string
  currency: 'eth' | 'usdc'
  /** maxSupply; undefined / 0 = open edition. */
  editions?: number
  /** Mint one copy to the creator now (true) vs none / scheduled (false). */
  artistMint: boolean
  /** Existing collection address; omit BOTH this and collectionUri to require
   *  auto-deploy (the caller must then supply collectionName + collectionUri). */
  collection?: string
  collectionName?: string
  collectionUri?: string
  payoutRecipient?: `0x${string}`
  splits?: unknown
}

/**
 * The exact `/api/mint` (or `/api/write`) request body MintForm posts. The
 * server rebuilds the intent from THIS body and verifies the signature against
 * it, so anything economically-relevant here is signature-bound.
 */
export function buildMintBody(p: MintParams): MintBody & { name: string } {
  const priceBase = priceToBaseUnits(p.price, p.currency).toString()
  const salesConfig =
    p.currency === 'usdc'
      ? { type: 'erc20Mint' as const, pricePerToken: priceBase, saleStart: '0', saleEnd: OPEN_ENDED_SALE, currency: USDC_BASE }
      : { type: 'fixedPrice' as const, pricePerToken: priceBase, saleStart: '0', saleEnd: OPEN_ENDED_SALE }

  const contract =
    p.collection && p.collection.length > 0
      ? { address: p.collection }
      : { name: p.collectionName ?? p.name, uri: p.collectionUri ?? '' }

  const token: Record<string, unknown> = {
    tokenMetadataURI: p.tokenMetadataURI,
    // Server-overwritten by mint-proxy regardless, but included for parity with
    // the app payload (and so the signed body matches what the app would sign).
    createReferral: CREATE_REFERRAL,
    salesConfig,
    mintToCreatorCount: p.artistMint ? 1 : 0,
    ...(p.editions && p.editions > 0 ? { maxSupply: p.editions } : {}),
    ...(p.tokenContent ? { tokenContent: p.tokenContent } : {}),
    // payoutRecipient only when there are no splits (splits own the payout).
    ...(p.splits ? {} : { payoutRecipient: p.payoutRecipient ?? p.account }),
  }

  return {
    contract,
    token,
    account: p.account,
    name: p.name,
    ...(p.splits ? { splits: p.splits } : {}),
  }
}

/**
 * The full agent envelope: the EIP-712 `MintIntent` to `sign`, plus the record
 * hint the assistant POSTs after signing. Text moments record to `/api/write`
 * (action 'write'); media moments to `/api/mint` (action 'mint').
 */
export function buildMintEnvelope(p: MintParams, nonce: string, expiresAt: number): AgentActionEnvelope {
  const body = buildMintBody(p)
  const action = p.kind === 'text' ? 'write' : 'mint'
  const message = buildMintIntent(body as MintBody, action, nonce, expiresAt)

  const typedData = {
    domain: KISMET_INTENT_DOMAIN,
    types: MINT_INTENT_TYPES,
    primaryType: 'MintIntent' as const,
    // expiresAt is uint256 → serialize the bigint as a string for JSON/`sign`.
    message: { ...message, expiresAt: message.expiresAt.toString() },
  }

  const editionsLabel = p.editions && p.editions > 0 ? `${p.editions} edition${p.editions === 1 ? '' : 's'}` : 'open edition'
  const priceLabel = Number(p.price) > 0 ? `${p.price} ${p.currency.toUpperCase()}` : 'free'

  return {
    chain: 'base',
    action: 'mint',
    typedData,
    summary: `Mint "${p.name}" — ${priceLabel}, ${editionsLabel}${p.collection ? '' : ' (new collection)'}`,
    record: {
      method: 'POST',
      url: action === 'write' ? '/api/write' : '/api/mint',
      bodyTemplate: { ...body, intent: { signature: '<REPLACE_WITH_sign_signature>', nonce, expiresAt } },
    },
  }
}
