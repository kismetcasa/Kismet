/**
 * The GET form of a record call (app/api/agent/record), as the prepare
 * envelopes hand it to the assistant: every field already filled from the
 * prepare, the txHash placeholder left for the confirmed hash. The placeholder
 * is appended raw (not URL-encoded) so it reads exactly like the one in
 * `bodyTemplate` and a plain string replace fills it.
 */
export const TX_HASH_PLACEHOLDER = '<REPLACE_WITH_send_calls_txHash>'

export function collectRecordUrl(p: {
  collection: string
  tokenId: string
  account: string
  amount: number
  currency: 'eth' | 'usdc'
  pricePerToken: string
  comment?: string
}): string {
  const q = new URLSearchParams({
    verb: 'collect',
    collection: p.collection,
    tokenId: p.tokenId,
    account: p.account,
    amount: String(p.amount),
    currency: p.currency,
    pricePerToken: p.pricePerToken,
  })
  if (p.comment) q.set('comment', p.comment)
  return `/api/agent/record?${q.toString()}&txHash=${TX_HASH_PLACEHOLDER}`
}

export function buyRecordUrl(listingId: string): string {
  const q = new URLSearchParams({ verb: 'buy', listingId })
  return `/api/agent/record?${q.toString()}&txHash=${TX_HASH_PLACEHOLDER}`
}
