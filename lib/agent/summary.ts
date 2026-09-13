import { formatPrice, shortAddress } from '@/lib/inprocess'
import { PLATFORM_FEE_BPS } from '@/lib/platformFee'
import { priceToBaseUnits } from './list'
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
 * seller sets), so they pass through `safeTitle`: control, format (bidi,
 * zero-width, tag) and separator characters are dropped, the quote marks and
 * arrows the line itself uses are neutralized so a title cannot close its own
 * quotes and forge a second clause, whitespace is collapsed and the length
 * capped. A title can still say anything in words — it stays visibly inside
 * its quotes, and the money and recipient the line states come from chain
 * reads, never from the title.
 */

const TITLE_MAX = 60

// Control (Cc), format (Cf: bidi controls, zero-width, soft hyphen, the TAG
// block…) and line/paragraph separators are dropped. ZWJ (U+200D) and VS16
// (U+FE0F) are format characters emoji sequences are built from, so they stay.
const DROPPED = /(?![‍️])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
// The summary's own punctuation: a title must not be able to close the quotes
// around it or draw the "→ to" arrow.
const NEUTRALIZED: Record<string, string> = {
  '“': '’',
  '”': '’',
  '„': '’',
  '‟': '’',
  '"': '’',
  '→': '-',
  '⇒': '-',
  '➔': '-',
  '➡': '-',
}
const NEUTRALIZE_RE = /[“”„‟"→⇒➔➡]/g
const graphemes: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** Sanitized, length-capped (by grapheme) title, or null when nothing readable is left. */
export function safeTitle(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw
    .replace(DROPPED, ' ')
    .replace(NEUTRALIZE_RE, (c) => NEUTRALIZED[c])
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return null
  const units = graphemes ? Array.from(graphemes.segment(cleaned), (s) => s.segment) : Array.from(cleaned)
  return units.length > TITLE_MAX ? `${units.slice(0, TITLE_MAX - 1).join('')}…` : cleaned
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
  const priced = p.pricePerToken > 0n
  const fee = p.currency === 'eth' && p.mintFee > 0n ? ` + ${formatPrice(p.mintFee.toString(), 'eth')} mint fee${many ? ' each' : ''}` : ''
  // "each" and a total only when there is something to multiply.
  const each = many && priced ? ' each' : ''
  const total = fee || (many && priced) ? `, ${formatPrice(p.total.toString(), p.currency)} total` : ''
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

export function mintSummary(
  p: Pick<
    MintParams,
    'account' | 'kind' | 'name' | 'price' | 'currency' | 'editions' | 'artistMint' | 'collection' | 'collectionName' | 'payoutRecipient' | 'splits' | 'enableRaffle'
  >,
  payoutName?: string | null,
): string {
  // State the price that is actually SIGNED (salesConfig.pricePerToken is the
  // base-unit conversion of the decimal the caller sent), so a sub-unit decimal
  // that rounds to zero reads "free" here as it will be on chain.
  const price = formatPrice(priceToBaseUnits(p.price, p.currency).toString(), p.currency)
  const editions = p.editions && p.editions > 0 ? `${p.editions} edition${p.editions === 1 ? '' : 's'}` : 'open edition'
  const into = p.collection
    ? `into collection ${shortAddress(p.collection)}`
    : `into new collection “${safeTitle(p.collectionName ?? p.name) ?? 'untitled'}”`
  // Mirrors buildMintBody: any `splits` value means the splits own the payout.
  const splitCount = Array.isArray(p.splits) ? p.splits.length : 0
  const payout = p.splits
    ? splitCount > 0
      ? `payout split across ${splitCount} recipient${splitCount === 1 ? '' : 's'}`
      : 'payout via splits'
    : p.payoutRecipient
      ? `payout to ${nameLabel(p.payoutRecipient, payoutName)}`
      : `payout to you (${shortAddress(p.account)})`
  const extras = [p.artistMint ? '1 copy minted to you' : null, p.enableRaffle ? 'raffle on' : null].filter(Boolean)
  return `Mint “${safeTitle(p.name) ?? 'untitled'}” (${KIND_LABEL[p.kind]}) — ${price}, ${editions}, ${into}, ${payout}${extras.length ? `, ${extras.join(', ')}` : ''}.`
}
