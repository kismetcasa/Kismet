import { formatPrice, shortAddress } from '@/lib/inprocess'
import { PLATFORM_FEE_BPS } from '@/lib/platformFee'
import type { MintParams } from './mint'

/**
 * The one line the user reads before approving. Pure string builders shared by
 * the prepare routes so every verb names the same things the same way: the
 * item (title + token id), the money in full (price, protocol mint fee, total,
 * and for a listing what the seller actually receives), and every
 * counterparty as `name (0xshort)` — the Basename / ENS name when one resolved
 * and ALWAYS the short address next to it, so a name can never stand in for
 * the address the calldata actually carries.
 *
 * Titles come from Kismet's own moment metadata or the listing row (which the
 * seller sets), so they pass through `safeTitle`: control, zero-width and
 * bidi characters are dropped, whitespace collapsed, length capped. The
 * assistant treats the summary as data (references/safety.md); this keeps a
 * title from smuggling line breaks or invisible text into that line.
 */

const TITLE_MAX = 60

function isDropped(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x2028 && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x2066 && cp <= 0x2069) ||
    cp === 0xfeff
  )
}

/** Sanitized, length-capped title, or null when nothing readable is left. */
export function safeTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const chars = Array.from(raw).map((ch) => (isDropped(ch.codePointAt(0) ?? 0) ? ' ' : ch))
  const cleaned = Array.from(chars.join('').replace(/\s+/g, ' ').trim())
  if (cleaned.length === 0) return null
  return cleaned.length > TITLE_MAX ? `${cleaned.slice(0, TITLE_MAX - 1).join('')}…` : cleaned.join('')
}

/** `alice.base.eth (0x71Dc…7244)` when a name resolved, else the short address. */
export function nameLabel(address: string, name?: string | null): string {
  return name ? `${name} (${shortAddress(address)})` : shortAddress(address)
}

function itemLabel(title: string | null, tokenId: string): string {
  return title ? `“${title}” (token #${tokenId})` : `token #${tokenId}`
}

const USDC_APPROVAL_NOTE = ' Includes a one-time USDC approval, batched into the same approval.'

export function collectSummary(p: {
  title: string | null
  tokenId: string
  quantity: bigint
  currency: 'eth' | 'usdc'
  pricePerToken: bigint
  /** Protocol mint fee per token (ETH sales only; 0 otherwise). */
  mintFee: bigint
  /** What the wallet spends in total, in the sale currency's base units. */
  total: bigint
  recipient: string
  recipientName?: string | null
  approvalIncluded: boolean
}): string {
  const many = p.quantity > 1n
  const each = many ? ' each' : ''
  const fee = p.currency === 'eth' && p.mintFee > 0n ? ` + ${formatPrice(p.mintFee.toString(), 'eth')} mint fee${each}` : ''
  const total = many || fee ? `, ${formatPrice(p.total.toString(), p.currency)} total` : ''
  const qty = many ? ` ×${p.quantity.toString()}` : ''
  return `Collect ${itemLabel(p.title, p.tokenId)}${qty} for ${formatPrice(p.pricePerToken.toString(), p.currency)}${each}${fee}${total} → to ${nameLabel(p.recipient, p.recipientName)}.${p.approvalIncluded ? USDC_APPROVAL_NOTE : ''}`
}

export function batchCollectSummary(p: {
  count: number
  /** Already-formatted total(s), e.g. `$12 + 0.002 ETH`; empty when free. */
  totalLabel: string
  includesMintFees: boolean
  recipient: string
  recipientName?: string | null
  skipped: number
}): string {
  const fees = p.includesMintFees ? ' (incl. mint fees)' : ''
  const skipNote = p.skipped > 0 ? ` Skipped ${p.skipped} unavailable.` : ''
  return `Collect ${p.count} artwork${p.count === 1 ? '' : 's'} for ${p.totalLabel || 'free'}${fees} in one approval → to ${nameLabel(p.recipient, p.recipientName)}.${skipNote}`
}

export function buySummary(p: {
  title: string | null
  tokenId: string
  seller: string
  sellerName?: string | null
  currency: 'eth' | 'usdc'
  price: bigint
  approvalIncluded: boolean
}): string {
  return `Buy ${itemLabel(p.title, p.tokenId)} from ${nameLabel(p.seller, p.sellerName)} for ${formatPrice(p.price.toString(), p.currency)}.${p.approvalIncluded ? USDC_APPROVAL_NOTE : ''}`
}

export function listSummary(p: {
  title: string | null
  tokenId: string
  currency: 'eth' | 'usdc'
  priceTotal: bigint
  platformFee: bigint
  royaltyAmount: bigint
  sellerProceeds: bigint
  /** Listing expiry, ms epoch (the Seaport order's endTime). */
  expiresAt: number
  now: number
  needsApproval: boolean
}): string {
  const f = (v: bigint) => formatPrice(v.toString(), p.currency)
  const feePct = `${Number(PLATFORM_FEE_BPS) / 100}%`
  const royalty = p.royaltyAmount > 0n ? ` and the creator royalty (${f(p.royaltyAmount)})` : ''
  const days = Math.max(1, Math.round((p.expiresAt - p.now) / 86_400_000))
  const next = p.needsApproval
    ? ' First listing on this collection — run the one-time marketplace approval (send_calls), then sign the order.'
    : ' Sign the order to list.'
  return `List ${itemLabel(p.title, p.tokenId)} for ${f(p.priceTotal)} — you receive ${f(p.sellerProceeds)} after the ${feePct} Kismet fee (${f(p.platformFee)})${royalty}; expires in ${days} day${days === 1 ? '' : 's'}.${next}`
}

const KIND_LABEL: Record<MintParams['kind'], string> = { image: 'image', video: 'video', model: '3D model', text: 'writing' }

/** Human decimal price as entered ("0.01" ETH, "5" USDC) → `0.01 ETH` / `$5` / `free`. */
function humanPrice(price: string, currency: 'eth' | 'usdc'): string {
  if (!(Number(price) > 0)) return 'free'
  const trimmed = price.includes('.') ? price.replace(/0+$/, '').replace(/\.$/, '') : price
  return currency === 'usdc' ? `$${trimmed}` : `${trimmed} ETH`
}

export function mintSummary(
  p: Pick<
    MintParams,
    'account' | 'kind' | 'name' | 'price' | 'currency' | 'editions' | 'artistMint' | 'collection' | 'collectionName' | 'payoutRecipient' | 'splits' | 'enableRaffle'
  >,
  payoutName?: string | null,
): string {
  const editions = p.editions && p.editions > 0 ? `${p.editions} edition${p.editions === 1 ? '' : 's'}` : 'open edition'
  const into = p.collection
    ? `into collection ${shortAddress(p.collection)}`
    : `into new collection “${safeTitle(p.collectionName ?? p.name) ?? 'untitled'}”`
  const splitCount = Array.isArray(p.splits) ? p.splits.length : 0
  const payout =
    splitCount > 0
      ? `payout split across ${splitCount} recipient${splitCount === 1 ? '' : 's'}`
      : p.payoutRecipient
        ? `payout to ${nameLabel(p.payoutRecipient, payoutName)}`
        : `payout to you (${shortAddress(p.account)})`
  const extras = [p.artistMint ? '1 copy minted to you' : null, p.enableRaffle ? 'raffle on' : null].filter(Boolean)
  return `Mint “${safeTitle(p.name) ?? 'untitled'}” (${KIND_LABEL[p.kind]}) — ${humanPrice(p.price, p.currency)}, ${editions}, ${into}, ${payout}${extras.length ? `, ${extras.join(', ')}` : ''}.`
}
